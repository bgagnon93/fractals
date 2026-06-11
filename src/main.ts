import { initWebGPU, type GpuContext } from "./gpu/device.ts";
import { Renderer, type RenderMode } from "./gpu/renderer.ts";
import { Viewport } from "./viewport.ts";
import { attachInput } from "./input.ts";
import { initPerturbation, HpCenter } from "./perturbation.ts";
import { SCENES, type Scene } from "./fractals.ts";

const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;
const sceneSelect = document.getElementById("scene") as HTMLSelectElement;

function fail(message: string) {
  errorEl.textContent = message;
  errorEl.style.display = "grid";
  console.error(message);
}

/** Iterations grow with depth so detail keeps resolving as we zoom in. */
function maxIterForZoom(zoom: number): number {
  return Math.min(20000, Math.floor(256 + 200 * Math.log10(Math.max(1, zoom))));
}

// Tier thresholds by linear zoom:
//   < 1e4   f32          (fast, ~7 digits)
//   < 1e12  double-float (~14 digits)
//   >=1e12  perturbation (CPU reference + GPU deltas)
const DF_ZOOM_THRESHOLD = 1e4;
const PERT_ZOOM_THRESHOLD = 1e12;

// When the GPU's double-float arithmetic is broken (see probeDoubleFloat), the
// df tier is useless — it degrades to f32. In that case we skip df entirely and
// drop straight into perturbation at the f32 wall, which only needs robust f32
// deltas on the GPU.
function modeForZoom(zoom: number, dfOk: boolean): RenderMode {
  const pertThreshold = dfOk ? PERT_ZOOM_THRESHOLD : DF_ZOOM_THRESHOLD;
  if (zoom >= pertThreshold) return "pert";
  if (dfOk && zoom >= DF_ZOOM_THRESHOLD) return "df";
  return "f32";
}

// Adaptive quality: render resolution is the dominant cost (every target pixel
// runs the full iteration loop), so we trade it to keep interactive frames near
// a time budget. We measure GPU time per frame and step between discrete scale
// buckets with hysteresis (separate up/down thresholds) and a cooldown so the
// scale doesn't flap between two neighbouring levels.
const QUALITY_BUCKETS = [1.0, 0.75, 0.5, 0.33];
const FRAME_BUDGET_MS = 22; // slower than this (~45fps) -> drop quality
const FRAME_RELAX_MS = 11; // comfortably faster than this (~90fps) -> raise it
const ADAPT_COOLDOWN_MS = 400; // min time between scale changes

