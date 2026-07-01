import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { type Config, loadConfig, resolveTarget, upstreamPolicyIssue } from "./config.js";
import { ProtectionEngine } from "./engine.js";
import { logRequest, logResponse, runDir } from "./log.js";
import {
  type FictaPlugin,
  type PluginDiscovery,
  type RegistryPolicy,
  registryDiscoveryLines,
  registryPolicyLines,
} from "./plugins/index.js";
import { ProtectionStats, type ProtectionStatsSnapshot, type ProtectionSurface } from "./protection-stats.js";
import type { ProtectionHit, RedactionEngine, RequestScope } from "./redaction-engine.js";
import { surrogateKeyWarning } from "./vault.js";
import { type Wire, wireOf } from "./wire.js";

export interface ProxyHandle {
  port: number;
  protectedValues: number;
  registry: PluginDiscovery[];
  policyExcluded: number;
  policyExcludedBySource: Record<string, number>;
  registryPolicy: RegistryPolicy;
  keptCount: () => number;
  protectionStats: () => ProtectionStatsSnapshot;
  statsSummary: () => string;
  close: () => void;
}

/** Start the redaction proxy. Returns the bound port + a handle to close it. */
export async function startProxy(
  opts: { host?: string; port?: number; plugins?: readonly FictaPlugin[] } = {},
): Promise<ProxyHandle> {
  const cfg = loadConfig();
  const engine: RedactionEngine = new ProtectionEngine({ plugins: opts.plugins });
  const stats = new ProtectionStats(runDir);
  const app = new Hono();

  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    if (url.pathname === HEALTH_PATH) return c.json({ ok: true, service: "ficta" });

    // Protect every outbound request body, query string, and non-auth header by default.
    // Provider/client paths change, and an "unknown" route can still carry conversation/tool
    // content; exact-match redaction is safe.
    const protect = engine.protecting;
    const method = c.req.method;
    const wire = wireOf(url.pathname);

    // One ephemeral scope for this request: registered secrets (the permanent layer) are shared, but
    // any PII detected while redacting this request lives only in this scope and is consulted only
    // for this request's restore. The scope is dropped when the handler returns, so detected values
    // are bounded and can never be restored into another request's response. `scopeKeyFrom` is the
    // seam for a future session/org-keyed persistent vault; it returns undefined today.
    const scope = engine.beginRequest(scopeKeyFrom(c));

    let searchToSend = url.search;
    let queryRedaction: SurfaceRedaction | undefined;
    if (protect && searchToSend) {
      const { search: redactedSearch, ...redaction } = await redactQueryString(scope, url);
      queryRedaction = redaction;
      if (redaction.leaks > 0 && cfg.failClosed) {
        recordProtection(stats, scope, {
          method,
          path: url.pathname,
          wire,
          surface: "query string",
          redaction,
          blocked: true,
        });
        return blockedLeakResponse(c, cfg, "query string", redaction.leaks);
      }
      if (redaction.count > 0) searchToSend = redactedSearch;
    }

    const { url: target, note: route } = resolveTarget(cfg, url.pathname, searchToSend, c.req.raw.headers);
    const upstreamIssue = upstreamPolicyIssue(cfg, target);
    if (upstreamIssue) {
      if (queryRedaction) {
        recordProtection(stats, scope, {
          method,
          path: url.pathname,
          wire,
          route,
          surface: "query string",
          redaction: queryRedaction,
          blocked: false,
        });
      }
      return c.json({ error: { type: "ficta_upstream_policy", message: upstreamIssue } }, 403);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("accept-encoding");

    let bodyToSend: string | undefined;
    let n: number;
    let requestModel = "unknown";

    if (method !== "GET" && method !== "HEAD") {
      const bodyText = await c.req.raw.text();
      const originalModel = requestModelFromBody(bodyText);
      n = logRequest({ method, path: url.pathname, body: bodyText, target, route });

      if (protect) {
        const redaction = await scope.redactBodyDetailed(bodyText, { path: url.pathname });
        const redacted = redaction.body;
        requestModel = safeRequestModel(scope, originalModel, requestModelFromBody(redacted));
        if (queryRedaction) {
          recordProtection(stats, scope, {
            requestId: n,
            method,
            path: url.pathname,
            wire,
            route,
            model: requestModel,
            surface: "query string",
            redaction: queryRedaction,
            blocked: false,
          });
        }
        if (redaction.leaks > 0 && cfg.failClosed) {
          recordProtection(stats, scope, {
            requestId: n,
            method,
            path: url.pathname,
            wire,
            route,
            model: requestModel,
            surface: "body",
            redaction,
            blocked: true,
          });
          return blockedLeakResponse(c, cfg, "body", redaction.leaks, n);
        }
        if (redaction.count > 0 || redaction.leaks > 0) {
          recordProtection(stats, scope, {
            requestId: n,
            method,
            path: url.pathname,
            wire,
            route,
            model: requestModel,
            surface: "body",
            redaction,
            blocked: false,
          });
          if (redaction.count > 0 && !cfg.silent) {
            const warn = redaction.leaks > 0 ? `  ⚠ ${redaction.leaks} LEAKED (fail-open)` : "";
            console.log(`🔒 ficta #${n} — kept ${redaction.count} body value(s) out of the model${warn}`);
          }
        }
        bodyToSend = redacted;
        if (cfg.logBodies)
          writeFileSync(join(runDir, `req-${String(n).padStart(4, "0")}.sent.json`), redacted, { mode: 0o600 });
      } else {
        bodyToSend = bodyText;
      }
    } else {
      n = logRequest({ method, path: url.pathname, body: "", target, route });
      if (queryRedaction) {
        recordProtection(stats, scope, {
          requestId: n,
          method,
          path: url.pathname,
          wire,
          route,
          surface: "query string",
          redaction: queryRedaction,
          blocked: false,
        });
      }
    }

    if (protect) {
      const redaction = await redactNonAuthHeaders(scope, headers);
      if (redaction.leaks > 0 && cfg.failClosed) {
        recordProtection(stats, scope, {
          requestId: n,
          method,
          path: url.pathname,
          wire,
          route,
          model: requestModel,
          surface: "non-auth headers",
          redaction,
          blocked: true,
        });
        return blockedLeakResponse(c, cfg, "headers", redaction.leaks, n);
      }
      if (redaction.count > 0 || redaction.leaks > 0) {
        recordProtection(stats, scope, {
          requestId: n,
          method,
          path: url.pathname,
          wire,
          route,
          model: requestModel,
          surface: "non-auth headers",
          redaction,
          blocked: false,
        });
        if (redaction.count > 0 && !cfg.silent) {
          const warn = redaction.leaks > 0 ? `  ⚠ ${redaction.leaks} LEAKED (fail-open)` : "";
          console.log(`🔒 ficta #${n} — kept ${redaction.count} non-auth header value(s) out of the model${warn}`);
        }
      }
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(target, { method, headers, body: bodyToSend });
    } catch (err) {
      if (!cfg.silent) console.error(`✗ #${n} upstream fetch failed:`, (err as Error).message);
      return c.json({ error: { type: "ficta_upstream_error", message: String(err) } }, 502);
    }

    const resHeaders = new Headers(upstreamRes.headers);
    resHeaders.delete("content-encoding");
    resHeaders.delete("content-length");
    // We always re-frame the body (stream restore or buffered JSON restore), so the upstream's
    // framing header must not survive: a buffered restore sets Content-Length, which is illegal
    // alongside a forwarded Transfer-Encoding: chunked.
    resHeaders.delete("transfer-encoding");
    const contentType = resHeaders.get("content-type") ?? "";
    // Some upstreams stream SSE with no content-type header — notably the ChatGPT/Codex backend
    // (`/backend-api/codex/responses`). When the type is missing but the request is a known model
    // wire, the response is that wire's event stream, so restore it instead of passing surrogates
    // through verbatim (which would leak FICTA_ placeholders into the agent's output).
    const treatAsEventStream = isEventStreamContentType(contentType) || (contentType === "" && wire !== "unknown");
    const restoreResponse = protect && (isRestorableContentType(contentType) || treatAsEventStream);

    // Symmetric with the `🔒 … kept N` egress line: report how many distinct values were restored
    // back into this response. Restore is a streaming rewrite, so for streamed bodies this fires from
    // the tap's flush once the stream closes (i.e. after the `← #N` line); for buffered bodies it
    // fires inline the moment restore has run. Zero restores (the common case) stay quiet.
    const logRestore = () => {
      const restored = scope.restoredCount;
      if (restored > 0 && !cfg.silent) {
        console.log(`♻️ ficta #${n} — restored ${restored} value(s) in response`);
      }
    };

    if (upstreamRes.body) {
      const [toClient, toLog] = upstreamRes.body.tee();
      void logResponse({ n, path: url.pathname, status: upstreamRes.status, contentType, stream: toLog });
      if (!restoreResponse) {
        return new Response(toClient, { status: upstreamRes.status, headers: resHeaders });
      }
      if (treatAsEventStream) {
        // The per-wire adapter reassembles surrogates split across SSE events; an unrecognized wire
        // uses the NOOP adapter, which still restores whole surrogates in each event JSON-safely
        // (see Vault.restoreSseRecord). Cross-event reassembly needs a known wire schema, so it is
        // intentionally not attempted here.
        return new Response(
          toClient.pipeThrough(scope.restoreEventStream(wire)).pipeThrough(tapStreamFlush(logRestore)),
          {
            status: upstreamRes.status,
            headers: resHeaders,
          },
        );
      }
      if (isJsonContentType(contentType)) {
        // Buffer + JSON-aware restore so a restored value with JSON-special chars stays escaped.
        // Non-streaming JSON bodies are bounded, so giving up streaming here costs nothing.
        const text = await new Response(toClient).text();
        const restored = restoreBufferedBody(scope, contentType, text);
        logRestore();
        return new Response(restored, {
          status: upstreamRes.status,
          headers: resHeaders,
        });
      }
      return new Response(toClient.pipeThrough(scope.restoreStream()).pipeThrough(tapStreamFlush(logRestore)), {
        status: upstreamRes.status,
        headers: resHeaders,
      });
    }

    const body = await upstreamRes.text();
    void logResponse({ n, path: url.pathname, status: upstreamRes.status, contentType, body });
    const restoredBody = restoreResponse ? restoreBufferedBody(scope, contentType, body) : body;
    if (restoreResponse) logRestore();
    return new Response(restoredBody, { status: upstreamRes.status, headers: resHeaders });
  });

  const bindHost = opts.host ?? cfg.host;
  // Clients dial in over loopback even when we bind a wildcard host, so the copy-paste instructions
  // should say 127.0.0.1, not 0.0.0.0/::. Only substitute for wildcard binds; a specific LAN IP is
  // the address a client would actually use.
  const clientHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
  return new Promise<ProxyHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? cfg.port, hostname: bindHost }, (info) => {
      if (!cfg.silent) {
        const keyWarning = surrogateKeyWarning();
        console.log(`\n  ficta — protection proxy`);
        console.log(`  listening      http://${bindHost}:${info.port}`);
        console.log(`  anthropic ⇒    ${cfg.upstreams.anthropic}`);
        console.log(`  openai    ⇒    ${cfg.upstreams.openai}`);
        console.log(`  chatgpt   ⇒    ${cfg.upstreams.chatgpt}  (Codex OAuth)`);
        console.log(
          `  vault          ${engine.size} known value(s)  ${engine.protecting ? "🔒 redacting up, restoring back" : "⚠ NONE loaded — passthrough"}`,
        );
        console.log(`  registry`);
        for (const line of registryDiscoveryLines(
          engine.registry.discoveries,
          "    ",
          engine.registry.policyExcludedBySource,
        )) {
          console.log(line);
        }
        const policyLines = registryPolicyLines(engine.registry.registryPolicy, "    ");
        if (policyLines.length > 0) {
          console.log(`  registry policy exclusions`);
          for (const line of policyLines) console.log(line);
        }
        if (keyWarning) console.log(`  key warning    ${keyWarning}`);
        console.log(`  fail-closed    ${cfg.failClosed ? "on" : "OFF (fail-open)"}`);
        console.log(`  run logs       ${runDir}${cfg.logBodies ? "  ⚠ raw bodies on" : ""}\n`);
        console.log(`  point a client at it:`);
        console.log(`    ANTHROPIC_BASE_URL=http://${clientHost}:${info.port} claude`);
        console.log(`    (or use the wrapper:  ficta claude  /  ficta codex  /  ficta pi)\n`);
      }
      resolve({
        port: info.port,
        protectedValues: engine.size,
        registry: engine.registry.discoveries,
        policyExcluded: engine.registry.policyExcluded,
        policyExcludedBySource: engine.registry.policyExcludedBySource,
        registryPolicy: engine.registry.registryPolicy,
        keptCount: () => stats.snapshot().totals.keptOutOfModelValues,
        protectionStats: () => stats.snapshot(),
        statsSummary: () => stats.renderSummary(),
        close: () => {
          server.close();
          // server.close() stops accepting new connections but leaves idle keep-alive
          // sockets open, which keeps the event loop alive and stalls shutdown. Drop them
          // so the process can exit promptly instead of being force-killed.
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        },
      });
    });
  });
}

