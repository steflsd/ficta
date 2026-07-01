import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/")({
  component: ChatPage,
});

// Any model / bring-your-own-key: the choice is forwarded to /api/chat, which builds the matching
// TanStack AI adapter. Every model call still flows through the ficta proxy (see api/chat.ts).
const MODELS = [
  { provider: "openai", model: "gpt-4o", label: "OpenAI · gpt-4o" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Anthropic · claude-sonnet-4-6" },
] as const;

function ChatPage() {
  const [input, setInput] = useState("");
  const [choice, setChoice] = useState<(typeof MODELS)[number]>(MODELS[0]);

  const { messages, sendMessage, isLoading, error, stop } = useChat({
    connection: fetchServerSentEvents("/api/chat"),
    forwardedProps: { provider: choice.provider, model: choice.model },
  });

  const submit = () => {
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput("");
  };

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1>ficta chat</h1>
      <label>
        Model:{" "}
        <select
          value={choice.label}
          onChange={(e) => setChoice(MODELS.find((m) => m.label === e.target.value) ?? MODELS[0])}
        >
          {MODELS.map((m) => (
            <option key={m.label} value={m.label}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <div style={{ margin: "16px 0", display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.map((message) => (
          <div key={message.id}>
            <strong>{message.role}: </strong>
            {message.parts.map((part, i) =>
              part.type === "text" ? <span key={i}>{part.content}</span> : null,
            )}
          </div>
        ))}
      </div>

      {error ? (
        <p role="alert" style={{ color: "crimson" }}>
          {error.message}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={{ flex: 1 }}
          value={input}
          placeholder="Paste a document or ask a question…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={isLoading}
        />
        {isLoading ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </main>
  );
}
