// Write tools — all others are read-only
const WRITE_TOOLS = new Set(['apply_correction', 'register_wallet']);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

// Ensure every tool call includes userId in its args before execution.
// This is a final safety check — executeTool already scopes to userId,
// but this makes the invariant explicit at the call boundary.
export function assertUserScoped(userId: string): void {
  if (!userId || typeof userId !== 'string' || userId.length < 10) {
    throw new Error('Tool call rejected: invalid userId');
  }
}
