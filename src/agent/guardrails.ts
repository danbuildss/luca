// Write tools — all others are read-only
const WRITE_TOOLS = new Set(['apply_correction', 'register_wallet']);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

// Neutralise attacker-influenced free text (counterparty names, wallet labels)
// before it goes into the system prompt: collapse newlines/control chars so it
// can't start a new "section", drop characters used for our <data> delimiters
// and Markdown headings, and cap length.
export function sanitizePromptText(text: string | null | undefined, maxLength = 60): string {
  if (!text) return '';
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ') // U+2028/2029 are covered by \s below
    .replace(/[<>`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// Ensure every tool call includes userId in its args before execution.
// This is a final safety check — executeTool already scopes to userId,
// but this makes the invariant explicit at the call boundary.
export function assertUserScoped(userId: string): void {
  if (!userId || typeof userId !== 'string' || userId.length < 10) {
    throw new Error('Tool call rejected: invalid userId');
  }
}
