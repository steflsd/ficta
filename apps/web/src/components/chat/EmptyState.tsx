import { ShieldCheck } from "lucide-react";

const SUGGESTIONS = [
  "Summarize this contract and flag unusual clauses.",
  "Draft a reply to opposing counsel declining the extension.",
  "Extract every named party and deadline from this document.",
  "Rewrite this paragraph in plain English for a client.",
];

export function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-secondary">
        <ShieldCheck className="size-6 text-emerald-600 dark:text-emerald-400" aria-hidden />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">How can I help?</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Paste a document or ask a question. Sensitive details are redacted before they ever reach the AI provider — and
        restored in the answer.
      </p>
      <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-xl border border-border bg-card p-3 text-left text-sm text-card-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
