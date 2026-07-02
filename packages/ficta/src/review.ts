// `ficta review` (and a setup step) let the user decide what gets redacted by reviewing the
// discovered protected NAMES — never values. Deselecting a name adds it to registry.exclude_names.
// The default posture stays "redact everything discovered"; this is the opt-out surface.
//
// Values ARE read once, in-memory, to compute a heuristic classification (see classify-env.ts) that
// pre-selects a sensible default and adds a reason hint. The classification is a closed union of fixed
// literals: no value text is ever stored on a candidate, rendered, or included in a hint.
import { groupMultiselect, intro, isCancel, note, outro } from "@clack/prompts";
import { classifyEnvCandidate, type EnvClassification } from "./classify-env.js";
import { loadPluginRegistry, type PluginRegistrySnapshot, USER_EXCLUSION_PLUGIN } from "./plugins/index.js";
import { configPath, readUserConfig, writeUserConfig } from "./user-config.js";

export type ReviewCandidateState = "protected" | "user-excluded" | "plugin-excluded" | "stale-excluded";

export interface ReviewCandidate {
  /** Env var name — safe metadata, never the value. */
  name: string;
  /** Sources the name was seen in (e.g. env-file, process-env, doppler). Empty for stale entries. */
  sources: string[];
  state: ReviewCandidateState;
  /** For plugin-excluded: the plugin whose policy drops it. */
  excludedBy?: string;
  /**
   * Heuristic verdict for protected candidates only. Fixed safe strings — never value text. Drives the
   * prompt's default selection and reason hint; absent for excluded/stale candidates.
   */
  classification?: EnvClassification;
}

const STALE_GROUP = "not currently discovered";

/** Names in the user's own exclusion list, per the snapshot's merged policy (valid names only). */
function userExcludeNames(snapshot: PluginRegistrySnapshot): string[] {
  const rule = snapshot.registryPolicy.exclusions.find((r) => r.plugin === USER_EXCLUSION_PLUGIN);
  return rule ? [...rule.names] : [];
}

/**
 * Turn a registry snapshot into reviewable candidates. Reads names/sources/rule metadata plus, for
 * protected candidates, the literal value(s) — only to compute a fixed-enum `classification` (values
 * are never stored on the candidate or rendered). Each name lands in exactly one state — a
 * currently-protected name is in `snapshot.values`; an excluded name is in `policyExcludedValues` (or,
 * if it matched no source, is "stale").
 */
