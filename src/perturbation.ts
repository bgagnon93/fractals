import init, { View } from "./wasm/perturbation.js";

export interface ReferenceOrbit {
  /** Interleaved (re, im) f32 pairs, ready to upload to a storage buffer. */
  orbit: Float32Array<ArrayBuffer>;
  /** Number of complex points in the orbit. */
  points: number;
  /** Whether the reference escaped before max_iter. */
  escaped: boolean;
  /** Closest-approach index to rebase against (0 for Mandelbrot). */
  rebase: number;
}

let ready: Promise<void> | null = null;

/** Load and initialize the WASM module (idempotent). */
export function initPerturbation(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

/**
 * The view center, held at arbitrary precision inside WASM. This is the single
 * source of truth for the center: pan/zoom feed it small f64 deltas, and it is
 * read back as f64 for the shallow tiers and the HUD. Requires the WASM module
 * to be initialized (await initPerturbation first).
 */
export class HpCenter {
  private view: View;

  constructor(cx: number, cy: number) {
    this.view = new View(cx, cy);
  }

  /** Current center as f64 (exact while shallow; approximate once very deep). */
  get x(): number {
    return this.view.re_f64();
  }
  get y(): number {
    return this.view.im_f64();
  }

  /** Accumulate a small complex delta into the center at full precision. */
  translate(dx: number, dy: number): void {
    this.view.translate(dx, dy);
  }

  /** Reset the center (e.g. on scene change), back to base precision. */
  setCenter(x: number, y: number): void {
    this.view.set_center(x, y);
  }

  /** Choose Mandelbrot (isJulia=false) or a Julia set with the given constant. */
  setJulia(isJulia: boolean, cx: number, cy: number): void {
    this.view.set_julia(isJulia, cx, cy);
  }

  /** Set the multibrot exponent d (2 = Mandelbrot). */
  setPower(power: number): void {
    this.view.set_power(power);
  }

  /** Select the reference-orbit formula (FORMULA_* in fractals.ts). */
  setFormula(formula: number): void {
    this.view.set_formula(formula);
  }

  /** Current center minus the last computed reference center (small f64). */
  refOffset(): { x: number; y: number } {
    return { x: this.view.ref_offset_re(), y: this.view.ref_offset_im() };
  }

  /** Set the working precision (bits) — raise as zoom deepens. */
  setPrecision(bits: number): void {
    this.view.set_precision(bits);
  }

  computeReference(maxIter: number): ReferenceOrbit {
    const ref = this.view.compute_reference(maxIter);
    const result: ReferenceOrbit = {
      // Copy into an ArrayBuffer-backed view (GPUQueue.writeBuffer rejects the
      // WASM getter's potentially-shared backing type).
      orbit: new Float32Array(ref.orbit),
      points: ref.points,
      escaped: ref.escaped,
      rebase: ref.rebase,
    };
    ref.free();
    return result;
  }
}
