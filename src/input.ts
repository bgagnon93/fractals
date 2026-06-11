import type { Viewport } from "./viewport.ts";

/**
 * Wires pointer-drag panning and wheel zoom-to-cursor onto the canvas,
 * mutating the viewport and calling `onChange` whenever a redraw is needed.
 * All coordinates are converted to device pixels to match the render target.
 */
export function attachInput(
  canvas: HTMLCanvasElement,
  viewport: Viewport,
  onChange: () => void
) {
  const dpr = () => window.devicePixelRatio || 1;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = (e.clientX - lastX) * dpr();
    const dy = (e.clientY - lastY) * dpr();
    lastX = e.clientX;
    lastY = e.clientY;
    viewport.panByPixels(dx, dy);
    onChange();
  });

  const endDrag = (e: PointerEvent) => {
    dragging = false;
    canvas.classList.remove("dragging");
    canvas.releasePointerCapture?.(e.pointerId);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // Cursor position in device pixels relative to the canvas.
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * dpr();
      const py = (e.clientY - rect.top) * dpr();
      // Exponential zoom; trackpads send many small deltas, mice larger ones.
      const factor = Math.exp(e.deltaY * 0.0015);
      viewport.zoomAt(px, py, factor);
      onChange();
    },
    { passive: false }
  );
}
