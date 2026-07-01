import { envFlag } from "../../env-flags.js";
import type { DetectorPlugin, PluginDiscovery, ProtectedValue } from "../types.js";
import type { PiiRecognizer } from "./recognizer.js";
import { regexRecognizer } from "./regex-recognizer.js";

const PLUGIN_NAME = "pii";
const ENV_ENABLED = "FICTA_PII_ENABLED";

/**
 * Recognizers are the swap point behind this plugin: the in-process `regex` recognizer (sync) ships
 * today. An async recognizer — e.g. a Microsoft Presidio / NER sidecar for names/addresses/orgs —
 * plugs in here behind {@link PiiRecognizer}: the engine's detection path is async, so `detectText`
 * awaits each recognizer (sync or async).
 */
const recognizers: readonly PiiRecognizer[] = [regexRecognizer];

function piiEnabled(): boolean {
  return envFlag(process.env[ENV_ENABLED]);
}

/**
 * Best-effort PII detection, off by default. Detected values are tokenized on egress and restored
 * on responses exactly like a registered secret — but detection is a *reduction*, never a guarantee
 * (see docs/threat-model). Self-gates on its own config flag; the core never adds/removes plugins.
 */
export const piiPlugin: DetectorPlugin = {
  kind: "detector",
  name: PLUGIN_NAME,
  description: "Best-effort structured-PII detection (email, SSN, credit card), tokenized like any protected value",
  config: {
    envDefaults: { [ENV_ENABLED]: "0" },
    bindings: [{ env: ENV_ENABLED, path: ["pii", "enabled"], kind: "boolean" }],
    sections: [{ path: ["pii"], keys: ["enabled"] }],
  },
  setup: {
    registrySources: () => [
      {
        id: `${PLUGIN_NAME}/detector`,
        label: "PII detection — best-effort redaction of emails, SSNs, and card numbers (off by default)",
        defaultEnabled: piiEnabled(),
        enabledValues: () => ({ [ENV_ENABLED]: "1" }),
        disabledValues: () => ({ [ENV_ENABLED]: "0" }),
      },
    ],
  },
  discover: () => [discoverPii()],
  async detectText(text, ctx) {
    if (!text || !piiEnabled()) return [];
    const out: ProtectedValue[] = [];
    const seen = new Set<string>();
    for (const recognizer of recognizers) {
      // Recognizers may be sync (regex) or async (a Presidio/NER sidecar); await normalizes both.
      const found = await recognizer.detect(text, ctx);
      for (const value of found) {
        if (seen.has(value.value)) continue;
        seen.add(value.value);
        out.push(value);
      }
    }
    return out;
  },
};

function discoverPii(): PluginDiscovery {
  const enabled = piiEnabled();
  return {
    id: `${PLUGIN_NAME}/detector`,
    plugin: PLUGIN_NAME,
    label: "PII detector",
    // A detector holds no pre-loaded values — it matches each request at runtime — so report `active`
    // with no valueCount rather than a misleading "(0 values)" that reads as idle.
    status: enabled ? "active" : "disabled",
    message: enabled
      ? `active — matches each request; best-effort structured PII (${recognizers.map((r) => r.name).join(", ")}), tokenized on egress and restored on responses`
      : `disabled — set ${ENV_ENABLED}=1 (pii.enabled=true) to redact emails, SSNs, and card numbers`,
  };
}
