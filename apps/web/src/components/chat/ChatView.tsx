import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MODELS, type ModelChoice } from "@/lib/models";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { MessageList } from "./MessageList";
import { TopBar } from "./TopBar";

/**
 * Owns the single conversation: the useChat client, the composer input, and the model choice. This is
 * the seam a future persistence/sidebar layer wraps — it can hydrate a thread via setMessages and
 * start a new one via clear() without any component below needing to change.
 */
export function ChatView() {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<ModelChoice>(MODELS[0]);

  const { messages, sendMessage, isLoading, error, stop, reload, clear } = useChat({
    connection: fetchServerSentEvents("/api/chat"),
    forwardedProps: { provider: model.provider, model: model.model },
  });

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    sendMessage(trimmed);
    setInput("");
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <TopBar
          model={model}
          onModelChange={setModel}
          onNewChat={clear}
          busy={isLoading}
          canReset={messages.length > 0}
        />

        <MessageList messages={messages} isLoading={isLoading} onRegenerate={reload} onPickSuggestion={send} />

        {error ? (
          <div className="px-4 pb-2">
            <ErrorBanner message={error.message} onRetry={isLoading ? undefined : reload} />
          </div>
        ) : null}

        <Composer value={input} onChange={setInput} onSubmit={() => send(input)} onStop={stop} isLoading={isLoading} />
      </div>
    </TooltipProvider>
  );
}
