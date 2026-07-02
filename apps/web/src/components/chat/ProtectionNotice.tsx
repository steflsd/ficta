import { AlertTriangle } from "lucide-react";
import type { ProtectionStatus } from "@/lib/protection-status";
import { cn } from "@/lib/utils";

export function ProtectionNotice({ status }: { status?: ProtectionStatus }) {
  const notice = noticeFor(status);
  if (!notice) return null;

  return (
    <div className="px-4 pb-2">
      <div
        role="alert"
        className={cn(
          "mx-auto flex w-full max-w-3xl items-start gap-3 rounded-xl border px-4 py-3 text-sm",
          notice.tone === "danger"
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100",
        )}
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{notice.title}</p>
          <p className="mt-1 text-current/85">{notice.body}</p>
        </div>
      </div>
    </div>
  );
}

function noticeFor(status: ProtectionStatus | undefined):
  | {
      tone: "warning" | "danger";
      title: string;
      body: string;
    }
  | undefined {
  if (!status) return undefined;

  if (!status.ok) {
    return {
      tone: "danger",
      title: "ficta protection status is unavailable",
      body: status.detail ? `${status.message} (${status.detail})` : status.message,
    };
  }

  if (status.pii.status === "blocking") {
    return {
      tone: "danger",
      title: "Presidio is down — fail-closed will block chat",
      body: withDetail(
        `${status.pii.message} Registered exact secrets remain protected; the PII detector will not let unscreened chat reach the model while this posture is active.`,
        status.pii.detail,
      ),
    };
  }

  if (status.pii.status === "degraded") {
    return {
      tone: "warning",
      title:
        status.pii.backend === "presidio"
          ? "Presidio is down — fail-open is forwarding chat"
          : "PII detection is degraded",
      body: withDetail(
        `${status.pii.message} Registered exact secrets still use ficta protection, but the selected PII backend is not screening this request path.`,
        status.pii.detail,
      ),
    };
  }

  if (!status.protection.protecting) {
    return {
      tone: "warning",
      title: "ficta is in passthrough",
      body: "No registered values or active PII detector are configured, so requests are forwarded unchanged.",
    };
  }

  return undefined;
}

function withDetail(message: string, detail: string | undefined): string {
  return detail ? `${message} (${detail})` : message;
}
