// Self-test for double-float arithmetic. A driver that reassociates float
// expressions (notably Apple/Metal under fast-math) collapses the error term in
// two_sum to zero, silently degrading df64 back to plain f32 — see df.wgsl. We
// compute a sum whose error limb is known-nonzero and write it out so the host
// can check whether it survived.
//
// This file is appended to lib/df.wgsl, which provides two_sum().

@group(0) @binding(0) var<storage, read_write> probeOut: array<f32>;

@compute @workgroup_size(1)
fn main() {
  // 1e-20 is far below ulp(1.0) (~1.2e-7), so the exact sum 1.0 + 1e-20 has an
  // error limb of ~1e-20. A correct two_sum preserves it; fast-math returns 0.
  let r = two_sum(1.0, 1e-20);
  probeOut[0] = r.y;
}
