import { Moon, PanelLeft, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ModelChoice } from "@/lib/models";
import type { ProtectionStatus } from "@/lib/protection-status";
import { useTheme } from "@/lib/use-theme";
import { ModelPicker } from "./ModelPicker";
import { ProtectionBadge } from "./ProtectionBadge";

export function TopBar({
  model,
  onModelChange,
  busy,
  sidebarOpen,
  onToggleSidebar,
  protectionStatus,
}: {
  model: ModelChoice;
  onModelChange: (choice: ModelChoice) => void;
  busy?: boolean;
  /** Sidebar state + toggle. Optional so TopBar still renders without the history sidebar. */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  protectionStatus?: ProtectionStatus;
}) {
  const { theme, toggle } = useTheme();
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
        <div className="flex items-center gap-2.5">
          {onToggleSidebar ? (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Mobile only: on desktop the sidebar is always visible (full or 52px rail) and carries its
                    own expand/collapse control, so this would be redundant there. */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggleSidebar}
                  aria-label="Toggle chat history"
                  className="md:hidden"
                >
                  <PanelLeft className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{sidebarOpen ? "Hide history" : "Show history"}</TooltipContent>
            </Tooltip>
          ) : null}
          {/* Brand now lives in the sidebar header; the top bar carries only the protection status. */}
          <ProtectionBadge status={protectionStatus} className="hidden sm:inline-flex" />
        </div>
        <div className="flex items-center gap-2">
          <ModelPicker value={model} onChange={onModelChange} disabled={busy} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
                {theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{theme === "dark" ? "Light mode" : "Dark mode"}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
