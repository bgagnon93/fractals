import type { Viewport } from "./viewport.ts";

/**
 * Wires pointer-drag panning, wheel zoom-to-cursor, and pinch-to-zoom onto
 * the canvas, mutating the viewport and calling `onChange` when a redraw is
 * needed. All coordinates are converted to device pixels to match the render
 * target.
 *
 * Touch gestures (pan, pinch) are handled via touch events so that
 * `targetTouches` gives us all active fingers reliably — pointer events alone
 * can miss the second finger in some browser / DevTools configurations.
 * Calling preventDefault() on touchstart suppresses the redundant pointer
 * events for those touches, so there is no double-handling.
 */
export function attachInput(
  canvas: HTMLCanvasElement,
  viewport: Viewport,
  onChange: () => void
) {
  const dpr = () => window.devicePixelRatio || 1;

  // ── Touch (mobile: pan + pinch) ──────────────────────────────────────────

  type PanState = { x: number; y: number };
  type PinchState = { dist: number; midX: number; midY: number };

  let panTouch: PanState | null = null;
  let pinchTouch: PinchState | null = null;

  function pinchStateFromTouches(touches: TouchList): PinchState {
    const [a, b] = [touches[0], touches[1]];
    return {
      dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      midX: (a.clientX + b.clientX) / 2,
      midY: (a.clientY + b.clientY) / 2,
    };
  }

  canvas.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault(); // suppress redundant pointer events for this touch
      if (e.targetTouches.length === 1) {
        panTouch = { x: e.targetTouches[0].clientX, y: e.targetTouches[0].clientY };
        pinchTouch = null;
        canvas.classList.add("dragging");
      } else if (e.targetTouches.length === 2) {
        panTouch = null;
        pinchTouch = pinchStateFromTouches(e.targetTouches);
      }
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      if (e.targetTouches.length === 1 && panTouch) {
        const t = e.targetTouches[0];
        viewport.panByPixels((t.clientX - panTouch.x) * dpr(), (t.clientY - panTouch.y) * dpr());
        panTouch = { x: t.clientX, y: t.clientY };
        onChange();
      } else if (e.targetTouches.length === 2 && pinchTouch) {
        const next = pinchStateFromTouches(e.targetTouches);
        const rect = canvas.getBoundingClientRect();
        const px = (next.midX - rect.left) * dpr();
        const py = (next.midY - rect.top) * dpr();
        // Zoom around the midpoint between fingers.
        if (next.dist > 0) viewport.zoomAt(px, py, pinchTouch.dist / next.dist);
        // Also pan with the midpoint shift.
        viewport.panByPixels((next.midX - pinchTouch.midX) * dpr(), (next.midY - pinchTouch.midY) * dpr());
        pinchTouch = next;
        onChange();
      }
    },
    { passive: false }
  );

  const endTouch = (e: TouchEvent) => {
    e.preventDefault();
    if (e.targetTouches.length === 1) {
      // One finger lifted during pinch — transition smoothly to pan.
      panTouch = { x: e.targetTouches[0].clientX, y: e.targetTouches[0].clientY };
      pinchTouch = null;
    } else if (e.targetTouches.length === 0) {
      panTouch = null;
      pinchTouch = null;
      canvas.classList.remove("dragging");
    }
  };
  canvas.addEventListener("touchend", endTouch, { passive: false });
  canvas.addEventListener("touchcancel", endTouch, { passive: false });

  // ── Mouse / stylus (pointer events, touch excluded) ──────────────────────

  let mouseDown = false;
  let mouseX = 0;
  let mouseY = 0;

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    mouseDown = true;
    mouseX = e.clientX;
    mouseY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
  });

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" || !mouseDown) return;
    viewport.panByPixels((e.clientX - mouseX) * dpr(), (e.clientY - mouseY) * dpr());
    mouseX = e.clientX;
    mouseY = e.clientY;
    onChange();
  });

  const endMouse = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    mouseDown = false;
    canvas.releasePointerCapture?.(e.pointerId);
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endMouse);
  canvas.addEventListener("pointercancel", endMouse);

  // ── Wheel (mouse scroll / trackpad zoom) ─────────────────────────────────

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
