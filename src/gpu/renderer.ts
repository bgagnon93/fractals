import dfWGSL from "../shaders/lib/df.wgsl?raw";
import complexWGSL from "../shaders/lib/complex.wgsl?raw";
import colorWGSL from "../shaders/lib/color.wgsl?raw";
import bindingsWGSL from "../shaders/lib/bindings.wgsl?raw";
import driverF32WGSL from "../shaders/drivers/f32.wgsl?raw";
import driverDfWGSL from "../shaders/drivers/df.wgsl?raw";
import driverPertWGSL from "../shaders/drivers/pert.wgsl?raw";
import probeWGSL from "../shaders/probe.wgsl?raw";
import blitWGSL from "../shaders/blit.wgsl?raw";
import type { Viewport, PreparedReference } from "../viewport.ts";
import type { GpuContext } from "./device.ts";
import { MANDELBROT, type Fractal } from "../fractals.ts";

// Unified uniform block, 80 bytes (see lib/bindings.wgsl for the WGSL struct):
//   centerHi   vec2<f32> @ 0     (f32 idx 0,1)
//   centerLo   vec2<f32> @ 8     (2,3)
//   resolution vec2<f32> @ 16    (4,5)
//   scale      f32       @ 24    (6)   pert: scale*F
//   scaleLo    f32       @ 28    (7)
//   maxIter    u32       @ 32    (8)
//   refLen     u32       @ 36    (9)   perturbation only
//   invF       f32       @ 40    (10)  perturbation only
//   isJulia    u32       @ 44    (11)
//   refRebase  u32       @ 48    (12)  perturbation only
//   (pad @ 52, idx 13)
//   juliaC     vec2<f32> @ 56    (14,15)
//   juliaCLo   vec2<f32> @ 64    (16,17)
//   refOffsetHat vec2<f32> @ 72  (18,19)  perturbation only
//   power      u32       @ 80    (20)
//   ySign      f32       @ 84    (21)  +1 normal, -1 mirrored display
//   (pad to 96)
const UNIFORM_SIZE = 96;

const WORKGROUP = 8;

// Rescale factor for perturbation deltas (an exact power of two). Keeps scale*F
// in f32's normal range at extreme depth (see mandelbrot_pert.wgsl). Both F and
// its reciprocal are passed to the shader so it never calls exp2 (whose GPU
// approximation can return inf/0 for large arguments).
const RESCALE_F = 2 ** 108;
const RESCALE_INV_F = 2 ** -108;

export type RenderMode = "f32" | "df" | "pert";

export interface SceneParams {
  isJulia: boolean;
  juliaC: { x: number; y: number };
  power: number;
  flipY: boolean;
}

/** Split a JS double into a hi/lo pair of f32 (a double-float). */
function splitDouble(v: number): [number, number] {
  const hi = Math.fround(v);
  const lo = Math.fround(v - hi);
  return [hi, lo];
}

