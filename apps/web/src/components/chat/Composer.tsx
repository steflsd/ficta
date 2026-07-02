import { AlertTriangle, ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ATTACHMENT_ACCEPT, formatBytes, type TextAttachment } from "@/lib/file-attachments";

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading,
  attachments,
  uploadWarning,
  onFilesSelected,
  onRemoveAttachment,
  onDismissUploadWarning,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isLoading: boolean;
  attachments: TextAttachment[];
  uploadWarning?: string;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onDismissUploadWarning: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow: reset then match content, capped so it scrolls past a few lines. `value` isn't read in
  // the body but must stay in deps so the height recomputes on every edit (including programmatic clears).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !isLoading;

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        {uploadWarning ? (
          <div
            role="alert"
            className="mb-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1">{uploadWarning}</p>
            <button
              type="button"
              className="rounded-md p-0.5 text-amber-900/70 hover:bg-amber-100 hover:text-amber-950 dark:text-amber-100/70 dark:hover:bg-amber-900/40 dark:hover:text-amber-50"
              onClick={onDismissUploadWarning}
              aria-label="Dismiss upload warning"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-secondary-foreground"
                title={attachment.name}
              >
                <FileText className="size-3.5 shrink-0" aria-hidden />
                <span className="max-w-48 truncate">{attachment.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(attachment.size)}</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              if (files.length > 0) onFilesSelected(files);
              e.currentTarget.value = "";
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-9 shrink-0 rounded-xl"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            aria-label="Attach text file"
          >
            <Paperclip className="size-4" aria-hidden />
          </Button>
          <textarea
            ref={ref}
            value={value}
            rows={1}
            placeholder="Paste a document, attach a text file, or ask a question…"
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
              type="button"
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
              type="button"
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
          Text files are inlined so ficta can redact them. PDF/DOCX need extraction first — paste context for now.
        </p>
      </div>
    </div>
  );
}
