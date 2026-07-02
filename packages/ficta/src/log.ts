import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { inspectionLines, inspectJson, inspectSse, inspectText, registeredValueCount } from "./inspection.js";
import { log } from "./logger.js";
import { type Wire, wireOf } from "./wire.js";

const cfg = loadConfig();
// Per-run dir so sessions never mix (seq resets on restart; old files would otherwise bleed in).
export const runDir = join(cfg.logDir, "run-" + new Date().toISOString().replace(/[:.]/g, "-"));
ensurePrivateDir(cfg.logDir);
ensurePrivateDir(runDir);

let seq = 0;

const pad = (n: number) => String(n).padStart(4, "0");
const pretty = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};
const preview = (s: unknown, max: number) => {
  const flat = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
};

export function logRequest(args: {
  method: string;
  path: string;
  body: string;
  target: string;
  route?: string;
}): number {
  const n = ++seq;
  const wire = wireOf(args.path);
  // Unknown (non-model) traffic is the old FICTA_QUIET tier: summarize at debug, model turns at info.
  const level = wire === "unknown" ? "debug" : "info";
  const route = args.route ? ` [${args.route}]` : "";

  let parsed: unknown;
  let parseOk = false;
  if (args.body) {
    try {
      parsed = JSON.parse(args.body);
      parseOk = true;
    } catch {
      /* non-JSON body */
    }
  }

  const inspection = args.body ? (parseOk ? inspectJson(parsed) : inspectText(args.body)) : inspectText("");
  const findings = inspectionLines(inspection);
  log[level](
    {
      reqId: n,
      wire,
      method: args.method,
      path: args.path,
      target: args.target,
      ...(args.route ? { route: args.route } : {}),
      ...(parseOk ? { summary: requestMeta(wire, parsed) } : {}),
      ...(findings.length ? { findings } : {}),
    },
    `→ ${args.method} ${args.path} → ${args.target}${route}`,
  );
  // Raw message/tool content only at trace (the raw-body tier).
  if (cfg.logBodies && parseOk) logRequestBodyPreviews(wire, parsed, n);

  writeMeta("req", n, {
    kind: "request",
    n,
    method: args.method,
    path: args.path,
    target: args.target,
    route: args.route,
    wire,
    bodyBytes: byteLen(args.body),
    bodyLogged: cfg.logBodies,
    registeredValues: registeredValueCount(),
    summary: parseOk ? requestMeta(wire, parsed) : undefined,
    inspection,
  });

  if (args.body && cfg.logBodies) writePrivateFile(join(runDir, `req-${pad(n)}.json`), pretty(args.body));
  return n;
}

export async function logResponse(args: {
  n: number;
  path: string;
  status: number;
  contentType: string;
  stream?: ReadableStream<Uint8Array>;
  body?: string;
}): Promise<void> {
  let raw = args.body ?? "";
  let bodyTruncated = false;
  if (args.stream) {
    const reader = args.stream.getReader();
    const decoder = new TextDecoder();
    let loggedBytes = byteLen(raw);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const remaining = cfg.logMaxBytes - loggedBytes;
        if (remaining <= 0) {
          bodyTruncated = true;
          await reader.cancel();
          break;
        }

        if (value.byteLength > remaining) {
          raw += decoder.decode(value.slice(0, remaining));
          loggedBytes += remaining;
          bodyTruncated = true;
          await reader.cancel();
          break;
        }

        raw += decoder.decode(value, { stream: true });
        loggedBytes += value.byteLength;
      }
      if (!bodyTruncated) raw += decoder.decode();
    } catch {
      /* client may abort — log what we got */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
  }

  const wire = wireOf(args.path);
  const level = wire === "unknown" ? "debug" : "info";
  const isSse = args.contentType.includes("event-stream");
  let parsed: unknown;
  let parseOk = false;
  if (!isSse && raw) {
    try {
      parsed = JSON.parse(raw);
      parseOk = true;
    } catch {
      /* non-JSON */
    }
  }

  const inspection = raw
    ? isSse
      ? inspectSse(raw)
      : parseOk
        ? inspectJson(parsed)
        : inspectText(raw)
    : inspectText("");
  const findings = inspectionLines(inspection);

  log[level](
    {
      reqId: args.n,
      wire,
      status: args.status,
      contentType: args.contentType,
      bytes: raw.length,
      ...(isSse ? { sse: sseMeta(raw) } : parseOk ? { summary: responseMeta(wire, parsed) } : {}),
      ...(findings.length ? { findings } : {}),
    },
    `← ${args.status} ${args.contentType} (${raw.length} bytes)`,
  );
  // Reassembled message/tool content only at trace (the raw-body tier).
  if (cfg.logBodies) {
    if (isSse) {
      const s = summarizeSSE(wire, raw);
      if (s) log.trace({ reqId: args.n }, s);
    } else if (parseOk) {
      logResponseBodyPreviews(wire, parsed, args.n);
    }
  }

  writeMeta("res", args.n, {
    kind: "response",
    n: args.n,
    path: args.path,
    wire,
    status: args.status,
    contentType: args.contentType,
    bodyBytes: byteLen(raw),
    bodyLogged: cfg.logBodies,
    bodyTruncated,
    registeredValues: registeredValueCount(),
    summary: isSse ? { sse: sseMeta(raw) } : parseOk ? responseMeta(wire, parsed) : undefined,
    inspection,
  });

  if (cfg.logBodies && raw) writePrivateFile(join(runDir, `res-${pad(args.n)}.txt`), raw);
}

