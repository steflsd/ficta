import { createServerFn } from "@tanstack/react-start";

export type PiiStatusState = "off" | "ok" | "degraded" | "blocking";
export type DetectorFailureMode = "fail-open" | "fail-closed";

export interface PiiProtectionStatus {
  enabled: boolean;
  configuredBackend: string;
  backend: string;
  status: PiiStatusState;
  failureMode: DetectorFailureMode;
  url?: string;
  detail?: string;
  message: string;
}

export interface ProtectionStatusOk {
  ok: true;
  service: "ficta";
  protection: {
    enabled: boolean;
    protecting: boolean;
    registeredValues: number;
    policyExcluded: number;
  };
  pii: PiiProtectionStatus;
}

export interface ProtectionStatusError {
  ok: false;
  proxyUrl: string;
  status: "unreachable" | "bad_response";
  message: string;
  detail?: string;
}

export type ProtectionStatus = ProtectionStatusOk | ProtectionStatusError;

const DEFAULT_PROXY_URL = "http://127.0.0.1:8787";
const STATUS_TIMEOUT_MS = 1500;

/**
 * Server-only status read. The browser asks this app, and the app asks the local ficta proxy, so the
 * proxy never needs browser CORS and the client receives only safe posture metadata — never values.
 */
export const fetchProtectionStatus = createServerFn({ method: "GET" }).handler(async (): Promise<ProtectionStatus> => {
  const proxyUrl = proxyBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);

  try {
    const res = await fetch(`${proxyUrl}/__ficta/status`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: `ficta proxy status returned HTTP ${res.status}; restart the proxy so the web UI can show protection posture.`,
      };
    }

    const json = (await res.json()) as unknown;
    if (!isProtectionStatusOk(json)) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: "ficta proxy status response was not understood; restart both dev servers.",
      };
    }
    return json;
  } catch (err) {
    return {
      ok: false,
      proxyUrl,
      status: "unreachable",
      message: `ficta proxy is unreachable at ${proxyUrl}; chat cannot be verified as protected until the proxy is running.`,
      detail: isAbortError(err) ? `timeout after ${STATUS_TIMEOUT_MS}ms` : errorMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
});

function proxyBaseUrl(): string {
  return stripTrailingSlash(process.env.FICTA_PROXY_URL ?? DEFAULT_PROXY_URL);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isProtectionStatusOk(value: unknown): value is ProtectionStatusOk {
  if (!isRecord(value)) return false;
  if (value.ok !== true || value.service !== "ficta") return false;
  if (!isRecord(value.protection) || !isRecord(value.pii)) return false;
  return (
    typeof value.protection.enabled === "boolean" &&
    typeof value.protection.protecting === "boolean" &&
    typeof value.protection.registeredValues === "number" &&
    typeof value.protection.policyExcluded === "number" &&
    typeof value.pii.enabled === "boolean" &&
    typeof value.pii.configuredBackend === "string" &&
    typeof value.pii.backend === "string" &&
    isPiiStatusState(value.pii.status) &&
    isFailureMode(value.pii.failureMode) &&
    typeof value.pii.message === "string" &&
    (value.pii.url === undefined || typeof value.pii.url === "string") &&
    (value.pii.detail === undefined || typeof value.pii.detail === "string")
  );
}

function isPiiStatusState(value: unknown): value is PiiStatusState {
  return value === "off" || value === "ok" || value === "degraded" || value === "blocking";
}

function isFailureMode(value: unknown): value is DetectorFailureMode {
  return value === "fail-open" || value === "fail-closed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
