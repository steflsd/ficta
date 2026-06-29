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
import { surrogateKeyWarning } from "./vault.js";
import { wireOf } from "./wire.js";

export interface ProxyHandle {
  port: number;
  protectedValues: number;
  registry: PluginDiscovery[];
  policyExcluded: number;
  policyExcludedBySource: Record<string, number>;
  registryPolicy: RegistryPolicy;
  keptCount: () => number;
  close: () => void;
}

/** Start the redaction proxy. Returns the bound port + a handle to close it. */
export async function startProxy(opts: { port?: number; plugins?: readonly FictaPlugin[] } = {}): Promise<ProxyHandle> {
  const cfg = loadConfig();
  const engine = new ProtectionEngine({ plugins: opts.plugins });
  const app = new Hono();
  let kept = 0;

  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    if (url.pathname === HEALTH_PATH) return c.json({ ok: true, service: "ficta" });

    // Protect every outbound request body, query string, and non-auth header by default.
    // Provider/client paths change, and an "unknown" route can still carry conversation/tool
    // content; exact-match redaction is safe.
    const protect = engine.enabled;

    let searchToSend = url.search;
    if (protect && searchToSend) {
      const { search: redactedSearch, count, leaks } = redactQueryString(engine, url);
      if (leaks > 0 && cfg.failClosed) return blockedLeakResponse(c, cfg, "query string", leaks);
      if (count > 0) {
        kept += count;
        searchToSend = redactedSearch;
      }
    }

    const { url: target, note: route } = resolveTarget(cfg, url.pathname, searchToSend, c.req.raw.headers);
    const upstreamIssue = upstreamPolicyIssue(cfg, target);
    if (upstreamIssue) {
      return c.json({ error: { type: "ficta_upstream_policy", message: upstreamIssue } }, 403);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("accept-encoding");

    const method = c.req.method;
    let bodyToSend: string | undefined;
    let n: number;

    if (method !== "GET" && method !== "HEAD") {
      const bodyText = await c.req.raw.text();
      n = logRequest({ method, path: url.pathname, body: bodyText, target, route });

      if (protect) {
        const { body: redacted, count, leaks } = engine.redactBody(bodyText, { path: url.pathname });
        if (leaks > 0 && cfg.failClosed) return blockedLeakResponse(c, cfg, "body", leaks, n);
        if (count > 0) {
          kept += count;
          if (!cfg.silent) {
            const warn = leaks > 0 ? `  ⚠ ${leaks} LEAKED (fail-open)` : "";
            console.log(`🔒 ficta #${n} — kept ${count} body value(s) out of the model${warn}`);
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
    }

    if (protect) {
      const { count, leaks } = redactNonAuthHeaders(engine, headers);
      if (leaks > 0 && cfg.failClosed) return blockedLeakResponse(c, cfg, "headers", leaks, n);
      if (count > 0) {
        kept += count;
        if (!cfg.silent) {
          const warn = leaks > 0 ? `  ⚠ ${leaks} LEAKED (fail-open)` : "";
          console.log(`🔒 ficta #${n} — kept ${count} non-auth header value(s) out of the model${warn}`);
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
    const restoreResponse = protect && isRestorableContentType(contentType);

    if (upstreamRes.body) {
      const [toClient, toLog] = upstreamRes.body.tee();
      void logResponse({ n, path: url.pathname, status: upstreamRes.status, contentType, stream: toLog });
      if (!restoreResponse) {
        return new Response(toClient, { status: upstreamRes.status, headers: resHeaders });
      }
      if (isEventStreamContentType(contentType)) {
        // The per-wire adapter reassembles surrogates split across SSE events; an unrecognized wire
        // uses the NOOP adapter, which still restores whole surrogates in each event JSON-safely
        // (see Vault.restoreSseRecord). Cross-event reassembly needs a known wire schema, so it is
        // intentionally not attempted here.
        return new Response(toClient.pipeThrough(engine.restoreEventStream(wireOf(url.pathname))), {
          status: upstreamRes.status,
          headers: resHeaders,
        });
      }
      if (isJsonContentType(contentType)) {
        // Buffer + JSON-aware restore so a restored value with JSON-special chars stays escaped.
        // Non-streaming JSON bodies are bounded, so giving up streaming here costs nothing.
        const text = await new Response(toClient).text();
        return new Response(restoreBufferedBody(engine, contentType, text), {
          status: upstreamRes.status,
          headers: resHeaders,
        });
      }
      return new Response(toClient.pipeThrough(engine.restoreStream()), {
        status: upstreamRes.status,
        headers: resHeaders,
      });
    }

    const body = await upstreamRes.text();
    void logResponse({ n, path: url.pathname, status: upstreamRes.status, contentType, body });
    const restoredBody = restoreResponse ? restoreBufferedBody(engine, contentType, body) : body;
    return new Response(restoredBody, { status: upstreamRes.status, headers: resHeaders });
  });

  return new Promise<ProxyHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? cfg.port, hostname: "127.0.0.1" }, (info) => {
      if (!cfg.silent) {
        const keyWarning = surrogateKeyWarning();
        console.log(`\n  ficta — protection proxy`);
        console.log(`  listening      http://127.0.0.1:${info.port}`);
        console.log(`  anthropic ⇒    ${cfg.upstreams.anthropic}`);
        console.log(`  openai    ⇒    ${cfg.upstreams.openai}`);
        console.log(`  chatgpt   ⇒    ${cfg.upstreams.chatgpt}  (Codex OAuth)`);
        console.log(
          `  vault          ${engine.size} known value(s)  ${engine.enabled ? "🔒 redacting up, restoring back" : "⚠ NONE loaded — passthrough"}`,
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
        console.log(`    ANTHROPIC_BASE_URL=http://127.0.0.1:${info.port} claude`);
        console.log(`    (or use the wrapper:  ficta claude  /  ficta codex  /  ficta pi)\n`);
      }
      resolve({
        port: info.port,
        protectedValues: engine.size,
        registry: engine.registry.discoveries,
        policyExcluded: engine.registry.policyExcluded,
        policyExcludedBySource: engine.registry.policyExcludedBySource,
        registryPolicy: engine.registry.registryPolicy,
        keptCount: () => kept,
        close: () => server.close(),
      });
    });
  });
}

const HEALTH_PATH = "/__ficta/health";
const REQUIRED_AUTH_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie"]);

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
function restoreBufferedBody(engine: ProtectionEngine, contentType: string, body: string): string {
  return isJsonContentType(contentType) ? engine.restoreJson(body) : engine.restoreText(body);
}

/**
 * Redact registered values from a query string. URL.search is percent-encoded, so a stored
 * plaintext value (e.g. one containing a space or `/`) only matches once each parameter is decoded;
 * we decode per parameter to redact, but re-encode only the parameters we actually changed and keep
 * every other parameter's wire bytes verbatim — re-encoding the whole query would normalize the
 * encoding of untouched, possibly signature-sensitive parameters.
 */
function redactQueryString(engine: ProtectionEngine, url: URL): { search: string; count: number; leaks: number } {
  const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (!raw) return { search: url.search, count: 0, leaks: 0 };

  let count = 0;
  let leaks = 0;
  const segments = raw.split("&").map((segment) => {
    const eq = segment.indexOf("=");
    const rawKey = eq === -1 ? segment : segment.slice(0, eq);
    const rawValue = eq === -1 ? undefined : segment.slice(eq + 1);

    const redactedKey = engine.redactText(decodeQueryComponent(rawKey), { path: url.pathname });
    count += redactedKey.count;
    leaks += redactedKey.leaks;
    const outKey = redactedKey.count > 0 ? encodeURIComponent(redactedKey.text) : rawKey;

    if (rawValue === undefined) return outKey;

    const redactedValue = engine.redactText(decodeQueryComponent(rawValue), { path: url.pathname });
    count += redactedValue.count;
    leaks += redactedValue.leaks;
    const outValue = redactedValue.count > 0 ? encodeURIComponent(redactedValue.text) : rawValue;

    return `${outKey}=${outValue}`;
  });

  return { search: `?${segments.join("&")}`, count, leaks };
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

function redactNonAuthHeaders(engine: ProtectionEngine, headers: Headers): { count: number; leaks: number } {
  let count = 0;
  let leaks = 0;
  for (const [name, value] of [...headers]) {
    if (REQUIRED_AUTH_HEADER_NAMES.has(name.toLowerCase())) continue;
    const redacted = engine.redactText(value, { header: name });
    if (redacted.count > 0) {
      headers.set(name, redacted.text);
      count += redacted.count;
    }
    leaks += redacted.leaks;
  }
  return { count, leaks };
}

// Run directly (`tsx src/server.ts`, `pnpm dev`) → start with the banner.
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();
if (isMain) void startProxy();
