use astro_float::{BigFloat, RoundingMode, Sign};
use wasm_bindgen::prelude::*;

const RM: RoundingMode = RoundingMode::ToEven;

/// Convert a BigFloat to f64.
///
/// astro-float's own `to_f64` is `pub(crate)` (test-only), so we replicate it
/// through the public `as_raw_parts`. The mantissa is little-endian (most
/// significant word last) and, off-x86, `Word == u64`, so the top word already
/// holds the 64 high bits we need. This is just a top-word read plus bit
/// assembly into IEEE-754 layout — cheap enough to call per orbit point.
fn bigfloat_to_f64(x: &BigFloat) -> f64 {
    let (m, _n, s, e, _inexact) = match x.as_raw_parts() {
        Some(p) => p,
        None => return f64::NAN, // Inf / NaN
    };
    if m.is_empty() {
        return 0.0;
    }
    let mantissa: u64 = m[m.len() - 1];
    if mantissa == 0 {
        return 0.0;
    }
    let neg = matches!(s, Sign::Neg);
    let mut e: i64 = e as i64 + 1023; // f64 exponent bias
    let mut ret: u64 = 0;

    if e >= 2047 {
        return if neg { f64::NEG_INFINITY } else { f64::INFINITY };
    } else if e <= 0 {
        // Subnormal / underflow.
        let shift = -e;
        if shift < 52 {
            ret |= mantissa >> (shift + 12);
            if neg {
                ret |= 0x8000_0000_0000_0000u64;
            }
            f64::from_bits(ret)
        } else {
            0.0
        }
    } else {
        let mantissa = mantissa << 1; // drop the implicit leading 1
        e -= 1;
        if neg {
            ret |= 1;
        }
        ret <<= 11;
        ret |= e as u64;
        ret <<= 52;
        ret |= mantissa >> 12;
        f64::from_bits(ret)
    }
}

/// A reference orbit X_0, X_1, ... for perturbation rendering, stored as
/// interleaved (re, im) f32 pairs. X_0 = 0, X_{n+1} = X_n^2 + C.
#[wasm_bindgen]
pub struct Reference {
    orbit: Vec<f32>,
    points: u32,
    escaped: bool,
    rebase: u32,
}

