import { useEffect, useState } from "react";
import { fetchProtectionStatus, type ProtectionStatus } from "./protection-status";

const POLL_MS = 15_000;

export function useProtectionStatus(): ProtectionStatus | undefined {
  const [status, setStatus] = useState<ProtectionStatus>();

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const refresh = async () => {
      try {
        const next = await fetchProtectionStatus();
        if (alive) setStatus(next);
      } catch (err) {
        if (!alive) return;
        setStatus({
          ok: false,
          proxyUrl: "",
          status: "bad_response",
          message: "Could not read ficta protection status.",
          detail: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (alive) timer = window.setTimeout(refresh, POLL_MS);
      }
    };

    void refresh();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return status;
}
