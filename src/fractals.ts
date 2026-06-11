import mandelbrotWGSL from "./shaders/fractals/mandelbrot.wgsl?raw";
import multibrotWGSL from "./shaders/fractals/multibrot.wgsl?raw";
import burningShipWGSL from "./shaders/fractals/burningship.wgsl?raw";

// Reference-orbit formula id — must match the constants in perturbation/src/lib.rs.
export const FORMULA_MULTIBROT = 0; // z^d + c (covers Mandelbrot/Julia/Multibrot)
export const FORMULA_BURNING_SHIP = 1; // (|Re z| + i|Im z|)^2 + c

/**
 * A fractal is defined by its iteration formula, encoded once as a WGSL module
 * that provides `fractal_step` / `fractal_step_df` / `fractal_pstep`. The
 * `formula` id selects the matching reference step on the Rust side. The drivers
 * and all precision/perturbation machinery are formula-agnostic, so adding a
 * fractal is mostly a new entry here plus a matching reference step in Rust.
 */
export interface Fractal {
  name: string;
  /** WGSL source defining the fractal_* functions. */
  wgsl: string;
  /** Reference-orbit formula id (FORMULA_*), passed to the WASM View. */
  formula: number;
}

export const MANDELBROT: Fractal = {
  name: "Mandelbrot",
  wgsl: mandelbrotWGSL,
  formula: FORMULA_MULTIBROT,
};

// Multibrot family z^d + c. The WGSL reads the exponent from the `power`
// uniform, so one module covers every d (and combines with the Julia flag).
export const MULTIBROT: Fractal = {
  name: "Multibrot",
  wgsl: multibrotWGSL,
  formula: FORMULA_MULTIBROT,
};

// Burning Ship (|Re z| + i|Im z|)^2 + c — non-analytic; its own perturbation step.
export const BURNING_SHIP: Fractal = {
  name: "Burning Ship",
  wgsl: burningShipWGSL,
  formula: FORMULA_BURNING_SHIP,
};

/**
 * A selectable scene. Mandelbrot/Julia share the z²+c module (differing only in
 * whether the screen maps to c or to the seed z0). Multibrot scenes use the
 * power-parameterized module — a different WGSL, so switching to/from them
 * rebuilds the compute pipelines (cheap, only on scene change).
 */
export interface Scene {
  name: string;
  fractal: Fractal;
  power: number; // multibrot exponent d (2 for the z²+c module)
  isJulia: boolean;
  juliaC: { x: number; y: number }; // ignored unless isJulia
  center: { x: number; y: number };
  span: number; // initial complex width
  /** Mirror the display vertically. The Burning Ship is conventionally shown
   * with the imaginary axis pointing down (the set "hangs" upside down in the
   * mathematical orientation); this flips only the display, not the math. */
  flipY?: boolean;
}

const M = MANDELBROT;
const MB = MULTIBROT;
const BS = BURNING_SHIP;

export const SCENES: Scene[] = [
  { name: "Mandelbrot", fractal: M, power: 2, isJulia: false, juliaC: { x: 0, y: 0 }, center: { x: -0.5, y: 0 }, span: 3.5 },
  { name: "Julia −0.8 + 0.156i", fractal: M, power: 2, isJulia: true, juliaC: { x: -0.8, y: 0.156 }, center: { x: 0, y: 0 }, span: 3.5 },
  { name: "Julia −0.70176 − 0.3842i", fractal: M, power: 2, isJulia: true, juliaC: { x: -0.70176, y: -0.3842 }, center: { x: 0, y: 0 }, span: 3.2 },
  { name: "Julia 0.285 + 0.01i", fractal: M, power: 2, isJulia: true, juliaC: { x: 0.285, y: 0.01 }, center: { x: 0, y: 0 }, span: 3.0 },
  { name: "Multibrot d=3", fractal: MB, power: 3, isJulia: false, juliaC: { x: 0, y: 0 }, center: { x: 0, y: 0 }, span: 3.0 },
  { name: "Multibrot d=4", fractal: MB, power: 4, isJulia: false, juliaC: { x: 0, y: 0 }, center: { x: 0, y: 0 }, span: 3.0 },
  { name: "Multibrot d=5", fractal: MB, power: 5, isJulia: false, juliaC: { x: 0, y: 0 }, center: { x: 0, y: 0 }, span: 3.0 },
  { name: "Multibrot-Julia d=3 (0.4)", fractal: MB, power: 3, isJulia: true, juliaC: { x: 0.4, y: 0 }, center: { x: 0, y: 0 }, span: 3.0 },
  // Burning Ship is degree 2, so power stays 2 (drives the smooth coloring).
  // flipY gives the canonical orientation (imaginary axis shown pointing down).
  { name: "Burning Ship", fractal: BS, power: 2, isJulia: false, juliaC: { x: 0, y: 0 }, center: { x: -0.5, y: -0.5 }, span: 4.0, flipY: true },
  { name: "Burning Ship (antenna)", fractal: BS, power: 2, isJulia: false, juliaC: { x: 0, y: 0 }, center: { x: -1.755, y: -0.03 }, span: 0.2, flipY: true },
  { name: "Burning Ship Julia (−1.76,−0.03)", fractal: BS, power: 2, isJulia: true, juliaC: { x: -1.76, y: -0.03 }, center: { x: 0, y: 0 }, span: 3.0, flipY: true },
];
