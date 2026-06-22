import { type PluginDiscovery, registryDiscoveryLines } from "./plugins/index.js";

export interface StartupBannerOptions {
  protectedValues: number;
  agentCommand: string;
  baseUrl: string;
  discoveries: readonly PluginDiscovery[];
  verbose?: boolean;
}

interface SourceSummaryItem {
  label: string;
  count: number;
}

export function renderStartupBanner(opts: StartupBannerOptions): string {
  const sourceItems = registrySourceSummaryItems(opts.discoveries);
  const sourceTotal = sourceItems.reduce((sum, item) => sum + item.count, 0);
  const dedupeNote = sourceTotal > opts.protectedValues ? ` (${sourceTotal} loaded before dedupe)` : "";
  const lines = [
    `🔒 ficta ready — ${opts.protectedValues} ${plural(opts.protectedValues, "protected value")}${dedupeNote}`,
    `   ${opts.agentCommand} → ${opts.baseUrl}`,
    `   sources: ${sourceItems.length > 0 ? sourceItems.map(formatSourceSummaryItem).join(", ") : "none loaded"}`,
  ];

  const errorCount = opts.discoveries.filter((d) => d.status === "error").length;
  if (errorCount > 0 && !opts.verbose) {
    lines.push(
      `   attention: ${errorCount} registry ${plural(errorCount, "source")} errored; set FICTA_VERBOSE=1 or run \`ficta doctor\``,
    );
  }

  if (opts.verbose) {
    lines.push("   source details:");
    lines.push(...registryDiscoveryLines(opts.discoveries, "     "));
  }

  return `${lines.join("\n")}\n`;
}

function registrySourceSummaryItems(discoveries: readonly PluginDiscovery[]): SourceSummaryItem[] {
  const out: SourceSummaryItem[] = [];
  for (const discovery of discoveries) {
    const count = discovery.valueCount ?? 0;
    if (discovery.status !== "loaded" || count <= 0) continue;

    if (discovery.id === "known-env-values/env-file") {
      const fileItems = envFileSourceSummaryItems(discovery.details ?? []);
      if (fileItems.length > 0) {
        out.push(...fileItems);
        continue;
      }
    }

    out.push({ label: shortSourceLabel(discovery.label), count });
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
    out.push({ label, count });
  }
  return out;
}

function shortSourceLabel(label: string): string {
  return label.replace(/\s+CLI$/i, "");
}

function formatSourceSummaryItem(item: SourceSummaryItem): string {
  return `${item.label} ${item.count}`;
}

function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}
