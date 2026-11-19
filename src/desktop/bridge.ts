import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// The Usage UI reads Error.message. Tauri returns native command errors as strings.
async function invoke(command: string, args?: Record<string, unknown>) {
  try {
    return await nativeInvoke(command, args);
  } catch (reason) {
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

window.gauge ??= {
  environments: () => invoke("environments"),
  request: (environment, method, input) =>
    invoke("report", { environment, method, input: input ?? null }),
  hide: () => invoke("hide"),
  openExternal: (url) => invoke("open_external", { url }),
};

document.addEventListener("mousedown", (event) => {
  const target = event.target;
  if (
    event.button === 0 &&
    target instanceof Element &&
    target.closest("main > div > header") &&
    !target.closest("button, select, input, a, [role=button]")
  ) {
    void getCurrentWindow().startDragging();
  }
});