export function collectReviewCandidates(snapshot: PluginRegistrySnapshot): ReviewCandidate[] {
  const byName = new Map<string, ReviewCandidate>();
  const valuesByName = new Map<string, string[]>();

  const mergeSource = (name: string, source: string, state: ReviewCandidateState, excludedBy?: string): void => {
    const existing = byName.get(name);
    if (existing) {
      if (source && !existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    byName.set(name, { name, sources: source ? [source] : [], state, excludedBy });
  };

  for (const value of snapshot.values) {
    mergeSource(value.name, value.source, "protected");
    const bucket = valuesByName.get(value.name) ?? [];
    bucket.push(value.value);
    valuesByName.set(value.name, bucket);
  }

  const userExcluded = new Set<string>();
  for (const dropped of snapshot.policyExcludedValues) {
    if (dropped.rule.plugin === USER_EXCLUSION_PLUGIN) {
      userExcluded.add(dropped.name);
      mergeSource(dropped.name, dropped.source, "user-excluded");
    } else {
      mergeSource(dropped.name, dropped.source, "plugin-excluded", dropped.rule.plugin);
    }
  }

  // Excluded names that matched no loaded source: kept so the user can see and un-exclude them.
  for (const name of userExcludeNames(snapshot)) {
    if (!byName.has(name)) byName.set(name, { name, sources: [], state: "stale-excluded" });
  }

  // Classify only protected candidates — the only ones checked by default and the only ones with a
  // known value. Values are consumed here and never retained on the candidate.
  for (const candidate of byName.values()) {
    if (candidate.state === "protected") {
      candidate.classification = classifyEnvCandidate(candidate.name, valuesByName.get(candidate.name) ?? []);
    }
  }

  return [...byName.values()].sort(
    (a, b) => (a.sources[0] ?? STALE_GROUP).localeCompare(b.sources[0] ?? STALE_GROUP) || a.name.localeCompare(b.name),
  );
}

/** Candidates the user can toggle (everything except plugin-owned exclusions, which are fixed). */
function toggleable(candidates: readonly ReviewCandidate[]): ReviewCandidate[] {
  return candidates.filter((c) => c.state !== "plugin-excluded");
}

/**
 * Compute the next exclude-names list from the review selection. `selectedNames` are the names the
 * user chose to keep protecting; anything toggleable left unselected becomes excluded. Plugin-excluded
 * names are never added (they aren't the user's to own). Result is sorted and deduped.
 */
export function nextExcludeNames(
  candidates: readonly ReviewCandidate[],
  selectedNames: ReadonlySet<string>,
  currentExcludes: readonly string[],
): string[] {
  const next = new Set(currentExcludes);
  for (const candidate of toggleable(candidates)) {
    if (selectedNames.has(candidate.name)) next.delete(candidate.name);
    else next.add(candidate.name);
  }
  return [...next].sort();
}

/** Protected names whose value/name looks non-secret; these start unchecked. */
function likelyNonSecret(candidate: ReviewCandidate): boolean {
  return candidate.state === "protected" && candidate.classification?.verdict === "likely-non-secret";
}

/**
 * Names to pre-select (= keep protecting): every protected candidate except those the classifier
 * flagged as likely non-secret. Exported so the default can be tested without the prompt.
 */
export function initialSelection(candidates: readonly ReviewCandidate[]): string[] {
  return candidates.filter((c) => c.state === "protected" && !likelyNonSecret(c)).map((c) => c.name);
}

function hintFor(candidate: ReviewCandidate): string | undefined {
  const parts: string[] = [];
  if (likelyNonSecret(candidate) && candidate.classification?.reason) {
    parts.push(`probably not a secret — ${candidate.classification.reason}`);
  }
  if (candidate.state === "user-excluded") parts.push("currently excluded");
  if (candidate.state === "stale-excluded") parts.push("excluded; not currently discovered");
  if (candidate.sources.length > 1) parts.push(`also: ${candidate.sources.slice(1).join(", ")}`);
  return parts.length ? parts.join("; ") : undefined;
}

/**
 * Show the grouped picker (names only, grouped by source) and return the set of names the user kept
 * selected (= keep protecting). Returns undefined if the user cancels. Never renders values.
 */
export async function promptReviewSelection(candidates: readonly ReviewCandidate[]): Promise<Set<string> | undefined> {
  const pluginExcluded = candidates.filter((c) => c.state === "plugin-excluded");
  if (pluginExcluded.length > 0) {
    const names = pluginExcluded.map((c) => `${c.name} (${c.excludedBy})`).join(", ");
    note(`Excluded by a provider policy (not selectable): ${names}`, "Provider exclusions");
  }

  const items = toggleable(candidates);
  const initialValues = initialSelection(candidates);
  const selected = new Set(initialValues);

  const autoDeselected = items.filter(likelyNonSecret).length;
  if (autoDeselected > 0) {
    note(
      `${autoDeselected} name(s) look like non-secrets and start unchecked — re-check any you still want redacted.`,
      "Suggested",
    );
  }

  const options: Record<string, Array<{ value: string; label: string; hint?: string }>> = {};
  for (const candidate of items) {
    const group = candidate.sources[0] ?? STALE_GROUP;
    const bucket = options[group] ?? [];
    options[group] = bucket;
    bucket.push({ value: candidate.name, label: candidate.name, hint: hintFor(candidate) });
  }
  // Within each source group, keep checked names on top so the auto-deselected block is contiguous.
  for (const bucket of Object.values(options)) {
    bucket.sort(
      (a, b) => Number(selected.has(b.value)) - Number(selected.has(a.value)) || a.label.localeCompare(b.label),
    );
  }

  const result = await groupMultiselect<string>({
    message: "Keep protecting these? Deselect any name that should NOT be redacted.",
    options,
    initialValues,
    required: false,
    selectableGroups: false,
  });
  if (isCancel(result)) return undefined;
  return new Set(result as string[]);
}

/**
 * Load the registry with the current process env, run the review, and return the new
 * FICTA_REGISTRY_EXCLUDE_NAMES value: a comma-joined string, "" to clear the key, or undefined when
 * the user cancelled or there was nothing to review.
 */
export async function reviewExcludeNamesInteractively(): Promise<string | undefined> {
  const snapshot = loadPluginRegistry();
  const candidates = collectReviewCandidates(snapshot);
  if (toggleable(candidates).length === 0) {
    note("No protected names discovered yet — nothing to review.", "Redaction review");
    return undefined;
  }
  const selected = await promptReviewSelection(candidates);
  if (selected === undefined) return undefined;
  const next = nextExcludeNames(candidates, selected, userExcludeNames(snapshot));
  return next.length > 0 ? next.join(",") : "";
}

/** Standalone `ficta review`: review discovered names and persist exclude_names to the config file. */
export async function runReview(): Promise<void> {
  const path = configPath();
  if (!path) {
    note(
      "FICTA_CONFIG_FILE=0 disables persistent config. Unset it, or set FICTA_CONFIG_FILE=/path/to/config.toml, then rerun.",
      "No config file target",
    );
    outro("review cancelled");
    process.exit(2);
  }

  intro("ficta review");
  const result = await reviewExcludeNamesInteractively();
  if (result === undefined) {
    outro("no changes");
    return;
  }

  const values = readUserConfig(path);
  if (result === "") {
    delete values.FICTA_REGISTRY_EXCLUDE_NAMES;
    delete process.env.FICTA_REGISTRY_EXCLUDE_NAMES;
  } else {
    values.FICTA_REGISTRY_EXCLUDE_NAMES = result;
    process.env.FICTA_REGISTRY_EXCLUDE_NAMES = result;
  }
  writeUserConfig(values, path);
  note(path, "Wrote config");

  const count = result === "" ? 0 : result.split(",").length;
  note(
    count === 0
      ? "no names excluded — all discovered values are protected"
      : `${count} name(s) excluded from protection`,
    "Redaction review",
  );
  outro("ficta review complete");
}
