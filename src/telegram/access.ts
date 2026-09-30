import type { AuthedUser } from './auth.js';
import { resolveTelegramUser } from './onboarding.js';

// Who may use the bot, and what someone is told on first contact and on /start.

export const NOT_INVITED_MSG =
  "Luca is in private beta and you're not on the invite list yet. Message @danbuildss to request access.";
export const REVOKED_MSG =
  'Your Luca beta access has been turned off. Message @danbuildss if you think this is a mistake.';
export const WELCOME_MSG = [
  "Welcome to Luca. You're in.",
  '',
  "Send me the Base wallet address you'd like me to watch. I read ETH, USDC and BNKR on Base, and I'll start keeping your books.",
  '',
  'After that, just ask me anything: how the month went, what you hold, or what a payment was for.',
].join('\n');
const INTRO_MSG = [
  "Hi, I'm Luca. I keep the books on your on-chain wallets.",
  '',
  "Just talk to me. Ask how the last month looked, what you hold, or what a payment was for, and tell me when I've labeled something wrong.",
  '',
  "If you haven't yet, send me the wallet address you'd like me to watch.",
].join('\n');
const ADMIN_LINE = 'Admin: /ops, /invite @user, /revoke @user, /quality, /goldset';

// The parts of a Telegraf context used here
export type AccessContext = {
  from?: { id: number; username?: string };
  callbackQuery?: unknown;
  reply(text: string): Promise<unknown>;
  answerCbQuery(text?: string): Promise<unknown>;
};

export type ActiveUser = AuthedUser & { justJoined: boolean };

// Resolves the sender to a user, signing up invited beta testers on first contact.
// Replies with the refusal itself, so callers just return on null. Someone who just
// joined is welcomed here unless the caller says it will greet them itself.
export async function requireUser(
  ctx: AccessContext,
  opts: { welcome?: boolean; resolve?: typeof resolveTelegramUser } = {},
): Promise<ActiveUser | null> {
  const from = ctx.from;
  if (!from) return null;
  const access = await (opts.resolve ?? resolveTelegramUser)({ id: from.id, username: from.username });
  if (access.status === 'ok') {
    if (access.created && opts.welcome !== false) await ctx.reply(WELCOME_MSG);
    return { ...access.user, justJoined: access.created };
  }
  const msg = access.status === 'revoked' ? REVOKED_MSG : NOT_INVITED_MSG;
  if (ctx.callbackQuery) await ctx.answerCbQuery(msg);
  else await ctx.reply(msg);
  return null;
}

// /start: one message. The welcome for someone who just joined, the intro for anyone else.
export function startText(user: Pick<ActiveUser, 'justJoined' | 'role'>): string {
  const text = user.justJoined ? WELCOME_MSG : INTRO_MSG;
  return user.role === 'admin' ? `${text}\n\n${ADMIN_LINE}` : text;
}

export async function handleStart(ctx: AccessContext, resolve?: typeof resolveTelegramUser): Promise<void> {
  const user = await requireUser(ctx, { welcome: false, resolve });
  if (!user) return;
  await ctx.reply(startText(user));
}
