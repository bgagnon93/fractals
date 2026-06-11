// Shared uniform block and the bindings common to every compute driver.
// (The perturbation driver additionally declares binding 2 for the reference
// orbit.) Field meaning depends on the active tier — see comments.

struct Uniforms {
  centerHi: vec2<f32>,   // hi limb of the center coordinate
  centerLo: vec2<f32>,   // lo limb (df tier); unused by f32 tier
  resolution: vec2<f32>, // render-target size in pixels
  scale: f32,            // units/pixel (hi limb); pert tier: scale * F (rescaled)
  scaleLo: f32,          // units/pixel lo limb (df tier); unused otherwise
  maxIter: u32,
  refLen: u32,           // perturbation only: reference orbit length
  invF: f32,             // perturbation only: 1/F, an exact power of two
  isJulia: u32,          // 0 = Mandelbrot (seed 0, c = screen), 1 = Julia
  refRebase: u32,        // perturbation only: closest-approach rebase index
  juliaC: vec2<f32>,     // Julia constant (hi limbs); unused in Mandelbrot mode
  juliaCLo: vec2<f32>,   // Julia constant (lo limbs, for the df tier)
  refOffsetHat: vec2<f32>, // pert only: (center - reference center) * F (cached-orbit reuse)
  power: u32,            // multibrot exponent d (2 = Mandelbrot)
  ySign: f32,            // +1: +imaginary up (default); -1: display mirrored
                         // vertically (canonical Burning Ship orientation)
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba8unorm, write>;