// ---------------------------------------------------------------- safe metadata sidecars

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function writeMeta(kind: "req" | "res", n: number, meta: unknown): void {
  writePrivateFile(join(runDir, `${kind}-${pad(n)}.meta.json`), JSON.stringify(meta, null, 2));
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
}

function writePrivateFile(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 });
}

function requestMeta(wire: Wire, j: any): Record<string, unknown> {
  const base: Record<string, unknown> = {
    modelSet: isPresent(j?.model),
    stream: safeBooleanish(j?.stream),
    toolCount: Array.isArray(j?.tools) ? j.tools.length : undefined,
  };
  if (wire === "anthropic") {
    return {
      ...base,
      system: Boolean(j?.system),
      messageCount: Array.isArray(j?.messages) ? j.messages.length : undefined,
      toolResultCount: countAnthropicToolResults(j),
    };
  }
  if (wire === "openai-chat") {
    return {
      ...base,
      messageCount: Array.isArray(j?.messages) ? j.messages.length : undefined,
      toolResultCount: Array.isArray(j?.messages)
        ? j.messages.filter((m: any) => m?.role === "tool").length
        : undefined,
    };
  }
  if (wire === "openai-responses") {
    return {
      ...base,
      instructions: Boolean(j?.instructions),
      inputKind: Array.isArray(j?.input) ? "array" : typeof j?.input,
      inputCount: Array.isArray(j?.input) ? j.input.length : undefined,
      functionCallOutputCount: Array.isArray(j?.input)
        ? j.input.filter((it: any) => it?.type === "function_call_output").length
        : undefined,
      functionCallCount: Array.isArray(j?.input)
        ? j.input.filter((it: any) => it?.type === "function_call").length
        : undefined,
    };
  }
  return { keyCount: topLevelKeyCount(j) };
}

function responseMeta(wire: Wire, j: any): Record<string, unknown> {
  if (wire === "anthropic") {
    return {
      contentCount: Array.isArray(j?.content) ? j.content.length : undefined,
      textBlockCount: Array.isArray(j?.content) ? j.content.filter((b: any) => b?.type === "text").length : undefined,
      toolUseCount: Array.isArray(j?.content) ? j.content.filter((b: any) => b?.type === "tool_use").length : undefined,
    };
  }
  if (wire === "openai-chat") {
    return { choiceCount: Array.isArray(j?.choices) ? j.choices.length : undefined };
  }
  if (wire === "openai-responses") {
    return {
      outputCount: Array.isArray(j?.output) ? j.output.length : undefined,
      functionCallCount: Array.isArray(j?.output)
        ? j.output.filter((it: any) => it?.type === "function_call").length
        : undefined,
    };
  }
  return { keyCount: topLevelKeyCount(j) };
}

