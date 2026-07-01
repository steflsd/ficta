import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { createFileRoute } from "@tanstack/react-router";
import { createModelAdapter, type Provider } from "../../lib/model-adapter";

/**
 * Server route the browser's useChat() talks to. It builds the TanStack AI adapter for the requested
 * provider/model — whose baseURL points at the ficta proxy — and streams the SSE response back. The
 * lawyer's document flows browser → here → ficta (redact) → vendor → ficta (restore) → here → browser.
 */
export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        const provider: Provider = body.forwardedProps?.provider ?? "openai";
        const model: string = body.forwardedProps?.model ?? "gpt-4o";

        const stream = chat({
          adapter: createModelAdapter({ provider, model }),
          messages: body.messages,
        });

        return toServerSentEventsResponse(stream);
      },
    },
  },
});
