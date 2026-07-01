import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { createFileRoute } from "@tanstack/react-router";
import { createModelAdapter, MissingKeyError, type Provider } from "../../lib/model-adapter";

const PROVIDERS: readonly Provider[] = ["openai", "anthropic"];

/**
 * Server route the browser's useChat() talks to. It builds the TanStack AI adapter for the requested
 * provider/model — whose baseURL points at the ficta proxy — and streams the SSE response back. The
 * lawyer's document flows browser → here → ficta (redact) → vendor → ficta (restore) → here → browser.
 *
 * The SSE client (`fetchServerSentEvents`) throws on any non-2xx response, surfacing
 * `HTTP error! status: <code> <statusText>` as the `error` useChat() renders in the ErrorBanner — it
 * never reads the body. So the graceful path here is a non-2xx Response carrying a concise, non-secret
 * reason in `statusText`. Synchronous setup failures (bad JSON, unknown provider, missing server-side
 * key) are the day-one cases and are caught below; without this they'd throw uncaught → an opaque 500.
 */
export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let provider: Provider;
        let model: string;
        let messages: Parameters<typeof chat>[0]["messages"];
        try {
          const body = await request.json();
          provider = body.forwardedProps?.provider ?? "openai";
          model = body.forwardedProps?.model ?? "gpt-5-mini";
          messages = body.messages;
          if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}"`);
          if (!model) throw new Error("no model selected");
        } catch (err) {
          return errorResponse(400, reason(err, "malformed chat request"));
        }

        let stream: ReturnType<typeof chat>;
        try {
          // Adapter creation reads the server-side API key and throws MissingKeyError if unset.
          stream = chat({ adapter: createModelAdapter({ provider, model }), messages });
        } catch (err) {
          if (err instanceof MissingKeyError) return errorResponse(503, err.message);
          return errorResponse(502, reason(err, "could not reach the model via ficta"));
        }

        return toServerSentEventsResponse(stream);
      },
    },
  },
});

/**
 * A non-2xx Response whose reason phrase the SSE client turns into `error.message`. Keep it a single
 * clean ASCII line — HTTP reason phrases forbid CR/LF and can be dropped or mangled under HTTP/2.
 */
function errorResponse(status: number, message: string): Response {
  const statusText = message.replace(/[\r\n]+/g, " ").slice(0, 120);
  return new Response(statusText, { status, statusText });
}

function reason(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : "";
  return message || fallback;
}
