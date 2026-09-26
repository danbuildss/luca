// Starts the bot's long polling and keeps it running when another copy of the bot is
// polling with the same token (Telegram answers 409 Conflict). Instead of exiting, which
// made systemd restart the bot every few seconds and stopped alert delivery in between,
// it waits and tries again, and tells the admins once if the conflict lasts. Any other
// launch error still ends the process, so a bad token or config stays loud.

export const FIRST_RETRY_MS = 30_000;
export const MAX_RETRY_MS = 5 * 60_000;
// A conflict this long is reported to the admins
export const NOTIFY_AFTER_MS = 2 * 60_000;
// At most one admin message per this long, whatever happens
export const NOTIFY_EVERY_MS = 6 * 60 * 60_000;
// Polling this long without a conflict means the other copy is gone
export const STABLE_AFTER_MS = 60_000;

export const CONFLICT_MESSAGE = [
  'Luca cannot receive messages right now',
  'Another copy of the bot is running with the same bot token, so replies are coming from that copy. Stop it, or revoke the token in BotFather and put the new one in the server\'s .env, then restart luca-telegram.',
].join('\n');

export function isPollingConflict(err: unknown): boolean {
  const e = err as { response?: { error_code?: number }; code?: number } | null;
  return e?.response?.error_code === 409 || e?.code === 409;
}

export type LaunchDeps = {
  // Starts polling; resolves when polling stops, rejects when Telegram refuses it
  launch: () => Promise<void>;
  notifyAdmins: (text: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  // Runs `fn` after `ms` unless cancelled; returns the cancel function
  schedule: (fn: () => void, ms: number) => () => void;
  now: () => number;
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
  // True once the process is shutting down: no more retries
  stopping?: () => boolean;
};

export async function launchWithRetry(deps: LaunchDeps): Promise<void> {
  let conflictSince: number | null = null;
  let retries = 0;
  let notifiedThisConflict = false;
  let lastNotifiedAt = -Infinity;

  for (;;) {
    // Once polling has run a minute without a conflict, the conflict is over
    const cancelStable = deps.schedule(() => {
      if (conflictSince === null) return;
      deps.log.info({ conflict_ms: deps.now() - conflictSince }, 'Bot connected; conflict with another copy resolved');
      conflictSince = null;
      retries = 0;
      notifiedThisConflict = false;
    }, STABLE_AFTER_MS);

    try {
      await deps.launch();
      cancelStable();
      return;
    } catch (err) {
      cancelStable();
      if (!isPollingConflict(err) || deps.stopping?.()) throw err;

      const now = deps.now();
      conflictSince ??= now;
      const delay = Math.min(FIRST_RETRY_MS * 2 ** retries, MAX_RETRY_MS);
      retries++;
      deps.log.warn(
        { retry_in_s: delay / 1000, conflict_s: Math.round((now - conflictSince) / 1000) },
        `Another copy of the Luca bot is using this token; retrying in ${delay / 1000}s`,
      );

      if (!notifiedThisConflict && now - conflictSince >= NOTIFY_AFTER_MS && now - lastNotifiedAt >= NOTIFY_EVERY_MS) {
        notifiedThisConflict = true;
        lastNotifiedAt = now;
        try {
          await deps.notifyAdmins(CONFLICT_MESSAGE);
        } catch (notifyErr) {
          deps.log.warn({ err: notifyErr }, 'Could not tell admins about the bot conflict');
        }
      }

      await deps.sleep(delay);
      if (deps.stopping?.()) return;
    }
  }
}
