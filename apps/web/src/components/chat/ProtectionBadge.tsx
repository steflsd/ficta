import { ShieldCheck } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Surfaces ficta's core promise: PII/secrets are tokenized before they reach the model vendor.
 *
 * Placeholder for now — `count` is intentionally unused. When the proxy starts returning the number
 * of values it protected per request (metadata only, never the values), pass it in and the badge
 * lights up with a live number. Until then it shows the static reassurance.
 */
export function ProtectionBadge({ count, className }: { count?: number; className?: string }) {
  const hasCount = typeof count === "number";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground",
            className,
          )}
        >
          <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          {hasCount ? `${count} protected` : "Protected by ficta"}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-center">
        Sensitive values are replaced with tokens before your message reaches the AI provider, then restored in the
        reply. The provider never sees the originals.
      </TooltipContent>
    </Tooltip>
  );
}
