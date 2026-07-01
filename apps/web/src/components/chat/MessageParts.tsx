import type { UIMessage } from "@tanstack/ai-react";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Markdown } from "./Markdown";

type Part = UIMessage["parts"][number];

/** Renders the parts of one assistant/user turn. Text streams through markdown; reasoning collapses;
 * tool calls get a minimal chip (they aren't exercised yet, but the union includes them). */
export function MessageParts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((part, i) => {
        switch (part.type) {
          case "text":
            // biome-ignore lint/suspicious/noArrayIndexKey: streamed parts are append-only, index is stable
            return <Markdown key={i} content={part.content} />;
          case "thinking":
            // biome-ignore lint/suspicious/noArrayIndexKey: streamed parts are append-only, index is stable
            return <Reasoning key={i} content={part.content} />;
          case "tool-call":
            return (
              <div
                key={part.id}
                className="my-1 inline-flex items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground"
              >
                <span className="font-mono">{part.name}</span>
                <span className="opacity-70">{part.state}</span>
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function Reasoning({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        Reasoning
      </button>
      {open ? (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3 text-muted-foreground">{content}</div>
      ) : null}
    </div>
  );
}
