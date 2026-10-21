/**
 * Extracts every number-looking substring from free text and checks
 * whether any is within `tolerance` of `expected`. Deliberately simple
 * (not an LLM judge) -- this suite asserts on structured tool-call data
 * wherever possible; this is the one place a check has to read prose, for
 * the "answer correctness" category. An LLM-graded check would also cost
 * extra credits per case per run, compounding with the N-runs-per-case
 * harness.
 */
export function replyContainsNumberNear(
  text: string,
  expected: number,
  tolerance: number
): boolean {
  const matches = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return matches.some((m) => Math.abs(Number(m) - expected) <= tolerance);
}
