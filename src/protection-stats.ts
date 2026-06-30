import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProtectionHit } from "./engine.js";
import { plural } from "./text.js";
import type { Wire } from "./wire.js";

export type ProtectionSurface = "body" | "query string" | "non-auth headers";

export interface ProtectionStatsRecord {
  requestId?: number;
  method: string;
  path: string;
  wire: Wire;
  route?: string;
  model?: string;
  surface: ProtectionSurface;
  redactedValues: number;
  survivingValues: number;
  blocked: boolean;
  redactedHits?: readonly ProtectionHit[];
  survivingHits?: readonly ProtectionHit[];
}

export interface ProtectionStatsEvent
  extends Required<Omit<ProtectionStatsRecord, "requestId" | "route" | "model" | "redactedHits" | "survivingHits">> {
  index: number;
  at: string;
  requestId?: number;
  route?: string;
  model: string;
  redactedHits: ProtectionHit[];
  survivingHits: ProtectionHit[];
}

export interface ProtectionStatsTotals {
  events: number;
  affectedRequests: number;
  redactedValues: number;
  survivingValues: number;
  blockedRequests: number;
  keptOutOfModelValues: number;
}

export interface ProtectionStatsBucket {
  name: string;
  requests: number;
  redactedValues: number;
  survivingValues: number;
  blockedRequests: number;
  keptOutOfModelValues: number;
}

export interface ProtectionStatsLabelBucket extends ProtectionStatsBucket {
  source: string;
  plugin?: string;
  kind?: ProtectionHit["kind"];
  confidence?: ProtectionHit["confidence"];
}

export interface ProtectionStatsSnapshot {
  version: 1;
  path: string;
  startedAt: string;
  updatedAt: string;
  totals: ProtectionStatsTotals;
  byModel: ProtectionStatsBucket[];
  bySurface: ProtectionStatsBucket[];
  byWire: ProtectionStatsBucket[];
  byLabel: ProtectionStatsLabelBucket[];
  events: ProtectionStatsEvent[];
}

interface MutableBucket {
  name: string;
  requestKeys: Set<string>;
  redactedValues: number;
  survivingValues: number;
  blockedRequestKeys: Set<string>;
  keptOutOfModelValues: number;
}

interface MutableLabelBucket extends MutableBucket {
  source: string;
  plugin?: string;
  kind?: ProtectionHit["kind"];
  confidence?: ProtectionHit["confidence"];
}

export class ProtectionStats {
  private readonly startedAt = new Date().toISOString();
  private readonly events: ProtectionStatsEvent[] = [];
  readonly path: string;

  constructor(runDir: string) {
    this.path = join(runDir, "stats.json");
    this.write();
  }

  record(record: ProtectionStatsRecord): void {
    if (record.redactedValues <= 0 && record.survivingValues <= 0) return;
    const event: ProtectionStatsEvent = {
      index: this.events.length + 1,
      at: new Date().toISOString(),
      method: record.method,
      path: record.path,
      wire: record.wire,
      surface: record.surface,
      redactedValues: record.redactedValues,
      survivingValues: record.survivingValues,
      blocked: record.blocked,
      model: normalizeModel(record.model),
      redactedHits: [...(record.redactedHits ?? [])],
      survivingHits: [...(record.survivingHits ?? [])],
    };
    if (record.requestId !== undefined) event.requestId = record.requestId;
    if (record.route) event.route = record.route;
    this.events.push(event);
    this.write();
  }

  snapshot(): ProtectionStatsSnapshot {
    const updatedAt = new Date().toISOString();
    const totals = this.totals();
    return {
      version: 1,
      path: this.path,
      startedAt: this.startedAt,
      updatedAt,
      totals,
      byModel: this.groupBy((event) => event.model),
      bySurface: this.groupBy((event) => event.surface),
      byWire: this.groupBy((event) => event.wire),
      byLabel: this.groupByLabel(),
      events: [...this.events],
    };
  }

  write(): void {
    writeFileSync(this.path, `${JSON.stringify(this.snapshot(), null, 2)}\n`, { mode: 0o600 });
  }

  renderSummary(): string {
    return renderProtectionStatsSummary(this.snapshot());
  }

  private totals(): ProtectionStatsTotals {
    const affectedRequestKeys = new Set<string>();
    const blockedRequestKeys = new Set<string>();
    let redactedValues = 0;
    let survivingValues = 0;
    let keptOutOfModelValues = 0;
    for (const event of this.events) {
      const key = requestKey(event);
      affectedRequestKeys.add(key);
      redactedValues += event.redactedValues;
      survivingValues += event.survivingValues;
      keptOutOfModelValues += keptOutValues(event);
      if (event.blocked) blockedRequestKeys.add(key);
    }
    return {
      events: this.events.length,
      affectedRequests: affectedRequestKeys.size,
      redactedValues,
      survivingValues,
      blockedRequests: blockedRequestKeys.size,
      keptOutOfModelValues,
    };
  }

  private groupBy(nameFor: (event: ProtectionStatsEvent) => string): ProtectionStatsBucket[] {
    const buckets = new Map<string, MutableBucket>();
    for (const event of this.events) {
      const name = nameFor(event) || "unknown";
      const bucket = buckets.get(name) ?? newMutableBucket(name);
      buckets.set(name, bucket);
      addEventToBucket(bucket, event);
    }
    return [...buckets.values()].map(freezeBucket).sort(compareBuckets);
  }