#[wasm_bindgen]
impl Reference {
    #[wasm_bindgen(getter)]
    pub fn orbit(&self) -> Vec<f32> {
        self.orbit.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn points(&self) -> u32 {
        self.points
    }

    #[wasm_bindgen(getter)]
    pub fn escaped(&self) -> bool {
        self.escaped
    }

    /// Index of the reference orbit's closest approach to the origin — the
    /// point to rebase against when a pixel's delta outgrows its full value.
    /// 0 for Mandelbrot (X_0 = 0); arbitrary for Julia.
    #[wasm_bindgen(getter)]
    pub fn rebase(&self) -> u32 {
        self.rebase
    }
}

fn complex_mul(
    ar: &BigFloat,
    ai: &BigFloat,
    br: &BigFloat,
    bi: &BigFloat,
    p: usize,
) -> (BigFloat, BigFloat) {
    let re = ar.mul(br, p, RM).sub(&ai.mul(bi, p, RM), p, RM);
    let im = ar.mul(bi, p, RM).add(&ai.mul(br, p, RM), p, RM);
    (re, im)
}

/// One multibrot reference step: (zr, zi) -> (zr + i*zi)^power + (cx + i*cy).
///
/// This is the bigfloat counterpart of `fractal_step` in the WGSL fractal
/// module — the single place the formula lives on the CPU side. power = 2 is
/// the Mandelbrot set.
fn fractal_step(
    zr: &BigFloat,
    zi: &BigFloat,
    cx: &BigFloat,
    cy: &BigFloat,
    power: u32,
    p: usize,
) -> (BigFloat, BigFloat) {
    let mut rr = BigFloat::from_f64(1.0, p);
    let mut ri = BigFloat::from_f64(0.0, p);
    for _ in 0..power {
        let (nr, ni) = complex_mul(&rr, &ri, zr, zi, p);
        rr = nr;
        ri = ni;
    }
    (rr.add(cx, p, RM), ri.add(cy, p, RM))
}

fn bf_abs(v: &BigFloat) -> BigFloat {
    if v.is_negative() {
        v.neg()
    } else {
        v.clone()
    }
}

/// One Burning Ship reference step: z -> (|Re z| + i|Im z|)^2 + c.
fn burning_ship_step(
    zr: &BigFloat,
    zi: &BigFloat,
    cx: &BigFloat,
    cy: &BigFloat,
    p: usize,
) -> (BigFloat, BigFloat) {
    let a = bf_abs(zr);
    let b = bf_abs(zi);
    let two = BigFloat::from_f64(2.0, p);
    let re = a.mul(&a, p, RM).sub(&b.mul(&b, p, RM), p, RM).add(cx, p, RM);
    let im = a.mul(&b, p, RM).mul(&two, p, RM).add(cy, p, RM);
    (re, im)
}

/// Reference-orbit formula selector (matches the active WGSL fractal module).
const FORMULA_MULTIBROT: u32 = 0;
const FORMULA_BURNING_SHIP: u32 = 1;

/// The view center, held at arbitrary precision so pan/zoom can keep
/// accumulating sub-f64 deltas indefinitely. The GPU never sees this value; it
/// only feeds the (CPU-side) reference-orbit computation and the f64 readback
/// used by the shallow tiers and the HUD.
#[wasm_bindgen]
pub struct View {
    cx: BigFloat,
    cy: BigFloat,
    prec: usize, // working precision in bits
    // Julia mode: the navigated center is the seed z0; `c` is fixed (jc_re,
    // jc_im). Mandelbrot mode (default): seed is 0 and the center IS c.
    is_julia: bool,
    jc_re: f64,
    jc_im: f64,
    power: u32,   // multibrot exponent (2 = Mandelbrot)
    formula: u32, // FORMULA_MULTIBROT | FORMULA_BURNING_SHIP
    // Center at which the last reference orbit was computed; lets the GPU reuse
    // a cached orbit while the view drifts (offset = current center - this).
    ref_cx: BigFloat,
    ref_cy: BigFloat,
    has_ref: bool,
}

#[wasm_bindgen]
impl View {
    #[wasm_bindgen(constructor)]
    pub fn new(cx: f64, cy: f64) -> View {
        let prec = 64;
        View {
            cx: BigFloat::from_f64(cx, prec),
            cy: BigFloat::from_f64(cy, prec),
            prec,
            is_julia: false,
            jc_re: 0.0,
            jc_im: 0.0,
            power: 2,
            formula: FORMULA_MULTIBROT,
            ref_cx: BigFloat::from_f64(0.0, prec),
            ref_cy: BigFloat::from_f64(0.0, prec),
            has_ref: false,
        }
    }

    /// Reset the center to f64 coordinates at base precision (e.g. when
    /// switching scenes, which also resets the zoom).
    pub fn set_center(&mut self, cx: f64, cy: f64) {
        self.prec = 64;
        self.cx = BigFloat::from_f64(cx, self.prec);
        self.cy = BigFloat::from_f64(cy, self.prec);
        self.has_ref = false;
    }

    /// Current center minus the last reference center, as f64 (small while the
    /// view hasn't drifted far). Returns (0,0) if no reference yet.
    pub fn ref_offset_re(&self) -> f64 {
        if !self.has_ref {
            return 0.0;
        }
        bigfloat_to_f64(&self.cx.sub(&self.ref_cx, self.prec, RM))
    }

    pub fn ref_offset_im(&self) -> f64 {
        if !self.has_ref {
            return 0.0;
        }
        bigfloat_to_f64(&self.cy.sub(&self.ref_cy, self.prec, RM))
    }

