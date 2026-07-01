import { loadRegistryValues, type ProtectedValue } from "./plugins/index.js";

interface InspectionHit {
  /** JSON-ish path to the string/key containing the registered value. */
  path: string;
  /** Safe labels whose values appeared at this path. Values are never included. */
  names: string[];
}

export interface InspectionReport {
  enabled: boolean;
  registeredValues: number;
  hits: InspectionHit[];
  truncated: boolean;
}

const MAX_HITS = 80;

export function registeredValues(): ProtectedValue[] {
  return loadRegistryValues();
}

export function registeredValueCount(): number {
  return registeredValues().length;
}

export function inspectJson(value: unknown): InspectionReport {
  const hits = collectHits((emit, values) => walkStrings(value, emit, values));
  return makeReport(hits);
}

export function inspectText(text: string, path = "$raw"): InspectionReport {
  const hits = collectHits((emit) => emit(text, path));
  return makeReport(hits);
}

/** Parse SSE `data:` JSON lines and inspect their string fields by event index/path. */
export function inspectSse(raw: string): InspectionReport {
  const hits = collectHits((emit, values) => {
    let i = 0;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        walkStrings(JSON.parse(data), emit, values, `sse[${i}]`);
      } catch {
        emit(data, `sse[${i}]`);
      }
      i++;
    }
  });
  return makeReport(hits);
}

export function inspectionLines(report: InspectionReport): string[] {
  if (!report.enabled) return [];
  if (report.hits.length === 0) return [];
  const out = [
    `   ⚠ exact registered-value hits (${report.hits.length} paths; ${report.registeredValues} values loaded):`,
  ];
  for (const hit of report.hits.slice(0, 12)) {
    out.push(`     ${hit.path}: ${hit.names.join(", ")}`);
  }
  if (report.hits.length > 12 || report.truncated) {
    out.push(`     … ${report.hits.length - 12}${report.truncated ? "+" : ""} more paths`);
  }
  return out;
}

function makeReport(hits: InspectionHit[]): InspectionReport {
  const n = registeredValueCount();
  return {
    enabled: n > 0,
    registeredValues: n,
    hits: hits.slice(0, MAX_HITS),
    truncated: hits.length > MAX_HITS,
  };
}

function collectHits(
  walk: (emit: (s: string, path: string) => void, values: ProtectedValue[]) => void,
): InspectionHit[] {
  const values = registeredValues();
  if (values.length === 0) return [];

  const byPath = new Map<string, Set<string>>();
  walk((s, path) => {
    if (!s) return;
    for (const protectedValue of values) {
      if (s.includes(protectedValue.value)) {
        const names = byPath.get(path) ?? new Set<string>();
        names.add(protectedValue.name);
        byPath.set(path, names);
      }
    }
  }, values);

  return [...byPath.entries()].map(([path, names]) => ({ path, names: [...names].sort() }));
}

function walkStrings(
  value: unknown,
  emit: (s: string, path: string) => void,
  values: ProtectedValue[],
  path = "$",
): void {
  if (typeof value === "string") {
    emit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      walkStrings(v, emit, values, `${path}[${i}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    let i = 0;
    for (const [k, v] of Object.entries(value)) {
      const childPath = path === "$" ? safePathSegment(k, i, values) : `${path}.${safePathSegment(k, i, values)}`;
      emit(k, `${childPath}.$key`);
      walkStrings(v, emit, values, childPath);
      i++;
    }
  }
}

function safePathSegment(key: string, index: number, values: ProtectedValue[]): string {
  const containsRegisteredValue = values.some((protectedValue) => key.includes(protectedValue.value));
  if (containsRegisteredValue) return `<key#${index}>`;
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) ? key : `<key#${index}>`;
}