export class Renderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;

  private computeF32!: GPUComputePipeline;
  private computeDf!: GPUComputePipeline;
  private computePert!: GPUComputePipeline;
  private currentFractalWgsl = "";
  private computeLayout: GPUBindGroupLayout; // bindings 0,1 (f32 + df)
  private pertLayout: GPUBindGroupLayout; // bindings 0,1,2 (perturbation)
  private blitPipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private sampler: GPUSampler;

  private uniformData = new ArrayBuffer(UNIFORM_SIZE);
  private f32 = new Float32Array(this.uniformData);
  private u32 = new Uint32Array(this.uniformData);

  // Recreated on resize:
  private targetTex!: GPUTexture;
  private targetView!: GPUTextureView;
  private computeBindGroup!: GPUBindGroup;
  private blitBindGroup!: GPUBindGroup;
  private texWidth = 0;
  private texHeight = 0;

  // Reference orbit storage (perturbation):
  private refBuffer?: GPUBuffer;
  private refCapacity = 0; // in bytes
  private pertBindGroup?: GPUBindGroup;
  private pertBindGroupDirty = true;

  constructor(gpu: GpuContext, fractal: Fractal = MANDELBROT) {
    this.device = gpu.device;
    this.context = gpu.context;

    this.computeLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba8unorm" },
        },
      ],
    });
    this.pertLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba8unorm" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    this.buildComputePipelines(fractal.wgsl);

    const blitModule = this.device.createShaderModule({ code: blitWGSL });
    this.blitPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: blitModule, entryPoint: "vs" },
      fragment: { module: blitModule, entryPoint: "fs", targets: [{ format: gpu.format }] },
      primitive: { topology: "triangle-list" },
    });

    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampler = this.device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  }

  private buildComputePipelines(fractalWgsl: string) {
    this.currentFractalWgsl = fractalWgsl;
    const mk = (layout: GPUBindGroupLayout, code: string) =>
      this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: this.device.createShaderModule({ code }), entryPoint: "main" },
      });
    // Shared prelude (helpers + the active fractal's formula); each driver is
    // appended to it. Unused helpers in a given driver are harmless dead code.
    const prelude = [dfWGSL, complexWGSL, colorWGSL, bindingsWGSL, fractalWgsl].join("\n");
    this.computeF32 = mk(this.computeLayout, prelude + "\n" + driverF32WGSL);
    this.computeDf = mk(this.computeLayout, prelude + "\n" + driverDfWGSL);
    this.computePert = mk(this.pertLayout, prelude + "\n" + driverPertWGSL);
  }

  /**
   * One-shot compute pass that verifies the GPU's double-float arithmetic is
   * intact. Some drivers (notably Apple/Metal under fast-math) reassociate float
   * expressions, which collapses the error-free transforms in df.wgsl and
   * silently degrades df64 to plain f32 — so the df tier stops extending the
   * zoom range and detail breaks down right at the f32 wall (~1e6). Returns
   * false on such devices so the caller can route around the df tier.
   */
  async probeDoubleFloat(): Promise<boolean> {
    const layout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: this.device.createShaderModule({ code: dfWGSL + "\n" + probeWGSL }),
        entryPoint: "main",
      },
    });
    const outBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: outBuffer } }],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(outBuffer, 0, readBuffer, 0, 4);
    this.device.queue.submit([encoder.finish()]);

    await readBuffer.mapAsync(GPUMapMode.READ);
    const errLimb = new Float32Array(readBuffer.getMappedRange())[0];
    readBuffer.unmap();
    outBuffer.destroy();
    readBuffer.destroy();

    // Correct two_sum(1.0, 1e-20) yields an error limb ~1e-20; fast-math
    // reassociation yields exactly 0. Threshold generously between the two.
    return Math.abs(errLimb) > 1e-25;
  }

  /** Swap the active fractal formula, rebuilding the compute pipelines. */
  setFractal(fractal: Fractal) {
    if (fractal.wgsl === this.currentFractalWgsl) return;
    this.buildComputePipelines(fractal.wgsl);
  }

  resize(width: number, height: number) {
    if (width === this.texWidth && height === this.texHeight) return;
    this.texWidth = width;
    this.texHeight = height;

    this.targetTex?.destroy();
    this.targetTex = this.device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.targetView = this.targetTex.createView();

    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.targetView },
      ],
    });

    this.blitBindGroup = this.device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.targetView },
        { binding: 1, resource: this.sampler },
      ],
    });

    this.pertBindGroupDirty = true; // texture view changed
  }

  /** Upload the reference orbit, growing the storage buffer as needed. */
  private uploadReference(orbit: Float32Array<ArrayBuffer>) {
    const needed = orbit.byteLength;
    if (!this.refBuffer || needed > this.refCapacity) {
      this.refBuffer?.destroy();
      // Round up to reduce reallocation churn during a zoom.
      this.refCapacity = Math.max(needed, this.refCapacity * 2, 1 << 16);
      this.refBuffer = this.device.createBuffer({
        size: this.refCapacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.pertBindGroupDirty = true;
    }
    this.device.queue.writeBuffer(this.refBuffer, 0, orbit);
  }

  render(
    viewport: Viewport,
    maxIter: number,
    mode: RenderMode,
    scene: SceneParams,
    pert?: PreparedReference
  ) {
    const [cxHi, cxLo] = splitDouble(viewport.center.x);
    const [cyHi, cyLo] = splitDouble(viewport.center.y);
    this.f32[0] = cxHi;
    this.f32[1] = cyHi;
    this.f32[2] = cxLo;
    this.f32[3] = cyLo;
    this.f32[4] = this.texWidth;
    this.f32[5] = this.texHeight;
    if (mode === "pert") {
      // Pass scale*F (rescaled); plain scale would underflow f32 past ~1e35.
      this.f32[6] = viewport.scale * RESCALE_F;
      this.f32[7] = 0;
      this.f32[10] = RESCALE_INV_F;
    } else {
      const [sHi, sLo] = splitDouble(viewport.scale);
      this.f32[6] = sHi;
      this.f32[7] = sLo;
    }
    this.u32[8] = maxIter;
    this.u32[9] = pert ? pert.reference.points : 0;
    this.u32[11] = scene.isJulia ? 1 : 0;
    this.u32[12] = pert ? pert.reference.rebase : 0;
    const [jcxHi, jcxLo] = splitDouble(scene.juliaC.x);
    const [jcyHi, jcyLo] = splitDouble(scene.juliaC.y);
    this.f32[14] = jcxHi;
    this.f32[15] = jcyHi;
    this.f32[16] = jcxLo;
    this.f32[17] = jcyLo;
    // Rescaled offset of the (cached) reference center from the current center.
    this.f32[18] = (pert ? pert.refOffset.x : 0) * RESCALE_F;
    this.f32[19] = (pert ? pert.refOffset.y : 0) * RESCALE_F;
    this.u32[20] = scene.power;
    this.f32[21] = scene.flipY ? -1 : 1;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    // Select pipeline + bind group.
    let pipeline: GPUComputePipeline;
    let bindGroup: GPUBindGroup;
    if (mode === "pert" && pert) {
      // Only re-upload the orbit when it actually changed (recompute frames).
      if (pert.uploadOrbit || !this.refBuffer) {
        this.uploadReference(pert.reference.orbit);
      }
      if (this.pertBindGroupDirty || !this.pertBindGroup) {
        this.pertBindGroup = this.device.createBindGroup({
          layout: this.pertLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer } },
            { binding: 1, resource: this.targetView },
            { binding: 2, resource: { buffer: this.refBuffer! } },
          ],
        });
        this.pertBindGroupDirty = false;
      }
      pipeline = this.computePert;
      bindGroup = this.pertBindGroup;
    } else {
      pipeline = mode === "df" ? this.computeDf : this.computeF32;
      bindGroup = this.computeBindGroup;
    }

    const encoder = this.device.createCommandEncoder();

    const compute = encoder.beginComputePass();
    compute.setPipeline(pipeline);
    compute.setBindGroup(0, bindGroup);
    compute.dispatchWorkgroups(
      Math.ceil(this.texWidth / WORKGROUP),
      Math.ceil(this.texHeight / WORKGROUP)
    );
    compute.end();

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.blitPipeline);
    pass.setBindGroup(0, this.blitBindGroup);
    pass.draw(3);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}
