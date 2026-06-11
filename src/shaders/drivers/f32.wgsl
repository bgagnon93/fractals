// Tier 1 driver: naive per-pixel iteration in f32. Calls the active fractal's
// fractal_step(). Pixelates around zoom ~1e5 (f32 precision limit).

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<u32>(u.resolution);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let offx = f32(gid.x) - u.resolution.x * 0.5;
  let offy = -(f32(gid.y) - u.resolution.y * 0.5); // flip y -> +imaginary up
  let w = u.centerHi + vec2<f32>(offx, offy) * u.scale; // screen coordinate

  // Mandelbrot: screen is c, seed 0. Julia: screen is z0, c is fixed.
  var z = select(vec2<f32>(0.0, 0.0), w, u.isJulia != 0u);
  let c = select(w, u.juliaC, u.isJulia != 0u);
  var n: u32 = 0u;
  let bail2 = 256.0 * 256.0;
  loop {
    if (n >= u.maxIter) { break; }
    z = fractal_step(z, c);
    if (dot(z, z) > bail2) { break; }
    n = n + 1u;
  }

  let color = smooth_color(n, u.maxIter, z, f32(u.power));
  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(color, 1.0));
}
