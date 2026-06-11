// Tier 3/4 driver: perturbation with rescaled deltas. Iterates the small
// difference from a CPU reference orbit via the active fractal's fractal_pstep(),
// in a rescaled space (E = e*F) so deltas don't underflow f32 past ~1e35.
// Rebasing (Zhuoran) restarts the reference when it stops representing a pixel.
// See fractals/mandelbrot.wgsl for the rescaling algebra.

@group(0) @binding(2) var<storage, read> refOrbit: array<vec2<f32>>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<u32>(u.resolution);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let invF = u.invF;   // = 2^-108, exact (passed from JS)
  let F = 1.0 / invF;  // = 2^108, exact (reciprocal of a power of two)

  let offx = f32(gid.x) - u.resolution.x * 0.5;
  let offy = -(f32(gid.y) - u.resolution.y * 0.5) * u.ySign;
  // Rescaled offset of this pixel from the REFERENCE center. The reference may
  // be slightly off-screen (cached across small pans), hence + refOffsetHat.
  let pixelHat = vec2<f32>(offx, offy) * u.scale + u.refOffsetHat;

  // Mandelbrot: e0 = 0, and the c-offset enters as +dc every step.
  // Julia: the pixel offset is the initial z0 delta (e0); c is shared with the
  // reference so there is no per-step dc term.
  let julia = u.isJulia != 0u;
  var ehat = select(vec2<f32>(0.0, 0.0), pixelHat, julia); // E_n = e_n * F
  let dcHat = select(pixelHat, vec2<f32>(0.0, 0.0), julia);
  var refIter: u32 = 0u;
  var n: u32 = 0u;
  var z = vec2<f32>(0.0, 0.0);
  let bail2 = 256.0 * 256.0;

  loop {
    if (n >= u.maxIter) { break; }
    let xm = refOrbit[refIter];
    let eps = ehat * invF; // true delta e_n
    ehat = fractal_pstep(xm, ehat, eps, dcHat);
    refIter = refIter + 1u;
    n = n + 1u;

    let eps2 = ehat * invF;
    z = refOrbit[refIter] + eps2;
    let z2 = dot(z, z);
    if (z2 > bail2) { break; }

    // Rebase when the reference stops representing this pixel. Re-anchor at the
    // reference's closest approach to the origin (index 0 for Mandelbrot):
    //   e := z - X[rebase]   ->   ehat := (z - X[rebase]) * F
    if (z2 < dot(eps2, eps2) || refIter >= u.refLen - 1u) {
      ehat = (z - refOrbit[u.refRebase]) * F;
      refIter = u.refRebase;
    }
  }

  let color = smooth_color(n, u.maxIter, z, f32(u.power));
  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(color, 1.0));
}