/**
 * The scope-key seam. Today every request gets an isolated in-memory ephemeral scope, so this
 * returns `undefined` (no shared/persistent vault). It is the single place a future session- or
 * org-derived key (from auth, a header, or a cookie) would be extracted to select a persistent,
 * shared vault — without touching the request path. Intentionally ignores `c` for now.
 */
function scopeKeyFrom(_c: Context): string | undefined {
  return undefined;
}

const HEALTH_PATH = "/__ficta/health";
const REQUIRED_AUTH_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie"]);
const SURROGATE_RE = /FICTA_[0-9a-f]{32}/;

interface SurfaceRedaction {
  count: number;
  leaks: number;
  hits: ProtectionHit[];
  leakHits: ProtectionHit[];
}

interface QueryRedaction extends SurfaceRedaction {
  search: string;
}

function isRestorableContentType(contentType: string): boolean {
  const type = contentTypeBase(contentType);
  return type.startsWith("text/") || type.includes("json") || type.includes("event-stream");
}

function isEventStreamContentType(contentType: string): boolean {
  return contentTypeBase(contentType) === "text/event-stream";
}

function isJsonContentType(contentType: string): boolean {
  const base = contentTypeBase(contentType);
  // Stream-framed JSON (newline-delimited / json-seq) is not a single JSON document — buffering it
  // would defeat streaming and JSON.parse would fail, so it must fall through to the stream restore.
  if (base.includes("ndjson") || base.includes("json-seq") || base.includes("jsonl")) return false;
  return base === "application/json" || base.endsWith("+json");
}

