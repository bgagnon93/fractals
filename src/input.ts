import type { Viewport } from "./viewport.ts";

/**
 * Wires pointer-drag panning, wheel zoom-to-cursor, and pinch-to-zoom onto
 * the canvas, mutating the viewport and calling `onChange` when a redraw is
 * needed. All coordinates are converted to device pixels to match the render
 * target.
 */
export function attachInput(
  canvas: HTMLCanvasElement,
  viewport: Viewport,
  onChange: () => void
) {
  const dpr = () => window.devicePixelRatio || 1;
  // Prevents the browser from handling native pan/zoom on touch devices.
  canvas.style.touchAction = "none";

  // Maps each active pointer id to its last known client position.
  const pointers = new Map<number, { x: number; y: number }>();

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) canvas.classList.add("dragging");
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId)!;
    const curr = { x: e.clientX, y: e.clientY };

    if (pointers.size === 1) {
      const dx = (curr.x - prev.x) * dpr();
      const dy = (curr.y - prev.y) * dpr();
      viewport.panByPixels(dx, dy);
      onChange();
    } else if (pointers.size === 2) {
      // Find the other pointer's last position.
      let other!: { x: number; y: number };
      for (const [id, pos] of pointers) {
        if (id !== e.pointerId) { other = pos; break; }
      }

      const prevDist = Math.hypot(other.x - prev.x, other.y - prev.y);
      const currDist = Math.hypot(other.x - curr.x, other.y - curr.y);

      if (prevDist > 0 && currDist > 0) {
        const rect = canvas.getBoundingClientRect();
        const midX = ((curr.x + other.x) / 2 - rect.left) * dpr();
        const midY = ((curr.y + other.y) / 2 - rect.top) * dpr();
        viewport.zoomAt(midX, midY, prevDist / currDist);
        onChange();
      }
    }

    pointers.set(e.pointerId, curr);
  });

  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);
    if (pointers.size === 0) canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
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
