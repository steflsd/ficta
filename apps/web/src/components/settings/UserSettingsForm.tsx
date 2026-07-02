import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { MODELS, type ModelChoice } from "@/lib/models";
import { updateUserSettings } from "@/lib/storage/settings";
import type { UserSettings } from "@/lib/storage/types";
import { SettingRow } from "./SettingRow";

/** Map stored settings to a concrete MODELS entry; fall back to the first model if unset or stale. */
function resolveChoice(settings: UserSettings): ModelChoice {
  const dm = settings.defaultModel;
  return MODELS.find((m) => m.provider === dm?.provider && m.model === dm?.model) ?? MODELS[0];
}

function InlineStatus({ status, error }: { status: "idle" | "saving" | "error"; error: string }) {
  if (status === "idle") return null;
  return (
    <p className={status === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
      {status === "saving" ? "Saving…" : error}
    </p>
  );
}

export function UserSettingsForm({ settings }: { settings: UserSettings }) {
  const router = useRouter();
  const initial = resolveChoice(settings);
  const [choice, setChoice] = useState<ModelChoice>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const saveSeq = useRef(0);

  const choose = async (next: ModelChoice) => {
    if (next.provider === choice.provider && next.model === choice.model) return;

    const previous = choice;
    const seq = saveSeq.current + 1;
    saveSeq.current = seq;
    setChoice(next);
    setStatus("saving");

    try {
      await updateUserSettings({ data: { defaultModel: { provider: next.provider, model: next.model } } });
      // Refresh router loaders/context so a re-open of settings reflects the saved value.
      await router.invalidate();
      if (saveSeq.current === seq) setStatus("idle");
    } catch {
      if (saveSeq.current === seq) {
        setChoice(previous);
        setStatus("error");
      }
    }
  };

  return (
    <section>
      <SettingRow label="Default model" description="Pre-selected when you start a new chat.">
        <div className="space-y-1">
          <ModelPicker value={choice} onChange={choose} />
          <InlineStatus status={status} error="Couldn't save default model." />
        </div>
      </SettingRow>
    </section>
  );
}