async function main() {
  let gpu: GpuContext;
  try {
    gpu = await initWebGPU(canvas);
    await initPerturbation();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  const renderer = new Renderer(gpu);
  const viewport = new Viewport(new HpCenter(-0.5, 0.0));

  // Probe once: if df64 is unreliable on this GPU (e.g. Apple/Metal fast-math),
  // skip the df tier and route into perturbation at the f32 wall instead.
  const dfOk = await renderer.probeDoubleFloat();
  if (!dfOk) {
    console.warn(
      "double-float arithmetic unreliable on this GPU (likely Metal fast-math reassociation); " +
        "skipping df tier and using perturbation past the f32 limit."
    );
  }

  // Adaptive render-scale state. Bias the starting bucket down on high-DPI
  // touch devices (phones/tablets), which pay DPR² pixels and are the likeliest
  // to need it; the loop corrects from there either way.
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  let qualityIdx = coarse && (window.devicePixelRatio || 1) >= 2 ? 1 : 0;
  renderer.setRenderScale(QUALITY_BUCKETS[qualityIdx]);
  let gpuEmaMs = 0;
  let measuring = false;
  let lastAdapt = 0;

  // Refinement: while interacting we render degraded for responsiveness, then
  // once motion settles we render one crisp frame at full resolution.
  const REFINE_DELAY_MS = 180; // quiet time after the last frame before refining
  let lastFrameAt = 0;
  let refinePending = false; // a degraded frame is on screen, awaiting refinement

  function maybeAdapt() {
    const now = performance.now();
    if (now - lastAdapt < ADAPT_COOLDOWN_MS) return;
    let next = qualityIdx;
    if (gpuEmaMs > FRAME_BUDGET_MS && qualityIdx < QUALITY_BUCKETS.length - 1) next++;
    else if (gpuEmaMs < FRAME_RELAX_MS && qualityIdx > 0) next--;
    if (next === qualityIdx) return;
    qualityIdx = next;
    lastAdapt = now;
    renderer.setRenderScale(QUALITY_BUCKETS[qualityIdx]);
    requestRedraw(); // re-render at the new resolution
  }

  let dirty = true;
  const requestRedraw = () => {
    dirty = true;
  };

  // Scene selection (Mandelbrot / Julia presets).
  let currentScene: Scene = SCENES[0];
  for (const [i, s] of SCENES.entries()) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = s.name;
    sceneSelect.appendChild(opt);
  }
  function applyScene(scene: Scene) {
    currentScene = scene;
    renderer.setFractal(scene.fractal); // rebuilds pipelines only if the formula changed
    viewport.setFormula(scene.fractal.formula);
    viewport.setPower(scene.power);
    viewport.setFlipY(scene.flipY ?? false);
    viewport.setJulia(scene.isJulia, scene.juliaC.x, scene.juliaC.y);
    viewport.reset(scene.center.x, scene.center.y, scene.span);
    requestRedraw();
  }
  sceneSelect.addEventListener("change", () => applyScene(SCENES[+sceneSelect.value]));

  function syncSize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      viewport.setSize(w, h);
      renderer.resize(w, h);
      requestRedraw();
    }
  }

  new ResizeObserver(syncSize).observe(canvas);
  syncSize();
  applyScene(currentScene); // initialize seeding/center/span now that size is known

  attachInput(canvas, viewport, requestRedraw);

  // Render the current view once. When `adapt` is true (interactive frames) we
  // sample GPU time to drive the quality loop; the settle-time refinement passes
  // false so the intentionally-slow full-res frame doesn't skew the budget.
  function renderScene(adapt: boolean) {
    const zoom = viewport.zoom;
    const maxIter = maxIterForZoom(zoom);
    const mode = modeForZoom(zoom, dfOk);

    const sceneParams = {
      isJulia: currentScene.isJulia,
      juliaC: currentScene.juliaC,
      power: currentScene.power,
      flipY: currentScene.flipY ?? false,
    };
    let refInfo = "";
    let t0 = 0;
    if (mode === "pert") {
      const prepared = viewport.prepareReference(maxIter);
      t0 = performance.now(); // measure GPU work only, not reference build
      renderer.render(viewport, maxIter, mode, sceneParams, prepared);
      const { reference, uploadOrbit } = prepared;
      refInfo =
        `\nref    ${reference.points} pts${reference.escaped ? " (escaped)" : ""}` +
        `${uploadOrbit ? " ↻" : " ·cached"}`;
    } else {
      t0 = performance.now();
      renderer.render(viewport, maxIter, mode, sceneParams);
    }

    // Sample this frame's GPU time (one in flight at a time) and let the
    // adaptive loop adjust render scale to keep frames near the budget.
    if (adapt && !measuring) {
      measuring = true;
      gpu.device.queue.onSubmittedWorkDone().then(() => {
        const dt = performance.now() - t0;
        gpuEmaMs = gpuEmaMs > 0 ? gpuEmaMs * 0.8 + dt * 0.2 : dt;
        measuring = false;
        maybeAdapt();
      });
    }

    const precLabel =
      mode === "pert" ? "perturbation" : mode === "df" ? "double-float" : "f32";
    hud.textContent =
      `${currentScene.name}\n` +
      `zoom   ${zoom.toExponential(2)}\n` +
      `center ${viewport.center.x.toFixed(15)}, ${viewport.center.y.toFixed(15)}\n` +
      `iter   ${maxIter}\n` +
      `prec   ${precLabel}\n` +
      `qual   ${Math.round(renderer.currentRenderScale * 100)}%` +
      `${gpuEmaMs > 0 ? ` · ${gpuEmaMs.toFixed(1)}ms` : ""}` +
      refInfo +
      `\ndrag to pan · scroll to zoom`;
  }

  function frame() {
    if (dirty) {
      dirty = false;
      renderScene(true);
      lastFrameAt = performance.now();
      // If that frame was degraded, queue a full-res pass for when motion stops.
      refinePending = renderer.currentRenderScale < 1;
    } else if (refinePending && performance.now() - lastFrameAt > REFINE_DELAY_MS) {
      // Motion has settled — render one crisp frame at native resolution, then
      // restore the interactive scale so the next move stays responsive.
      refinePending = false;
      const interactiveScale = QUALITY_BUCKETS[qualityIdx];
      renderer.setRenderScale(1);
      renderScene(false);
      renderer.setRenderScale(interactiveScale);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
