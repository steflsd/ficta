import { memo } from "react";
import { Streamdown } from "streamdown";

/**
 * The markdown seam. Streamdown renders GFM markdown and gracefully tolerates the unterminated
 * blocks that appear mid-stream (open code fences, half-written tables), with syntax-highlighted,
 * copyable code blocks built in. Swap the dependency here without touching callers.
 */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return <Streamdown className="max-w-none space-y-3 text-[0.95rem] leading-relaxed">{content}</Streamdown>;
});
