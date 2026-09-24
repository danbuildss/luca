import type { Context } from 'telegraf';
import { formatQualityReport } from '../../quality/report.js';
import type { AuthedUser } from '../auth.js';
import { replyMarkdownSafe } from '../format.js';

export async function handleQuality(ctx: Context, user: AuthedUser): Promise<void> {
  await ctx.reply('Running quality check…');
  const report = await formatQualityReport(user.userId);
  // Report contains labels like internal_transfer and may exceed 4096 chars.
  await replyMarkdownSafe(ctx, report);
}