    /// Select Mandelbrot (is_julia=false) or a Julia set with constant (re, im).
    pub fn set_julia(&mut self, is_julia: bool, jc_re: f64, jc_im: f64) {
        self.is_julia = is_julia;
        self.jc_re = jc_re;
        self.jc_im = jc_im;
    }

    /// Set the multibrot exponent d (2 = Mandelbrot).
    pub fn set_power(&mut self, power: u32) {
        self.power = power.max(2);
    }

    /// Select the reference-orbit formula (0 = multibrot, 1 = burning ship).
    pub fn set_formula(&mut self, formula: u32) {
        self.formula = formula;
    }

    /// Grow (or shrink) working precision; the stored center is re-rounded.
    /// Call as zoom deepens so the center has room for finer deltas.
    pub fn set_precision(&mut self, bits: usize) {
        let bits = bits.max(53);
        if bits == self.prec {
            return;
        }
        let zero = BigFloat::from_f64(0.0, bits);
        self.cx = self.cx.add(&zero, bits, RM);
        self.cy = self.cy.add(&zero, bits, RM);
        self.prec = bits;
    }

    /// Translate the center by a (small) complex delta given as f64 components.
    pub fn translate(&mut self, dx: f64, dy: f64) {
        let p = self.prec;
        self.cx = self.cx.add(&BigFloat::from_f64(dx, p), p, RM);
        self.cy = self.cy.add(&BigFloat::from_f64(dy, p), p, RM);
    }

    pub fn re_f64(&self) -> f64 {
        bigfloat_to_f64(&self.cx)
    }

    pub fn im_f64(&self) -> f64 {
        bigfloat_to_f64(&self.cy)
    }

    /// Compute the reference orbit at the current center and precision.
    pub fn compute_reference(&mut self, max_iter: u32) -> Reference {
        let p = self.prec;
        // Anchor the reference at the current center so the GPU can reuse it
        // while the view drifts (see ref_offset_*).
        self.ref_cx = self.cx.clone();
        self.ref_cy = self.cy.clone();
        self.has_ref = true;
        let mut orbit = Vec::with_capacity((max_iter as usize + 1) * 2);

        // Seed and parameter depend on the mode.
        let (mut zr, mut zi, cx, cy) = if self.is_julia {
            // Dynamical space: seed = navigated center (z0), c = fixed constant.
            (
                self.cx.clone(),
                self.cy.clone(),
                BigFloat::from_f64(self.jc_re, p),
                BigFloat::from_f64(self.jc_im, p),
            )
        } else {
            // Parameter space: seed = 0 (critical point), c = navigated center.
            (
                BigFloat::from_f64(0.0, p),
                BigFloat::from_f64(0.0, p),
                self.cx.clone(),
                self.cy.clone(),
            )
        };

        // X_0, plus tracking of the closest-to-origin index for rebasing.
        let mut fr = bigfloat_to_f64(&zr);
        let mut fi = bigfloat_to_f64(&zi);
        orbit.push(fr as f32);
        orbit.push(fi as f32);
        let mut best_mag = fr * fr + fi * fi;
        let mut rebase = 0u32;

        let mut escaped = false;
        let mut n = 0u32;
        while n < max_iter {
            let (nzr, nzi) = if self.formula == FORMULA_BURNING_SHIP {
                burning_ship_step(&zr, &zi, &cx, &cy, p)
            } else {
                fractal_step(&zr, &zi, &cx, &cy, self.power, p)
            };
            zr = nzr;
            zi = nzi;
            fr = bigfloat_to_f64(&zr);
            fi = bigfloat_to_f64(&zi);
            orbit.push(fr as f32);
            orbit.push(fi as f32);
            n += 1;

            // |z|^2 in f64 (magnitude is O(1) until escape) — used for both the
            // escape test and the closest-approach search.
            let mag = fr * fr + fi * fi;
            if mag < best_mag {
                best_mag = mag;
                rebase = n;
            }
            if mag > 4.0 {
                escaped = true;
                break;
            }
        }

        let points = (orbit.len() / 2) as u32;
        Reference { orbit, points, escaped, rebase }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-12 * b.abs().max(1.0)
    }

