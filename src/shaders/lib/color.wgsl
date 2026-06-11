// Coloring, fractal-independent. Continuous (smooth) escape-time shading via a
// cheap Inigo Quilez cosine palette.

fn palette(t: f32) -> vec3<f32> {
  let a = vec3<f32>(0.5, 0.5, 0.5);
  let b = vec3<f32>(0.5, 0.5, 0.5);
  let c = vec3<f32>(1.0, 1.0, 1.0);
  let d = vec3<f32>(0.00, 0.10, 0.20);
  return a + b * cos(6.28318530718 * (c * t + d));
}

// Interior points (n == maxIter) render black; escaped points get a band-free
// color from the normalized iteration count. `z` is the (full) escaped value,
// `power` the iteration exponent d. Near escape |z| -> |z|^d each step, so
// log2(log2|z|) grows by log2(d) per iteration; dividing by it keeps the count
// continuous for any d. For d = 2 (log2(2) = 1) this is the plain Mandelbrot
// formula, so existing colors are unchanged.
fn smooth_color(n: u32, maxIter: u32, z: vec2<f32>, power: f32) -> vec3<f32> {
  if (n >= maxIter) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }
  let nu = f32(n) + 1.0 - log2(log2(length(z))) / log2(power);
  return palette(nu * 0.02);
}
