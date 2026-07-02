import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProtectionStatus } from "@/lib/protection-status";
import { cn } from "@/lib/utils";

/**
 * Surfaces ficta's current protection posture. The happy path stays compact, but degraded detector
 * states are explicit: Presidio fail-open means chat is still forwarded without that PII screening;
 * Presidio fail-closed means chat will be blocked before the model until the sidecar is healthy.
 */
export function ProtectionBadge({
  count,
  status,
  className,
}: {
  count?: number;
  status?: ProtectionStatus;
  className?: string;
}) {
  const view = badgeView(status, count);
  const Icon = view.tone === "good" ? ShieldCheck : AlertTriangle;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
            toneClass(view.tone),
            className,
          )}
        >
          <Icon className={cn("size-3.5", iconClass(view.tone))} aria-hidden />
          {view.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-center">{view.description}</TooltipContent>
    </Tooltip>
  );
}

function badgeView(status: ProtectionStatus | undefined, count: number | undefined) {
  if (!status) {
    return {
      tone: "neutral" as const,
      label: "Checking ficta",
      description: "Checking the local ficta proxy's protection posture…",
    };
  }

  if (!status.ok) {
    return {
      tone: "danger" as const,
      label: "ficta status unknown",
      description: status.detail ? `${status.message} (${status.detail})` : status.message,
    };
  }

  if (status.pii.status === "blocking") {
    return {
      tone: "danger" as const,
      label: "PII fail-closed",
      description: status.pii.detail ? `${status.pii.message} (${status.pii.detail})` : status.pii.message,
    };
  }

  if (status.pii.status === "degraded") {
    return {
      tone: "warning" as const,
      label: status.pii.failureMode === "fail-open" ? "PII fail-open" : "PII degraded",
      description: status.pii.detail ? `${status.pii.message} (${status.pii.detail})` : status.pii.message,
    };
  }

  if (!status.protection.protecting) {
    return {
      tone: "warning" as const,
      label: "ficta passthrough",
      description: "No registered values or active PII detector are configured, so requests are forwarded unchanged.",
    };
  }

  return {
    tone: "good" as const,
    label: typeof count === "number" ? `${count} protected` : "Protected by ficta",
    description:
      status.pii.status === "ok"
        ? status.pii.message
        : "Sensitive values are replaced with tokens before your message reaches the AI provider, then restored in the reply.",
  };
}

function toneClass(tone: "good" | "warning" | "danger" | "neutral"): string {
  switch (tone) {
    case "good":
      return "border-border bg-secondary text-secondary-foreground";
    case "warning":
      return "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100";
    case "danger":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "neutral":
      return "border-border bg-secondary text-muted-foreground";
  }
}

function iconClass(tone: "good" | "warning" | "danger" | "neutral"): string {
  switch (tone) {
    case "good":
      return "text-emerald-600 dark:text-emerald-400";
    case "warning":
      return "text-amber-700 dark:text-amber-300";
    case "danger":
      return "text-destructive";
    case "neutral":
      return "text-muted-foreground";
  }
}
