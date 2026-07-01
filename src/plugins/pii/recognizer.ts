import type { DetectTextContext, ProtectedValue } from "../types.js";

/**
 * The detection-backend seam. A recognizer finds PII spans in a chunk of text and returns them as
 * {@link ProtectedValue}s (`kind: "pii"`); it does not tokenize or restore — the engine/vault own
 * that. This is the swap point behind the (forthcoming) PII detector plugin: an in-process regex
 * recognizer, an out-of-process Presidio/NER sidecar, or a cloud PII service (AWS Comprehend, Azure)
 * are interchangeable implementations of this one interface.
 *
 * Contract:
 * - `detect` MUST be side-effect free and MUST NOT log or return anything but the matched values.
 * - It MAY be async (a sidecar call); the engine awaits it on the request path.
 * - Best-effort by nature: recognizers miss things. Detection is a reduction, never a guarantee.
 */
export interface PiiRecognizer {
  /** Stable, safe label for diagnostics (e.g. "regex", "presidio"). Never contains a value. */
  readonly name: string;
  /** Find PII in `text`; return one ProtectedValue per distinct span found (empty if none). */
  detect(text: string, ctx: DetectTextContext): ProtectedValue[] | Promise<ProtectedValue[]>;
}
