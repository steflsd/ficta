import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { MODELS } from "@/lib/models";
import { updateInstanceSettings } from "@/lib/storage/settings";
import { type InstanceSettings, isModelAllowed, modelKey } from "@/lib/storage/types";
import { SettingRow } from "./SettingRow";

type SaveStatus = "idle" | "saving" | "error";

const NAME_SAVE_DELAY_MS = 600;

function checkedFromSettings(settings: InstanceSettings): Set<string> {
  return new Set(MODELS.filter((m) => isModelAllowed(settings, modelKey(m))).map(modelKey));
}

function allowedModelsFromChecked(checked: Set<string>): string[] {
  // All checked ⇒ store [] (no restriction, future-proof). Otherwise store the checked subset.
  return checked.size === MODELS.length ? [] : [...checked];
}

function InlineStatus({ status, error }: { status: SaveStatus; error: string }) {
  if (status === "idle") return null;
  return (
    <p className={status === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
      {status === "saving" ? "Saving…" : error}
    </p>
  );
}

/**
 * Instance-wide settings, editable by admins. Rows autosave like ChatGPT/Claude settings: text changes
 * debounce, checkbox changes save immediately, and there is no form-level Save button.
 */
export function AdminSettingsForm({ settings }: { settings: InstanceSettings }) {
  const router = useRouter();
  const [name, setName] = useState(settings.instanceName ?? "");
  const [checked, setChecked] = useState<Set<string>>(() => checkedFromSettings(settings));
  const [nameStatus, setNameStatus] = useState<SaveStatus>("idle");
  const [modelsStatus, setModelsStatus] = useState<SaveStatus>("idle");
  const [modelsError, setModelsError] = useState("Couldn't save model availability.");
  const savedName = useRef(settings.instanceName ?? "");
  const nameSeq = useRef(0);
  const modelsSeq = useRef(0);

  useEffect(() => {
    const next = settings.instanceName ?? "";
    savedName.current = next;
    setName(next);
  }, [settings.instanceName]);

  useEffect(() => {
    setChecked(checkedFromSettings(settings));
  }, [settings]);

  useEffect(() => {
    const nextName = name.trim();
    if (nextName === savedName.current) {
      setNameStatus("idle");
      return;
    }

    const seq = nameSeq.current + 1;
    nameSeq.current = seq;
    setNameStatus("saving");

    const timeout = window.setTimeout(async () => {
      try {
        const updated = await updateInstanceSettings({ data: { instanceName: name } });
        savedName.current = updated.instanceName ?? "";
        await router.invalidate();
        if (nameSeq.current === seq) setNameStatus("idle");
      } catch {
        if (nameSeq.current === seq) setNameStatus("error");
      }
    }, NAME_SAVE_DELAY_MS);

    return () => window.clearTimeout(timeout);
  }, [name, router]);

  const saveModels = async (next: Set<string>, previous: Set<string>) => {
    const seq = modelsSeq.current + 1;
    modelsSeq.current = seq;
    setModelsStatus("saving");
    setModelsError("Couldn't save model availability.");

    try {
      await updateInstanceSettings({ data: { allowedModels: allowedModelsFromChecked(next) } });
      await router.invalidate();
      if (modelsSeq.current === seq) setModelsStatus("idle");
    } catch {
      if (modelsSeq.current === seq) {
        setChecked(previous);
        setModelsStatus("error");
      }
    }
  };

  const toggle = (key: string, on: boolean) => {
    if (!on && checked.has(key) && checked.size <= 1) {
      setModelsError("Select at least one model.");
      setModelsStatus("error");
      return;
    }

    const next = new Set(checked);
    if (on) next.add(key);
    else next.delete(key);
    if (next.size === checked.size && next.has(key) === checked.has(key)) return;

    const previous = checked;
    setChecked(next);
    void saveModels(next, previous);
  };

  return (
    <section>
      <SettingRow label="Instance name" htmlFor="instance-name" description="Shown in the sidebar header.">
        <div className="space-y-1">
          <Input
            id="instance-name"
            value={name}
            placeholder="ficta"
            className="w-48"
            onChange={(e) => setName(e.target.value)}
          />
          <InlineStatus status={nameStatus} error="Couldn't save instance name." />
        </div>
      </SettingRow>

      <SettingRow label="Available models" description="Only checked models can be selected in chat.">
        <div className="space-y-2">
          {MODELS.map((m) => {
            const key = modelKey(m);
            const id = `model-${key}`;
            return (
              <label key={key} htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                <Checkbox id={id} checked={checked.has(key)} onCheckedChange={(state) => toggle(key, state === true)} />
                <span className="font-medium">{m.label}</span>
                <span className="text-muted-foreground">{m.sublabel}</span>
              </label>
            );
          })}
          <InlineStatus status={modelsStatus} error={modelsError} />
        </div>
      </SettingRow>
    </section>
  );
}
