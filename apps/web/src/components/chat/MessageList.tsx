import type { UIMessage } from "@tanstack/ai-react";
import { useEffect, useRef } from "react";
import { EmptyState } from "./EmptyState";
import { MessageBubble } from "./MessageBubble";

export function MessageList({
  messages,
  isLoading,
  onRegenerate,
  onPickSuggestion,
}: {
  messages: UIMessage[];
  isLoading: boolean;
  onRegenerate: () => void;
  onPickSuggestion: (prompt: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastIndex = messages.length - 1;

  // Follow the stream only while the user is already parked near the bottom; if they scrolled up to
  // read, don't yank the viewport back down.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run as content grows during streaming
  useEffect(() => {
    if (!stick.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
          <EmptyState onPick={onPickSuggestion} />
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6" aria-live="polite" aria-busy={isLoading}>
        {messages.map((message, i) => {
          const isLast = i === lastIndex;
          const streaming = isLoading && isLast && message.role === "assistant";
          const canRegen = isLast && message.role === "assistant" && !isLoading;
          return (
            <MessageBubble
              key={message.id}
              message={message}
              streaming={streaming}
              onRegenerate={canRegen ? onRegenerate : undefined}
              canRegenerate={canRegen}
            />
          );
        })}
      </div>
    </div>
  );
}
