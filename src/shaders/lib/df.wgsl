// Double-float (df64) arithmetic for WGSL.
//
// A value is represented as vec2<f32>(hi, lo), an unevaluated sum hi + lo with
// |lo| <= 0.5*ulp(hi). This gives ~48 mantissa bits (~14 decimal digits) using
// only f32 hardware. Built from error-free transformations: each primitive op
// produces its result PLUS the exact rounding error, carried in the lo term.
//
// NOTE: these algorithms assume IEEE-754 round-to-nearest and that the compiler
// does NOT reassociate float expressions (e.g. simplifying `s - a` to `b`). WGSL
// forbids such reassociation, but a buggy driver that ignores that would silently
// degrade precision back toward plain f32 — the first thing to suspect if df
// doesn't extend the zoom range.

// Veltkamp split of an f32 into two ~12-bit halves (2^12 + 1 = 4097).
fn df_split(a: f32) -> vec2<f32> {
  let c = 4097.0 * a;
  let abig = c - a;
  let hi = c - abig;
  return vec2<f32>(hi, a - hi);
}

// Exact sum: returns (s, e) with a + b == s + e, for any a, b.
fn two_sum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let bb = s - a;
  let e = (a - (s - bb)) + (b - bb);
  return vec2<f32>(s, e);
}

// Exact sum when |a| >= |b|. Cheaper than two_sum.
fn quick_two_sum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  return vec2<f32>(s, b - (s - a));
}

// Exact product: returns (p, e) with a * b == p + e.
fn two_prod(a: f32, b: f32) -> vec2<f32> {
  let p = a * b;
  let aa = df_split(a);
  let bb = df_split(b);
  let e = ((aa.x * bb.x - p) + aa.x * bb.y + aa.y * bb.x) + aa.y * bb.y;
  return vec2<f32>(p, e);
}

fn df_from(a: f32) -> vec2<f32> {
  return vec2<f32>(a, 0.0);
}

fn df_add(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let s = two_sum(a.x, b.x);
  let t = two_sum(a.y, b.y);
  let r1 = quick_two_sum(s.x, s.y + t.x);
  return quick_two_sum(r1.x, r1.y + t.y);
}

fn df_sub(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return df_add(a, vec2<f32>(-b.x, -b.y));
}

fn df_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let p = two_prod(a.x, b.x);
  return quick_two_sum(p.x, p.y + (a.x * b.y + a.y * b.x));
}

// Multiply by a power of two (exact, no rounding): scaling both limbs is safe.
fn df_mul_pow2(a: vec2<f32>, s: f32) -> vec2<f32> {
  return vec2<f32>(a.x * s, a.y * s);
}
