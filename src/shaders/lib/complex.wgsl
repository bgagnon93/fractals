// Generic complex-number helpers, fractal-independent.
// f32 complex as vec2<f32>(re, im); double-float complex as DfComplex.
// Depends on df.wgsl for the double-float variants.

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// A complex number whose components are each a double-float.
struct DfComplex {
  re: vec2<f32>,
  im: vec2<f32>,
}

fn dfc_add(a: DfComplex, b: DfComplex) -> DfComplex {
  return DfComplex(df_add(a.re, b.re), df_add(a.im, b.im));
}

fn dfc_mul(a: DfComplex, b: DfComplex) -> DfComplex {
  let re = df_sub(df_mul(a.re, b.re), df_mul(a.im, b.im));
  let im = df_add(df_mul(a.re, b.im), df_mul(a.im, b.re));
  return DfComplex(re, im);
}
