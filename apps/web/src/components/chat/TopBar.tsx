import { Moon, Plus, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ModelChoice } from "@/lib/models";
import { useTheme } from "@/lib/use-theme";
import { ModelPicker } from "./ModelPicker";
import { ProtectionBadge } from "./ProtectionBadge";

export function TopBar({
  model,
  onModelChange,
  onNewChat,
  busy,
  canReset,
}: {
  model: ModelChoice;
  onModelChange: (choice: ModelChoice) => void;
  onNewChat: () => void;
  busy?: boolean;
  canReset: boolean;
}) {
  const { theme, toggle } = useTheme();
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
        <div className="flex items-center gap-2.5">
          <span className="text-lg font-semibold tracking-tight lowercase">ficta</span>
          <ProtectionBadge className="hidden sm:inline-flex" />
        </div>
        <div className="flex items-center gap-2">
          <ModelPicker value={model} onChange={onModelChange} disabled={busy} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onNewChat}
                disabled={!canReset || busy}
                aria-label="New chat"
              >
                <Plus className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New chat</TooltipContent>
          </Tooltip>
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
