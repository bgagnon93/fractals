// Multibrot family: z -> z^d + c, integer power d = u.power (>= 2).
// d = 2 is the Mandelbrot set; d = 3 the cubic Multibrot, etc. Works with the
// Julia flag too (z0 seeded from the screen), giving multibrot-Julia sets.
//
// Perturbation: writing z = Z + e, the recurrence (Z+e)^d - Z^d expands to
//   e' = sum_{k=1}^{d} C(d,k) Z^{d-k} e^k + dc.
// In the rescaled delta space (E = e*F, eps = e, dcHat = dc*F), factoring one E
// out of every term (F*e^k = E*e^{k-1}) gives
//   E' = E * P + dcHat,   P = sum_{j=0}^{d-1} C(d,j+1) Z^{d-1-j} eps^j,
// evaluated by Horner with the binomial coefficient and Z-power carried along.

fn cpow(z: vec2<f32>, d: u32) -> vec2<f32> {
  var r = vec2<f32>(1.0, 0.0);
  for (var k: u32 = 0u; k < d; k = k + 1u) {
    r = cmul(r, z);
  }
  return r;
}

fn fractal_step(z: vec2<f32>, c: vec2<f32>) -> vec2<f32> {
  return cpow(z, u.power) + c;
}

fn fractal_step_df(z: DfComplex, c: DfComplex) -> DfComplex {
  var r = DfComplex(vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 0.0));
  for (var k: u32 = 0u; k < u.power; k = k + 1u) {
    r = dfc_mul(r, z);
  }
  return dfc_add(r, c);
}

fn fractal_pstep(
  xm: vec2<f32>,     // reference orbit value Z_n
  ehat: vec2<f32>,   // rescaled delta E_n = e_n * F
  eps: vec2<f32>,    // true delta e_n
  dcHat: vec2<f32>,  // rescaled c-offset dc * F
) -> vec2<f32> {
  let d = i32(u.power);
  // Horner over j = d-1 .. 0:  P = sum_j C(d,j+1) Z^{d-1-j} eps^j
  var p = vec2<f32>(0.0, 0.0);
  var zpow = vec2<f32>(1.0, 0.0); // Z^{d-1-j}, starts at Z^0
  var binom = 1.0;                // C(d, j+1), starts at C(d, d) = 1
  var j: i32 = d - 1;
  loop {
    if (j < 0) { break; }
    p = cmul(eps, p) + binom * zpow; // a_j = C(d,j+1) * Z^{d-1-j}
    // advance to j-1: C(d,j+1)->C(d,j) and Z^{..}-> next power
    binom = binom * f32(j + 1) / f32(d - j);
    zpow = cmul(zpow, xm);
    j = j - 1;
  }
  return cmul(ehat, p) + dcHat;
}