    #[test]
    fn roundtrip_f64() {
        let p = 128;
        let vals = [
            0.0, 1.0, -1.0, 0.5, -0.5, 2.0, 3.14159, -0.7436438870371587, 1234.5678, 1e-10,
            -1e-10, 0.001953125,
        ];
        for &v in &vals {
            let bf = BigFloat::from_f64(v, p);
            let got = bigfloat_to_f64(&bf);
            assert!(approx(got, v), "v={v} got={got}");
        }
    }

    #[test]
    fn reference_matches_naive_f64() {
        // At shallow depth the bigfloat reference must match a plain f64 orbit.
        let mut view = View::new(-0.75, 0.1);
        let r = view.compute_reference(20);
        let (mut zr, mut zi) = (0.0f64, 0.0f64);
        let (cx, cy) = (-0.75f64, 0.1f64);
        for n in 1..=20usize {
            let nzr = zr * zr - zi * zi + cx;
            let nzi = 2.0 * zr * zi + cy;
            zr = nzr;
            zi = nzi;
            if (n as u32) < r.points {
                // Orbit is stored as f32, so compare at f32 precision.
                let tol = 1e-5 * zr.abs().max(zi.abs()).max(1.0);
                assert!((r.orbit[n * 2] as f64 - zr).abs() <= tol, "re n={n}");
                assert!((r.orbit[n * 2 + 1] as f64 - zi).abs() <= tol, "im n={n}");
            }
        }
    }

    #[test]
    fn cubic_multibrot_reference() {
        // power=3 reference must match a naive f64 cubic orbit z -> z^3 + c.
        let mut view = View::new(0.2, -0.1);
        view.set_power(3);
        let r = view.compute_reference(20);
        let (cx, cy) = (0.2f64, -0.1f64);
        let (mut zr, mut zi) = (0.0f64, 0.0f64);
        for n in 1..=20usize {
            // (zr + i zi)^3 = zr^3 - 3 zr zi^2 + i(3 zr^2 zi - zi^3)
            let nzr = zr * zr * zr - 3.0 * zr * zi * zi + cx;
            let nzi = 3.0 * zr * zr * zi - zi * zi * zi + cy;
            zr = nzr;
            zi = nzi;
            if (n as u32) < r.points {
                let tol = 1e-5 * zr.abs().max(zi.abs()).max(1.0);
                assert!((r.orbit[n * 2] as f64 - zr).abs() <= tol, "re n={n}");
                assert!((r.orbit[n * 2 + 1] as f64 - zi).abs() <= tol, "im n={n}");
            }
        }
    }

    #[test]
    fn burning_ship_reference() {
        // formula=1 reference must match a naive f64 Burning Ship orbit.
        let mut view = View::new(-0.5, -0.5);
        view.set_formula(1);
        let r = view.compute_reference(20);
        let (cx, cy) = (-0.5f64, -0.5f64);
        let (mut zr, mut zi) = (0.0f64, 0.0f64);
        for n in 1..=20usize {
            let a = zr.abs();
            let b = zi.abs();
            let nzr = a * a - b * b + cx;
            let nzi = 2.0 * a * b + cy;
            zr = nzr;
            zi = nzi;
            if (n as u32) < r.points {
                let tol = 1e-5 * zr.abs().max(zi.abs()).max(1.0);
                assert!((r.orbit[n * 2] as f64 - zr).abs() <= tol, "re n={n}");
                assert!((r.orbit[n * 2 + 1] as f64 - zi).abs() <= tol, "im n={n}");
            }
        }
    }
}
