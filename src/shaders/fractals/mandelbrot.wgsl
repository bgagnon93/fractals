// Mandelbrot formula: z -> z^2 + c.
//
// This is the ONLY GPU file that encodes the iteration. A new analytic fractal
// is a sibling file defining the same three functions:
//   - fractal_step      : one iteration in f32
//   - fractal_step_df   : one iteration in double-float
//   - fractal_pstep     : the *perturbed* iteration (rescaled delta space)
// The drivers (drivers/*.wgsl) call these and know nothing about the formula.
//
// Perturbation note: writing z = Z + e (Z = reference orbit), the Mandelbrot
// recurrence linearizes to  e' = 2*Z*e + e^2 + dc. In the rescaled delta space
// used by the perturbation driver (E = e*F, eps = e = E*invF, dcHat = dc*F):
//   E' = 2*Z*E + (eps)*E + dcHat
// The middle term is e^2 * F, grouped as (eps)*E so its intermediate stays O(e)
// and never overflows near the escape boundary.

fn fractal_step(z: vec2<f32>, c: vec2<f32>) -> vec2<f32> {
  return cmul(z, z) + c;
}

fn fractal_step_df(z: DfComplex, c: DfComplex) -> DfComplex {
  return dfc_add(dfc_mul(z, z), c);
}

fn fractal_pstep(
  xm: vec2<f32>,     // reference orbit value Z_n
  ehat: vec2<f32>,   // rescaled delta E_n = e_n * F
  eps: vec2<f32>,    // true delta e_n = E_n * invF
  dcHat: vec2<f32>,  // rescaled c-offset dc * F
) -> vec2<f32> {
  return cmul(2.0 * xm, ehat) + cmul(eps, ehat) + dcHat;
}
