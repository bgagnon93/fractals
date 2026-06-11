// Fullscreen blit: draws the compute-shader output texture to the canvas.
// Uses the standard oversized-triangle trick (3 verts, no vertex buffer).

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let xy = p[vi];
  var out: VsOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  // Map clip space [-1,1] to texture uv [0,1], flipping y.
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(tex, samp, in.uv, 0.0);
}
