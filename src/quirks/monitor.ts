/** Patterns that are never allowed in quirk memory — the immutable trust boundary. */
const BLOCKED_PATTERNS: RegExp[] = [
  /\bskip\s+(?:\S+\s+)*?tests?\b/i,
  /\bdisable\s+(lint|typecheck|strict)/i,
  /\bignore\s+(all\s+)?errors/i,
  /\brm\s+-rf\b/,
  /\bforce\s+push\b/,
  /\bgit\s+push\s+--force\b/,
  /\bdelete\s+.+\.git/i,
  /\btouch\s+(?:\.env|withheld)/i,
  /\bbypass\s+(?:security|review|check)/i,
];

/** Check whether quirk content is allowed within the immutable environment boundary. */
export function isQuirkAllowed(content: string): { ok: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return { ok: false, reason: `Content matches blocked pattern: "${match[0]}"` };
    }
  }
  return { ok: true };
}
