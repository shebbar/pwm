import { timingSafeEqual } from "node:crypto";

/** Constant-time token comparison -- length mismatch is checked first since
 *  timingSafeEqual throws (rather than returning false) on unequal-length
 *  buffers, and a token's length isn't itself a meaningful secret. Shared
 *  by mcp-server.ts and the /api/actions bearer check in routes/api.ts --
 *  two separate trust boundaries with two separate tokens, same comparison
 *  logic. */
export function safeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
