// Tier 2 driver: per-pixel iteration in double-float (~14 digits, ~1e13).
// Calls the active fractal's fractal_step_df().

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<u32>(u.resolution);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let offx = f32(gid.x) - u.resolution.x * 0.5;
  let offy = -(f32(gid.y) - u.resolution.y * 0.5);

  let scale = vec2<f32>(u.scale, u.scaleLo);
  let wx = df_add(vec2<f32>(u.centerHi.x, u.centerLo.x), df_mul(df_from(offx), scale));
  let wy = df_add(vec2<f32>(u.centerHi.y, u.centerLo.y), df_mul(df_from(offy), scale));
  let w = DfComplex(wx, wy); // screen coordinate

  // Mandelbrot: screen is c, seed 0. Julia: screen is z0, c is the fixed constant.
  var z: DfComplex;
  var c: DfComplex;
  if (u.isJulia != 0u) {
    z = w;
    c = DfComplex(vec2<f32>(u.juliaC.x, u.juliaCLo.x), vec2<f32>(u.juliaC.y, u.juliaCLo.y));
  } else {
    z = DfComplex(vec2<f32>(0.0, 0.0), vec2<f32>(0.0, 0.0));
    c = w;
  }
  var n: u32 = 0u;
  let bail2 = 256.0 * 256.0;
  loop {
    if (n >= u.maxIter) { break; }
    z = fractal_step_df(z, c);
    let mag2 = df_add(df_mul(z.re, z.re), df_mul(z.im, z.im));
    if (mag2.x > bail2) { break; }
    n = n + 1u;
  }

  let zf = vec2<f32>(z.re.x, z.im.x); // hi limbs suffice for coloring
  let color = smooth_color(n, u.maxIter, zf, f32(u.power));
  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(color, 1.0));
}
