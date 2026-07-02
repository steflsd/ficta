import {
  discoverySourceKey,
  type PluginDiscovery,
  type RegistryPolicy,
  registryDiscoveryLines,
  registryPolicyLines,
} from "./plugins/index.js";
import { plural } from "./text.js";

export interface StartupBannerOptions {
  protectedValues: number;
  agentCommand: string;
  baseUrl: string;
  discoveries: readonly PluginDiscovery[];
  /** Launch-time candidates dropped by an enforced registry-policy exclusion. */
  policyExcluded?: number;
  /** Excluded counts keyed by candidate source, for the per-source annotation. */
  policyExcludedBySource?: Record<string, number>;
  /** Effective registry policy, for the verbose exclusion breakdown. */
  registryPolicy?: RegistryPolicy;
  /** Resolved PII detector outage policy, for the posture note on the pii line (only shown when active). */
  piiFailClosed?: boolean;
  verbose?: boolean;
}

interface SourceSummaryItem {
  label: string;
  count: number;
  excluded: number;
}

export function shouldPrintStartupDiagnostics(opts: { verbose: boolean; stderrIsTTY?: boolean }): boolean {
  // Full-screen agent TUIs (notably Claude Code) can repaint over text emitted immediately before
  // spawn. Keep interactive launches clean by default, but preserve diagnostics for logs/pipes and
  // explicit debug runs.
  return opts.verbose || opts.stderrIsTTY !== true;
}

export function renderStartupBanner(opts: StartupBannerOptions): string {
  const excludedBySource = opts.policyExcludedBySource ?? {};
  const sourceItems = registrySourceSummaryItems(opts.discoveries, excludedBySource);
  const sourceTotal = sourceItems.reduce((sum, item) => sum + item.count, 0);
  const dedupeNote = reconcileNote(sourceTotal, opts.protectedValues, opts.policyExcluded ?? 0);
  const piiActive = opts.discoveries.some((d) => d.id === "pii/detector" && d.status === "active");
  const lines = [
    `🔒 ficta ready — ${opts.protectedValues} ${plural(opts.protectedValues, "protected value")}${dedupeNote}`,
    `   ${opts.agentCommand} → ${opts.baseUrl}`,
    `   sources: ${sourceItems.length > 0 ? sourceItems.map(formatSourceSummaryItem).join(", ") : "none loaded"}`,
    `   pii: ${formatPiiStatus(piiActive, opts.piiFailClosed)}`,
  ];

  const errorCount = opts.discoveries.filter((d) => d.status === "error").length;
  if (errorCount > 0 && !opts.verbose) {
    lines.push(
      `   attention: ${errorCount} registry ${plural(errorCount, "source")} errored; pass --ficta-verbose or run \`ficta doctor\``,
    );
  }

  if (opts.verbose) {
    lines.push("   source details:");
    lines.push(...registryDiscoveryLines(opts.discoveries, "     ", excludedBySource));
    const policyLines = opts.registryPolicy
      ? registryPolicyLines(opts.registryPolicy, "     ", { enforcedOnly: true })
      : [];
    if (policyLines.length > 0) {
      lines.push("   registry policy exclusions:");
      lines.push(...policyLines);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Render the pii line's status. Active launches note the resolved outage posture so the operator
 * knows up front whether a backend outage blocks requests (fail-closed) or silently degrades to no
 * detection (fail-open, the default) — the WARN only fires once the backend actually goes down.
 */
function formatPiiStatus(active: boolean, failClosed?: boolean): string {
  if (!active) return "off";
  const posture = failClosed ? "blocks on backend outage" : "skips on backend outage";
  return `on (best-effort, ${posture})`;
}

/**
 * Reconcile the per-source candidate sum against the protected total. The gap is split between
 * registry-policy exclusions (un-protected by name) and cross-source dedupe so the count is not
 * misattributed. When nothing was excluded, keep the original wording for backward compatibility.
 */
function reconcileNote(sourceTotal: number, protectedValues: number, excluded: number): string {
  const gap = sourceTotal - protectedValues;
  if (gap <= 0) return "";
  if (excluded <= 0) return ` (${sourceTotal} loaded before dedupe)`;
  const parts = [`${excluded} excluded by registry policy`];
  const deduped = gap - excluded;
  if (deduped > 0) parts.push(`${deduped} deduped`);
  return ` (${sourceTotal} loaded; ${parts.join(", ")})`;
}

function registrySourceSummaryItems(
  discoveries: readonly PluginDiscovery[],
  excludedBySource: Record<string, number>,
): SourceSummaryItem[] {
  const out: SourceSummaryItem[] = [];
  for (const discovery of discoveries) {
    const count = discovery.valueCount ?? 0;
    if (discovery.status !== "loaded" || count <= 0) continue;

    if (discovery.id === "known-env-values/env-file") {
      // Per-file breakdown cannot split policy exclusions per file; show files without an
      // annotation. The headline reconciliation still accounts for any excluded env-file values.
      const fileItems = envFileSourceSummaryItems(discovery.details ?? []);
      if (fileItems.length > 0) {
        out.push(...fileItems);
        continue;
      }
    }

    const excluded = excludedBySource[discoverySourceKey(discovery) ?? ""] ?? 0;
    out.push({ label: shortSourceLabel(discovery.label), count, excluded });
  }
  return out;
}

function envFileSourceSummaryItems(details: readonly string[]): SourceSummaryItem[] {
  const out: SourceSummaryItem[] = [];
  for (const detail of details) {
    const match = /^(.*): (\d+) loaded$/.exec(detail);
    if (!match) continue;
    const label = match[1];
    const count = Number(match[2]);
    if (!label || !Number.isFinite(count) || count <= 0) continue;
    out.push({ label, count, excluded: 0 });
  }
  return out;
}

function shortSourceLabel(label: string): string {
  return label.replace(/\s+CLI$/i, "");
}

function formatSourceSummaryItem(item: SourceSummaryItem): string {
  const excludedNote = item.excluded > 0 ? ` (${item.excluded} excluded)` : "";
  return `${item.label} ${item.count}${excludedNote}`;
}
