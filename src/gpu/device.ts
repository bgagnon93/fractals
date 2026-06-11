/** WebGPU adapter/device acquisition and canvas configuration. */

export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

export async function initWebGPU(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new Error(
      "WebGPU is not available in this browser. Try a recent Chrome, Edge, " +
        "Firefox, or Safari (and ensure hardware acceleration is enabled)."
    );
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    throw new Error("No suitable GPU adapter found.");
  }

  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    // Surfaced to the console; a fuller recovery path can come later.
    console.error("WebGPU device lost:", info.message, info.reason);
  });

  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("Failed to obtain a WebGPU canvas context.");
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "opaque",
  });

  return { device, context, format, canvas };
}
