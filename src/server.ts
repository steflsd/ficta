import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig, resolveTarget, upstreamPolicyIssue } from "./config.js";
import { ProtectionEngine } from "./engine.js";
import { logRequest, logResponse, runDir } from "./log.js";
import { type FictaPlugin, type PluginDiscovery, registryDiscoveryLines } from "./plugins/index.js";
import { surrogateKeyWarning } from "./vault.js";
import { wireOf } from "./wire.js";

export interface ProxyHandle {
  port: number;
  protectedValues: number;
  registry: PluginDiscovery[];
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
      const { text: redactedSearch, count, leaks } = engine.redactText(searchToSend, { path: url.pathname });
      if (leaks > 0 && cfg.failClosed) {
        return c.json(
          {
            error: {
              type: "ficta_blocked",
              message: `ficta refused to forward: ${leaks} registered value(s) would have reached the model query string`,
            },
          },
          403,
        );
      }
      if (count > 0) kept += count;
      searchToSend = redactedSearch;
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
        if (leaks > 0 && cfg.failClosed) {
          if (!cfg.silent) {
            console.error(
              `🛑 ficta #${n} BLOCKED — ${leaks} registered value(s) survived body redaction; refusing to forward`,
            );
          }
          return c.json(
            {
              error: {
                type: "ficta_blocked",
                message: `ficta refused to forward: ${leaks} registered value(s) would have reached the model body`,
              },
            },
            403,
          );
        }
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
      if (leaks > 0 && cfg.failClosed) {
        if (!cfg.silent) {
          console.error(
            `🛑 ficta #${n} BLOCKED — ${leaks} registered value(s) survived header redaction; refusing to forward`,
          );
        }
        return c.json(
          {
            error: {
              type: "ficta_blocked",
              message: `ficta refused to forward: ${leaks} registered value(s) would have reached model headers`,
            },
          },
          403,
        );
      }
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
    const contentType = resHeaders.get("content-type") ?? "";
    const restoreResponse = protect && isRestorableContentType(contentType);

    if (upstreamRes.body) {
      const [toClient, toLog] = upstreamRes.body.tee();
      void logResponse({ n, path: url.pathname, status: upstreamRes.status, contentType, stream: toLog });
      const out = restoreResponse
        ? toClient.pipeThrough(
            isEventStreamContentType(contentType)
              ? engine.restoreEventStream(wireOf(url.pathname))
              : engine.restoreStream(),
          )
        : toClient;
      return new Response(out, { status: upstreamRes.status, headers: resHeaders });
    }

    const body = await upstreamRes.text();
    void logResponse({ n, path: url.pathname, status: upstreamRes.status, contentType, body });
    return new Response(restoreResponse ? engine.restoreText(body) : body, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
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
        for (const line of registryDiscoveryLines(engine.registry.discoveries, "    ")) console.log(line);
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
