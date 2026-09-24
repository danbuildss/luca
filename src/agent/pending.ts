import { randomBytes } from 'crypto';

// In-memory store of write-tool calls awaiting the user's explicit confirmation.
// The agent never executes a write tool directly: it parks the call here and the
// bot shows Confirm / Cancel buttons (callback_data `agentok:<id>` / `agentno:<id>`).
// State is process-local by design — a restart simply drops unconfirmed actions.

export const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

export type PendingAction = {
  id: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
};

export type TakeResult =
  | { status: 'ok'; action: PendingAction }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'forbidden' };

export class PendingActionStore {
  private readonly actions = new Map<string, PendingAction>();

  constructor(
    private readonly ttlMs = PENDING_ACTION_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  create(userId: string, toolName: string, args: Record<string, unknown>): PendingAction {
    this.sweep();
    let id = randomBytes(6).toString('hex');
    while (this.actions.has(id)) id = randomBytes(6).toString('hex');
    const createdAt = this.now();
    const action: PendingAction = {
      id,
      userId,
      toolName,
      args,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.actions.set(id, action);
    return action;
  }

  // Remove and return the action if it exists, is unexpired, and belongs to userId.
  // A mismatched user does NOT consume the action.
  take(id: string, userId: string): TakeResult {
    const action = this.actions.get(id);
    if (!action) return { status: 'not_found' };
    if (action.expiresAt <= this.now()) {
      this.actions.delete(id);
      return { status: 'expired' };
    }
    if (action.userId !== userId) return { status: 'forbidden' };
    this.actions.delete(id);
    return { status: 'ok', action };
  }

  size(): number {
    this.sweep();
    return this.actions.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, a] of this.actions) {
      if (a.expiresAt <= t) this.actions.delete(id);
    }
  }
}

export const pendingActions = new PendingActionStore();

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

// Plain-text (no Markdown) one-line description of a pending action for the confirm prompt.
export function describePendingAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'apply_correction': {
      const hash = str(args.tx_hash);
      const target = hash ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : `${(str(args.event_id) ?? '?').slice(0, 8)}…`;
      const parts = [`Relabel transaction ${target} as "${str(args.new_label) ?? '?'}"`];
      const name = str(args.counterparty_name);
      if (name) parts.push(`and name the counterparty "${name.slice(0, 60)}"`);
      const reason = str(args.reason);
      if (reason) parts.push(`(reason: ${reason.slice(0, 80)})`);
      return parts.join(' ');
    }
    case 'register_wallet': {
      const address = str(args.address) ?? '?';
      const parts = [`Start tracking wallet ${address} on ${str(args.chain) ?? 'base'}`];
      const label = str(args.label);
      if (label) parts.push(`labeled "${label.slice(0, 60)}"`);
      const role = str(args.role);
      if (role) parts.push(`with role ${role}`);
      return parts.join(' ');
    }
    default:
      return `Run ${toolName}`;
  }
}