function isPresent(value: unknown): boolean | undefined {
  return value === undefined ? undefined : true;
}

function safeBooleanish(value: unknown): boolean | "set" | undefined {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : "set";
}

function topLevelKeyCount(value: unknown): number {
  return value && typeof value === "object" ? Object.keys(value).length : 0;
}

function countAnthropicToolResults(j: any): number {
  let n = 0;
  if (!Array.isArray(j?.messages)) return n;
  for (const m of j.messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content) if (block?.type === "tool_result") n++;
  }
  return n;
}

function sseMeta(raw: string): Record<string, unknown> {
  const eventTypes: Record<string, number> = {};
  let dataLineCount = 0;
  let anthropicToolUseStarts = 0;
  let anthropicInputJsonDeltas = 0;
  let openaiResponsesFunctionCallStarts = 0;
  let openaiResponsesFunctionArgDeltas = 0;
  let openaiResponsesTextDeltas = 0;
  let openaiChatToolArgDeltas = 0;

  for (const ev of dataLines(raw)) {
    dataLineCount++;
    if (typeof ev?.type === "string") eventTypes[ev.type] = (eventTypes[ev.type] ?? 0) + 1;
    if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") anthropicToolUseStarts++;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "input_json_delta") anthropicInputJsonDeltas++;
    if (ev?.type === "response.output_item.added" && ev.item?.type === "function_call")
      openaiResponsesFunctionCallStarts++;
    if (ev?.type === "response.function_call_arguments.delta") openaiResponsesFunctionArgDeltas++;
    if (ev?.type === "response.output_text.delta") openaiResponsesTextDeltas++;
    for (const c of ev?.choices ?? []) {
      if (Array.isArray(c?.delta?.tool_calls)) openaiChatToolArgDeltas += c.delta.tool_calls.length;
    }
  }

  return {
    dataLines: dataLineCount,
    eventTypes,
    anthropicToolUseStarts,
    anthropicInputJsonDeltas,
    openaiResponsesFunctionCallStarts,
    openaiResponsesFunctionArgDeltas,
    openaiResponsesTextDeltas,
    openaiChatToolArgDeltas,
  };
}

// ---------------------------------------------------------------- requests

