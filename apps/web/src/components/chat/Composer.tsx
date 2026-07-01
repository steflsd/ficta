import { ArrowUp, Square } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isLoading: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: reset then match content, capped so it scrolls past a few lines. `value` isn't read in
  // the body but must stay in deps so the height recomputes on every edit (including programmatic clears).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !isLoading;

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring">
          <textarea
            ref={ref}
            value={value}
            rows={1}
            placeholder="Paste a document or ask a question…"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canSend) onSubmit();
              }
            }}
            className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[0.95rem] leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          {isLoading ? (
            <Button
              size="icon"
              variant="secondary"
              className="size-9 shrink-0 rounded-xl"
              onClick={onStop}
              aria-label="Stop"
            >
              <Square className="size-4 fill-current" aria-hidden />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-9 shrink-0 rounded-xl"
              onClick={onSubmit}
              disabled={!canSend}
              aria-label="Send"
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
          )}
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          ficta redacts sensitive data before it reaches the model. Verify important answers.
        </p>
      </div>
    </div>
  );
}
