import type { HpCenter, ReferenceOrbit } from "./perturbation.ts";

/** Result of preparing a reference for a frame: the orbit, the pixel-space
 * offset of the reference from the current center, and whether the orbit data
 * is new (and therefore must be re-uploaded to the GPU). */
export interface PreparedReference {
  reference: ReferenceOrbit;
  refOffset: { x: number; y: number };
  uploadOrbit: boolean;
}

/**
 * Camera over the complex plane.
 *
 * The center is owned by an arbitrary-precision `HpCenter` (in WASM); the
 * viewport holds only `scale` (complex-plane units per device pixel) and the
 * pixel dimensions. Every pan/zoom is expressed as a SMALL f64 delta fed to the
 * center — those products of well-represented numbers stay accurate even when
 * the absolute center has more digits than f64 can hold. That is what lets the
 * view keep moving past the ~1e16 f64 wall.
 */
export class Viewport {
  scale = 0; // 0 => first setSize() adopts INITIAL_SPAN
  width = 1;
  height = 1;
  /** +1: +imaginary up (default); -1: display mirrored vertically (Burning Ship). */
  ySign = 1;

  private static readonly INITIAL_SPAN = 3.5;

  // Cached reference orbit (perturbation). Reused while the view drifts only a
  // little and the zoom hasn't outgrown its iteration count / precision.
  private cache: {
    orbit: ReferenceOrbit;
    maxIter: number; // iterations the orbit was computed for
    bits: number; // precision it was computed at
  } | null = null;

  constructor(private hp: HpCenter) {}

  /** Current center as f64 (used by the shallow tiers and the HUD). */
  get center() {
    return { x: this.hp.x, y: this.hp.y };
  }

  setSize(width: number, height: number) {
    // Preserve the complex span we are currently showing across resizes.
    const span = this.scale * this.width || Viewport.INITIAL_SPAN;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.scale = span / this.width;
  }

  /** Jump to a center and complex span (e.g. when switching scenes). */
  reset(cx: number, cy: number, span: number) {
    this.hp.setCenter(cx, cy);
    this.scale = span / this.width;
    this.cache = null;
  }

  /** Select Mandelbrot vs a Julia set (affects reference seeding). */
  setJulia(isJulia: boolean, cx: number, cy: number) {
    this.hp.setJulia(isJulia, cx, cy);
    this.cache = null;
  }

  /** Set the multibrot exponent d (2 = Mandelbrot). */
  setPower(power: number) {
    this.hp.setPower(power);
    this.cache = null;
  }

  /** Select the reference-orbit formula (FORMULA_* in fractals.ts). */
  setFormula(formula: number) {
    this.hp.setFormula(formula);
    this.cache = null;
  }

  /** Mirror the display vertically (canonical Burning Ship orientation). */
  setFlipY(flip: boolean) {
    this.ySign = flip ? -1 : 1;
  }

  /** Drag the view by a device-pixel delta. */
  panByPixels(dx: number, dy: number) {
    // Complex-plane shift; small * small stays accurate in f64.
    this.hp.translate(-dx * this.scale, dy * this.scale * this.ySign);
  }

  /** Zoom by `factor` (<1 zooms in) keeping the point under (px,py) fixed. */
  zoomAt(px: number, py: number, factor: number) {
    const offX = px - this.width / 2;
    const offY = -(py - this.height / 2) * this.ySign; // screen y -> imaginary axis
    const scaleOld = this.scale;
    const scaleNew = scaleOld * factor;
    // Center shift that keeps the cursor's complex point fixed:
    //   center_new = center + offset * (scaleOld - scaleNew)
    const dScale = scaleOld - scaleNew;
    this.scale = scaleNew;
    this.hp.translate(offX * dScale, offY * dScale);
  }

  /**
   * Provide a reference orbit for this frame, reusing the cached one when the
   * view has only drifted a little and the zoom still fits its iteration count
   * and precision. Recomputing the orbit is the dominant per-frame cost at deep
   * zoom, so most frames during a pan/zoom now skip it.
   */
  prepareReference(maxIter: number): PreparedReference {
    const digits = Math.ceil(Math.log10(Math.max(2, this.zoom))) + 16;
    const neededBits = Math.ceil(digits * 3.3219) + 16;
    const screenSpan = this.scale * this.width;

    let recompute = !this.cache;
    if (this.cache) {
      // Outgrew the cached orbit's iterations or precision -> must recompute.
      if (maxIter > this.cache.maxIter || neededBits > this.cache.bits) {
        recompute = true;
      } else {
        // Reference drifted too far off-center -> recompute to re-anchor.
        const off = this.hp.refOffset();
        if (Math.hypot(off.x, off.y) > 0.5 * screenSpan) recompute = true;
      }
    }

    if (recompute) {
      // Headroom so small subsequent zoom/precision changes keep reusing.
      const computeMaxIter = Math.ceil(maxIter * 1.25);
      const computeBits = neededBits + 32;
      this.hp.setPrecision(computeBits);
      const orbit = this.hp.computeReference(computeMaxIter);
      this.cache = { orbit, maxIter: computeMaxIter, bits: computeBits };
      return { reference: orbit, refOffset: { x: 0, y: 0 }, uploadOrbit: true };
    }

    return {
      reference: this.cache!.orbit,
      refOffset: this.hp.refOffset(),
      uploadOrbit: false,
    };
  }

  /** Linear magnification relative to the initial view. */
  get zoom() {
    return Viewport.INITIAL_SPAN / (this.scale * this.width);
  }
}
