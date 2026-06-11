// Burning Ship: z -> (|Re z| + i|Im z|)^2 + c.
//
// The abs() is non-analytic, so the perturbation step differs from the analytic
// fractals — but it admits an EXACT delta recurrence (no small-delta assumption)
// using the signs of the FULL values x = X.re+e.re, y = X.im+e.im:
//
//   Real part:  x^2 - y^2 has no abs (|t|^2 = t^2), so it is exactly
//     Mandelbrot's:  e'.re = 2(X.re e.re - X.im e.im) + (e.re^2 - e.im^2) + dc.re
//
//   Imag part: with a = |x|, A = |X.re|, s_x = sign(x), s_X = sign(X.re):
//     δa = a - A = (s_x - s_X)·X.re + s_x·e.re        (exact identity)
//   and likewise δb for the imaginary component. Then
//     Δ(2ab) = 2(A·δb + B·δa + δa·δb)                  (exact identity)
//   When no sign flips, δa = s_X·e.re and this reduces to the linearized form
//   σ[2(X.re e.im + X.im e.re) + 2 e.re e.im]. When a sign DOES flip, the
//   (s_x - s_X)·X.re term is well-scaled because a flip implies |X.re| <= |e.re|
//   (the component is delta-sized), so X.re·F stays representable. This makes
//   the step exact through sign crossings AND through rebases to X_0 = (0,0),
//   where it degenerates to the full iteration — the same property that makes
//   Zhuoran rebasing exact for Mandelbrot.
//
//   (WGSL sign(0) = 0 falls out correctly in these identities: e.g. X = 0 gives
//   A = 0 and δa = s_x·e.re = |e.re| exactly.)

fn fractal_step(z: vec2<f32>, c: vec2<f32>) -> vec2<f32> {
  let a = abs(z.x);
  let b = abs(z.y);
  return vec2<f32>(a * a - b * b, 2.0 * a * b) + c;
}

fn fractal_step_df(z: DfComplex, c: DfComplex) -> DfComplex {
  let a = df_abs(z.re);
  let b = df_abs(z.im);
  let re = df_add(df_sub(df_mul(a, a), df_mul(b, b)), c.re);
  let im = df_add(df_mul_pow2(df_mul(a, b), 2.0), c.im);
  return DfComplex(re, im);
}

fn fractal_pstep(
  xm: vec2<f32>,     // reference orbit value X_n
  ehat: vec2<f32>,   // rescaled delta E_n = e_n * F
  eps: vec2<f32>,    // true delta e_n
  dcHat: vec2<f32>,  // rescaled c-offset dc * F
) -> vec2<f32> {
  let F = 1.0 / u.invF; // exact power of two (see drivers/pert.wgsl)

  // Signs of the reference components and of the full (reference + delta) values.
  let sX = sign(xm.x);
  let sY = sign(xm.y);
  let sx = sign(xm.x + eps.x);
  let sy = sign(xm.y + eps.y);

  // Folded reference components A = |X.re|, B = |X.im|.
  let bigA = sX * xm.x;
  let bigB = sY * xm.y;

  // Exact rescaled deltas of the folded components: δa = |x| - |X.re|, etc.
  // The (s-s)·X·F term is nonzero only on a sign flip, where X is delta-sized;
  // |X| <= ~6 regardless, so X*F (~2^110) cannot overflow f32 (max 2^128).
  let daHat = (sx - sX) * (xm.x * F) + sx * ehat.x;
  let dbHat = (sy - sY) * (xm.y * F) + sy * ehat.y;
  let da = daHat * u.invF;

  // Real part (no abs): 2(X.re E.re - X.im E.im) + (eps∘E cross terms) + dcHat
  let re = 2.0 * (xm.x * ehat.x - xm.y * ehat.y)
         + (eps.x * ehat.x - eps.y * ehat.y)
         + dcHat.x;
  // Imag part: Δ(2ab) = 2(A·δb + B·δa + δa·δb), all in rescaled space.
  let im = 2.0 * (bigA * dbHat + bigB * daHat + da * dbHat) + dcHat.y;
  return vec2<f32>(re, im);
}
