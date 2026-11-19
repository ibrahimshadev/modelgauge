import { ProviderPackageIcon } from "~/components/ProviderPackageIcon";
import { packageIcons } from "~/components/providerLogos";
import { XIcon, TerminalIcon } from "lucide-react";
import {
  OpenAI,
  ClaudeAI,
  AntigravityIcon,
  CursorIcon,
} from "~/components/Icons";
export function ProviderInstanceIcon({
  driverKind,
  displayName,
  className,
  iconClassName,
}) {
  const Icon =
    {
      codex: OpenAI,
      claudeAgent: ClaudeAI,
      antigravity: AntigravityIcon,
      cursor: CursorIcon,
    }[driverKind] || TerminalIcon;
  return (
    <span aria-label={displayName} className={className}>
      {packageIcons[driverKind] ? (
        <ProviderPackageIcon
          icon={packageIcons[driverKind]}
          className={iconClassName || "size-full"}
        />
      ) : (
        <Icon className={iconClassName || "size-full"} />
      )}
    </span>
  );
}
export function AppRouteModal({ label, children }) {
  return (
    <main
      data-app-modal
      aria-label={label}
      className="flex h-dvh flex-col bg-background text-foreground"
    >
      {children}
    </main>
  );
}
export function AppRouteModalClose() {
  return (
    <button
      className="shrink-0 cursor-pointer rounded-md p-2 hover:bg-muted"
      aria-label="Hide in tray"
      onClick={() => window.gauge.hide()}
    >
      <XIcon size={16} />
    </button>
  );
}