  private groupByLabel(): ProtectionStatsLabelBucket[] {
    const buckets = new Map<string, MutableLabelBucket>();
    for (const event of this.events) {
      const request = requestKey(event);
      for (const hit of event.redactedHits) {
        const bucket = labelBucket(buckets, hit);
        bucket.requestKeys.add(request);
        bucket.redactedValues += 1;
        bucket.keptOutOfModelValues += 1;
      }
      for (const hit of event.survivingHits) {
        const bucket = labelBucket(buckets, hit);
        bucket.requestKeys.add(request);
        bucket.survivingValues += 1;
        if (event.blocked) {
          bucket.blockedRequestKeys.add(request);
          bucket.keptOutOfModelValues += 1;
        }
      }
    }
    return [...buckets.values()].map(freezeLabelBucket).sort(compareBuckets);
  }
}

export function renderProtectionStatsSummary(snapshot: ProtectionStatsSnapshot): string {
  const total = snapshot.totals.keptOutOfModelValues;
  const lines = [`🔒 ficta — kept ${total} ${plural(total, "protected value")} out of the model this session`];
  if (snapshot.totals.events === 0) return `${lines.join("\n")}\n`;

  const blocked = snapshot.totals.blockedRequests > 0 ? `, blocked ${snapshot.totals.blockedRequests}` : "";
  lines.push(`   affected requests: ${snapshot.totals.affectedRequests}${blocked}`);

  const modelLine = formatTopBuckets(
    snapshot.byModel.filter((bucket) => bucket.name !== "unknown"),
    3,
  );
  if (modelLine) lines.push(`   by model: ${modelLine}`);

  const surfaceLine = formatTopBuckets(snapshot.bySurface, 3);
  if (surfaceLine) lines.push(`   by surface: ${surfaceLine}`);

  const labelLine = formatTopBuckets(snapshot.byLabel, 3);
  if (labelLine) lines.push(`   top labels: ${labelLine}`);

  lines.push(`   stats: ${snapshot.path}`);
  return `${lines.join("\n")}\n`;
}

function newMutableBucket(name: string): MutableBucket {
  return {
    name,
    requestKeys: new Set<string>(),
    redactedValues: 0,
    survivingValues: 0,
    blockedRequestKeys: new Set<string>(),
    keptOutOfModelValues: 0,
  };
}

function addEventToBucket(bucket: MutableBucket, event: ProtectionStatsEvent): void {
  const request = requestKey(event);
  bucket.requestKeys.add(request);
  bucket.redactedValues += event.redactedValues;
  bucket.survivingValues += event.survivingValues;
  bucket.keptOutOfModelValues += keptOutValues(event);
  if (event.blocked) bucket.blockedRequestKeys.add(request);
}

function freezeBucket(bucket: MutableBucket): ProtectionStatsBucket {
  return {
    name: bucket.name,
    requests: bucket.requestKeys.size,
    redactedValues: bucket.redactedValues,
    survivingValues: bucket.survivingValues,
    blockedRequests: bucket.blockedRequestKeys.size,
    keptOutOfModelValues: bucket.keptOutOfModelValues,
  };
}

function labelBucket(buckets: Map<string, MutableLabelBucket>, hit: ProtectionHit): MutableLabelBucket {
  const source = hit.source || "unknown";
  const name = hit.name || "<unknown>";
  const key = JSON.stringify([name, source, hit.plugin ?? "", hit.kind ?? "", hit.confidence ?? ""]);
  const existing = buckets.get(key);
  if (existing) return existing;
  const bucket: MutableLabelBucket = { ...newMutableBucket(name), source };
  if (hit.plugin) bucket.plugin = hit.plugin;
  if (hit.kind) bucket.kind = hit.kind;
  if (hit.confidence) bucket.confidence = hit.confidence;
  buckets.set(key, bucket);
  return bucket;
}

function freezeLabelBucket(bucket: MutableLabelBucket): ProtectionStatsLabelBucket {
  const frozen = freezeBucket(bucket);
  const out: ProtectionStatsLabelBucket = { ...frozen, source: bucket.source };
  if (bucket.plugin) out.plugin = bucket.plugin;
  if (bucket.kind) out.kind = bucket.kind;
  if (bucket.confidence) out.confidence = bucket.confidence;
  return out;
}

function compareBuckets(a: ProtectionStatsBucket, b: ProtectionStatsBucket): number {
  return (
    b.keptOutOfModelValues - a.keptOutOfModelValues ||
    b.redactedValues - a.redactedValues ||
    a.name.localeCompare(b.name)
  );
}

function keptOutValues(event: ProtectionStatsEvent): number {
  return event.redactedValues + (event.blocked ? event.survivingValues : 0);
}

function requestKey(event: ProtectionStatsEvent): string {
  return event.requestId === undefined ? `event:${event.index}` : `request:${event.requestId}`;
}

function normalizeModel(model: string | undefined): string {
  const value = model?.trim();
  if (!value) return "unknown";
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

function formatTopBuckets(buckets: readonly ProtectionStatsBucket[], max: number): string {
  return buckets
    .slice(0, max)
    .map((bucket) => `${bucket.name} ${bucket.keptOutOfModelValues}`)
    .join(", ");
}
