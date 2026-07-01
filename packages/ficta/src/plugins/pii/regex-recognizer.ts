import type { ProtectedValue } from "../types.js";
import type { PiiRecognizer } from "./recognizer.js";

interface StructuredPattern {
  /** Safe category label used as the ProtectedValue.name (never the matched value). */
  category: string;
  /** Global regex — matched with String.matchAll (which copies the regex, so reuse is safe). */
  regex: RegExp;
  confidence: ProtectedValue["confidence"];
  /** Optional precision gate applied to each raw match (e.g. Luhn for card numbers). */
  validate?: (match: string) => boolean;
}

// High-precision structured PII only. Format-anchored patterns (and Luhn for cards) keep the
// false-positive rate low; fuzzy categories (names, addresses, orgs) are a NER recognizer's job.
const PATTERNS: readonly StructuredPattern[] = [
  { category: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, confidence: "high" },
  { category: "us-ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g, confidence: "high" },
  // Anchored to start and end on a digit (via `\d(?:[ -]?\d){12,18}`) so a trailing space/hyphen
  // after the number is never pulled into the match; 13-19 digits total.
  { category: "credit-card", regex: /\b\d(?:[ -]?\d){12,18}\b/g, confidence: "high", validate: isLuhnValid },
];

/** In-process, synchronous structured-PII recognizer — the default (always-available) backend. */
export const regexRecognizer: PiiRecognizer = {
  name: "regex",
  detect(text) {
    if (!text) return [];
    const out: ProtectedValue[] = [];
    const seen = new Set<string>();
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern.regex)) {
        const value = match[0];
        if (pattern.validate && !pattern.validate(value)) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        out.push({ name: pattern.category, value, source: "pii-regex", kind: "pii", confidence: pattern.confidence });
      }
    }
    return out;
  },
};

/** Luhn checksum — the precision gate that separates real card numbers from arbitrary digit runs. */
function isLuhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