/** Restore a fully-buffered body by content type: JSON-aware where possible, raw text otherwise. */
function restoreBufferedBody(scope: RequestScope, contentType: string, body: string): string {
  return isJsonContentType(contentType) ? scope.restoreJson(body) : scope.restoreText(body);
}

/**
 * A pass-through stream whose `flush` runs once the upstream (restore) transform has fully drained.
 * Appended after a streaming restore so the final restored-value count can be logged: the count is
 * only settled when the stream closes, which is after the restore transform's own flush has emitted
 * its last rewritten chunk.
 */
function tapStreamFlush(onFlush: () => void): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    flush() {
      onFlush();
    },
  });
}

/**
 * Redact registered values from a query string. URL.search is percent-encoded, so a stored
 * plaintext value (e.g. one containing a space or `/`) only matches once each parameter is decoded;
 * we decode per parameter to redact, but re-encode only the parameters we actually changed and keep
 * every other parameter's wire bytes verbatim — re-encoding the whole query would normalize the
 * encoding of untouched, possibly signature-sensitive parameters.
 */
async function redactQueryString(scope: RequestScope, url: URL): Promise<QueryRedaction> {
  const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (!raw) return { search: url.search, count: 0, leaks: 0, hits: [], leakHits: [] };

  const total = emptyRedaction();
  // Sequential (not Promise.all): parameters are few, and detection may hit a sidecar — keeping the
  // shared `total` mutations ordered avoids any interleaving surprises.
  const segments: string[] = [];
  for (const segment of raw.split("&")) {
    const eq = segment.indexOf("=");
    const rawKey = eq === -1 ? segment : segment.slice(0, eq);
    const rawValue = eq === -1 ? undefined : segment.slice(eq + 1);

    const redactedKey = await scope.redactTextDetailed(decodeQueryComponent(rawKey), { path: url.pathname });
    addRedaction(total, redactedKey);
    const outKey = redactedKey.count > 0 ? encodeURIComponent(redactedKey.text) : rawKey;

    if (rawValue === undefined) {
      segments.push(outKey);
      continue;
    }

    const redactedValue = await scope.redactTextDetailed(decodeQueryComponent(rawValue), { path: url.pathname });
    addRedaction(total, redactedValue);
    const outValue = redactedValue.count > 0 ? encodeURIComponent(redactedValue.text) : rawValue;

    segments.push(`${outKey}=${outValue}`);
  }

  return { search: `?${segments.join("&")}`, ...total };
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** Single fail-closed 403 builder so the query/body/header surfaces stay in lockstep. */
function blockedLeakResponse(c: Context, cfg: Config, surface: string, leaks: number, n?: number): Response {
  if (!cfg.silent) {
    const id = n === undefined ? "" : ` #${n}`;
    console.error(
      `🛑 ficta${id} BLOCKED — ${leaks} registered value(s) survived ${surface} redaction; refusing to forward`,
    );
  }
  return c.json(
    {
      error: {
        type: "ficta_blocked",
        message: `ficta refused to forward: ${leaks} registered value(s) would have reached the model ${surface}`,
      },
    },
    403,
  );
}

function contentTypeBase(contentType: string): string {
  return contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}

async function redactNonAuthHeaders(scope: RequestScope, headers: Headers): Promise<SurfaceRedaction> {
  const total = emptyRedaction();
  for (const [name, value] of [...headers]) {
    if (REQUIRED_AUTH_HEADER_NAMES.has(name.toLowerCase())) continue;
    const redacted = await scope.redactTextDetailed(value, { header: name, surface: "header" });
    if (redacted.count > 0) headers.set(name, redacted.text);
    addRedaction(total, redacted);
  }
  return total;
}

function emptyRedaction(): SurfaceRedaction {
  return { count: 0, leaks: 0, hits: [], leakHits: [] };
}

function addRedaction(
  total: SurfaceRedaction,
  redaction: { count: number; leaks: number; hits: ProtectionHit[]; leakHits: ProtectionHit[] },
): void {
  total.count += redaction.count;
  total.leaks += redaction.leaks;
  total.hits.push(...redaction.hits);
  total.leakHits.push(...redaction.leakHits);
}

function recordProtection(
  stats: ProtectionStats,
  scope: RequestScope,
  args: {
    requestId?: number;
    method: string;
    path: string;
    wire: Wire;
    route?: string;
    model?: string;
    surface: ProtectionSurface;
    redaction: SurfaceRedaction;
    blocked: boolean;
  },
): void {
  stats.record({
    requestId: args.requestId,
    method: args.method,
    path: safeStatsMetadata(scope, args.path, "<redacted-path>"),
    wire: args.wire,
    route: args.route,
    model: args.model,
    surface: args.surface,
    redactedValues: args.redaction.count,
    survivingValues: args.redaction.leaks,
    blocked: args.blocked,
    redactedHits: args.redaction.hits,
    survivingHits: args.redaction.leakHits,
  });
}

function requestModelFromBody(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const value = JSON.parse(body)?.model;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  } catch {
    // Non-JSON or malformed request body: no safe model metadata to extract.
  }
  return undefined;
}

function safeRequestModel(scope: RequestScope, original: string | undefined, redacted: string | undefined): string {
  const candidate = redacted ?? original;
  if (!candidate) return "unknown";
  if (original && scope.containsProtectedValue(original)) return "<redacted>";
  if (redacted && SURROGATE_RE.test(redacted)) return "<redacted>";
  if (original && redacted && original !== redacted) return "<redacted>";
  return candidate;
}

function safeStatsMetadata(scope: RequestScope, value: string | undefined, fallback: string): string {
  const text = value?.trim();
  if (!text) return fallback;
  return scope.containsProtectedValue(text) || SURROGATE_RE.test(text) ? fallback : text;
}

// Run directly (`tsx src/server.ts`, `pnpm dev`) → start with the banner.
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();
if (isMain) {
  const handle = await startProxy();
  // Run directly (pnpm dev / node --watch), the proxy IS the process — nothing else drives
  // shutdown. Without these handlers the listening socket keeps the event loop alive, so the
  // process ignores SIGINT/SIGTERM and a supervisor (node --watch, turbo) has to force-kill it.
  // Close the server and exit so Ctrl+C, `turbo run dev` teardown, and watch restarts all
  // shut down cleanly.
  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
