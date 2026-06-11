import { initWebGPU } from "./gpu/device.ts";
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

function modeForZoom(zoom: number): RenderMode {
  if (zoom >= PERT_ZOOM_THRESHOLD) return "pert";
  if (zoom >= DF_ZOOM_THRESHOLD) return "df";
  return "f32";
}

async function main() {
  let gpu;
  try {
    gpu = await initWebGPU(canvas);
    await initPerturbation();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  const renderer = new Renderer(gpu);
  const viewport = new Viewport(new HpCenter(-0.5, 0.0));

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
    viewport.setPower(scene.power);
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

  function frame() {
    if (dirty) {
      dirty = false;
      const zoom = viewport.zoom;
      const maxIter = maxIterForZoom(zoom);
      const mode = modeForZoom(zoom);

      const sceneParams = {
        isJulia: currentScene.isJulia,
        juliaC: currentScene.juliaC,
        power: currentScene.power,
      };
      let refInfo = "";
      if (mode === "pert") {
        const prepared = viewport.prepareReference(maxIter);
        renderer.render(viewport, maxIter, mode, sceneParams, prepared);
        const { reference, uploadOrbit } = prepared;
        refInfo =
          `\nref    ${reference.points} pts${reference.escaped ? " (escaped)" : ""}` +
          `${uploadOrbit ? " ↻" : " ·cached"}`;
      } else {
        renderer.render(viewport, maxIter, mode, sceneParams);
      }

      const precLabel =
        mode === "pert" ? "perturbation" : mode === "df" ? "double-float" : "f32";
      hud.textContent =
        `${currentScene.name}\n` +
        `zoom   ${zoom.toExponential(2)}\n` +
        `center ${viewport.center.x.toFixed(15)}, ${viewport.center.y.toFixed(15)}\n` +
        `iter   ${maxIter}\n` +
        `prec   ${precLabel}` +
        refInfo +
        `\ndrag to pan · scroll to zoom`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