// Raw message/tool content previews for the trace tier. The compact per-request summary (model,
// stream, message/tool counts) rides as structured fields on the → request log via requestMeta().
function logRequestBodyPreviews(wire: Wire, j: any, reqId: number): void {
  if (wire === "anthropic") {
    if (!Array.isArray(j?.messages)) return;
    for (const m of j.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block?.type === "tool_result") {
          const c = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          log.trace({ reqId }, `⤷ tool_result: ${preview(c, 220)}`);
        }
      }
    }
    return;
  }
  if (wire === "openai-chat") {
    if (!Array.isArray(j?.messages)) return;
    for (const m of j.messages) {
      if (m.role === "tool") {
        const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        log.trace({ reqId }, `⤷ tool result: ${preview(c, 220)}`);
      }
      for (const tc of m.tool_calls ?? []) {
        log.trace({ reqId }, `↩ tool_call ${tc.function?.name}: ${preview(tc.function?.arguments, 200)}`);
      }
    }
    return;
  }
  if (wire === "openai-responses") {
    if (typeof j?.input === "string") {
      log.trace({ reqId }, `input: ${preview(j.input, 220)}`);
    } else if (Array.isArray(j?.input)) {
      for (const it of j.input) {
        if (it?.type === "function_call_output") {
          log.trace({ reqId }, `⤷ function_call_output: ${preview(it.output, 220)}`);
        } else if (it?.type === "function_call") {
          log.trace({ reqId }, `↩ function_call ${it.name}: ${preview(it.arguments, 200)}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- responses (JSON)

function logResponseBodyPreviews(wire: Wire, j: any, reqId: number): void {
  if (wire === "anthropic" && Array.isArray(j.content)) {
    for (const block of j.content) {
      if (block?.type === "text") log.trace({ reqId }, `text: ${preview(block.text, 300)}`);
      else if (block?.type === "tool_use")
        log.trace({ reqId }, `tool_use ${block.name}: ${preview(JSON.stringify(block.input ?? {}), 400)}`);
    }
    return;
  }
  if (wire === "openai-chat" && Array.isArray(j.choices)) {
    for (const c of j.choices) {
      const msg = c.message ?? {};
      if (msg.content) log.trace({ reqId }, `text: ${preview(msg.content, 300)}`);
      for (const tc of msg.tool_calls ?? [])
        log.trace({ reqId }, `tool_call ${tc.function?.name}: ${preview(tc.function?.arguments, 400)}`);
    }
    return;
  }
  if (wire === "openai-responses" && Array.isArray(j.output)) {
    for (const it of j.output) {
      if (it?.type === "message")
        for (const part of it.content ?? []) if (part?.text) log.trace({ reqId }, `text: ${preview(part.text, 300)}`);
      if (it?.type === "function_call") log.trace({ reqId }, `function_call ${it.name}: ${preview(it.arguments, 400)}`);
    }
  }
}

// ---------------------------------------------------------------- responses (SSE)

function summarizeSSE(wire: Wire, raw: string): string {
  switch (wire) {
    case "openai-chat":
      return summarizeOpenAIChatSSE(raw);
    case "openai-responses":
      return summarizeOpenAIResponsesSSE(raw);
    case "anthropic":
      return summarizeAnthropicSSE(raw);
    default:
      // unknown: try each, return first that reassembles anything
      return summarizeAnthropicSSE(raw) || summarizeOpenAIResponsesSSE(raw) || summarizeOpenAIChatSSE(raw);
  }
}

function dataLines(raw: string): any[] {
  const out: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* skip */
    }
  }
  return out;
}

function render(text: string, tools: { name?: string; input: string }[]): string {
  if (!cfg.logBodies) return "";

  const parts: string[] = [];
  if (text.trim()) parts.push(`   text: ${preview(text, 300)}`);
  for (const t of tools) parts.push(`   tool_use ${t.name}: ${preview(t.input, 400)}`);
  return parts.join("\n");
}

function summarizeAnthropicSSE(raw: string): string {
  let text = "";
  const tools: { name?: string; input: string }[] = [];
  let cur: { name?: string; input: string } | null = null;
  for (const ev of dataLines(raw)) {
    switch (ev.type) {
      case "content_block_start":
        if (ev.content_block?.type === "tool_use") {
          cur = { name: ev.content_block.name, input: "" };
          tools.push(cur);
        } else cur = null;
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta") text += ev.delta.text ?? "";
        else if (ev.delta?.type === "input_json_delta" && cur) cur.input += ev.delta.partial_json ?? "";
        break;
      case "content_block_stop":
        cur = null;
        break;
    }
  }
  return render(text, tools);
}

function summarizeOpenAIChatSSE(raw: string): string {
  let text = "";
  const byIdx = new Map<number, { name?: string; input: string }>();
  for (const ev of dataLines(raw)) {
    for (const c of ev.choices ?? []) {
      const d = c.delta ?? {};
      if (typeof d.content === "string") text += d.content;
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const t = byIdx.get(idx) ?? { name: "", input: "" };
        byIdx.set(idx, t);
        if (tc.function?.name) t.name = tc.function.name;
        if (tc.function?.arguments) t.input += tc.function.arguments;
      }
    }
  }
  return render(text, [...byIdx.values()]);
}

function summarizeOpenAIResponsesSSE(raw: string): string {
  let text = "";
  const byId = new Map<string, { name?: string; input: string }>();
  for (const ev of dataLines(raw)) {
    switch (ev.type) {
      case "response.output_item.added":
        if (ev.item?.type === "function_call") byId.set(ev.item.id, { name: ev.item.name ?? "", input: "" });
        break;
      case "response.output_text.delta":
        text += ev.delta ?? "";
        break;
      case "response.function_call_arguments.delta": {
        const f = byId.get(ev.item_id) ?? { name: "", input: "" };
        byId.set(ev.item_id, f);
        f.input += ev.delta ?? "";
        break;
      }
    }
  }
  return render(text, [...byId.values()]);
}
