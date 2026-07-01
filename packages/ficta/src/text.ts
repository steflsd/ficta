/** Tiny shared formatting helpers for CLI/banner/doctor output. */

export function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}
