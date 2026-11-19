import "../desktop/bridge";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { GTProvider, initializeGTSPA } from "gt-react";
import { UsagePage } from "~/components/usage/UsagePage";
import { TooltipProvider } from "~/components/ui/tooltip";
import { initialize, appAtomRegistry } from "./state";

void initializeGTSPA({
  defaultLocale: "en",
  locales: ["en"],
  locale: "en",
  loadTranslations: async () => ({}),
  cacheExpiryTime: null,
});
const theme = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
  document.documentElement.classList.toggle("dark", theme.matches);
theme.addEventListener("change", applyTheme);
applyTheme();
const root = createRoot(document.getElementById("root")!);
root.render(
  <RegistryContext.Provider value={appAtomRegistry}>
    <GTProvider locale="en">
      <TooltipProvider>
        <UsagePage />
      </TooltipProvider>
    </GTProvider>
  </RegistryContext.Provider>,
);
initialize().catch((error) =>
  root.render(
    <main role="alert" className="p-6">
      Could not open local environments. {error.message}
    </main>,
  ),
);
window.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !document.querySelector(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-popup-open]',
    )
  )
    window.gauge.hide();
});
