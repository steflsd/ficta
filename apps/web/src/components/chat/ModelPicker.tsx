import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MODELS, type ModelChoice } from "@/lib/models";
import { isModelAllowed, modelKey } from "@/lib/storage/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";

export function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  disabled?: boolean;
}) {
  const instance = useInstanceSettings();
  // Only offer models the instance allows; the /api/chat route enforces the same list server-side.
  const models = MODELS.filter((m) => isModelAllowed(instance, modelKey(m)));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} className="gap-1.5">
          <span className="font-medium">{value.label}</span>
          <span className="text-muted-foreground">{value.sublabel}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {models.map((m) => (
          <DropdownMenuItem
            key={m.model}
            onSelect={() => onChange(m)}
            className="flex items-center justify-between gap-2"
          >
            <span className="flex flex-col">
              <span className="font-medium">{m.label}</span>
              <span className="text-xs text-muted-foreground">{m.sublabel}</span>
            </span>
            {m.model === value.model ? <Check className="size-4" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
