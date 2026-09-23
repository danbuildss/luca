import type { Context } from 'telegraf';
import { formatQualityReport } from '../../quality/report.js';
import type { AuthedUser } from '../auth.js';

export async function handleQuality(ctx: Context, user: AuthedUser): Promise<void> {
  await ctx.reply('Running quality check…');
  try {
    const report = await formatQualityReport(user.userId);
    await ctx.reply(report, { parse_mode: 'Markdown' });
  } catch (err) {
    throw err;
  }
}
