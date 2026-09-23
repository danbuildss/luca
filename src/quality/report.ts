import {
  getHealthSnapshot,
  getMethodErrorRates,
  getCalibrationBuckets,
  getCounterpartyCorrections,
  getLabelPrecision,
  getUnknownDecomposition,
  getWeeklyTrend,
  getGoldSetSummary,
  getFailureReasonBreakdown,
} from './metrics.js';
import { formatAddress } from '../telegram/format.js';

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export async function formatQualityReport(userId: string): Promise<string> {
  const [snapshot, methodRates, calibration, counterpartyClusters, labelPrecision, unknownDecomp, weeklyTrend, goldSummary, failureReasons] =
    await Promise.all([
      getHealthSnapshot(userId, 7),
      getMethodErrorRates(userId),
      getCalibrationBuckets(userId),
      getCounterpartyCorrections(userId, 2),
      getLabelPrecision(userId),
      getUnknownDecomposition(userId),
      getWeeklyTrend(userId, 8),
      getGoldSetSummary(userId),
      getFailureReasonBreakdown(userId),
    ]);

  const lines: string[] = [];

  // ── Section 1: Health Snapshot ──────────────────────────────────────────
  lines.push('📊 *Classification Quality — 7-day snapshot*', '');
  lines.push(`Total classified:  ${snapshot.total_classified}`);
  lines.push(`Unknown:           ${snapshot.unknown_count} (${snapshot.unknown_pct.toFixed(1)}%)`);
  lines.push(`Corrections:       ${snapshot.correction_count} (${snapshot.correction_pct.toFixed(1)}%)`);

  if (snapshot.high_confidence_errors > 0) {
    lines.push(`⚠️ High-conf errors: ${snapshot.high_confidence_errors} — labels trusted but wrong`);
  }
  lines.push('');

  // ── Section 2: Label Precision ───────────────────────────────────────────
  const riskyLabels = labelPrecision.filter((l) => l.precision_proxy < 0.95 && l.false_positives > 0);
  if (riskyLabels.length > 0) {
    lines.push('*🎯 Label precision (where it went wrong)*');
    for (const l of riskyLabels.slice(0, 5)) {
      const star = l.precision_proxy < 0.9 ? '🔴' : '🟡';
      lines.push(
        `${star} ${l.predicted_label.padEnd(18)} ${pct(l.precision_proxy)} accurate  (${l.false_positives} errors / ${l.total} total)`,
      );
    }
    lines.push('');
  }

  // ── Section 3: Method Error Rates ────────────────────────────────────────
  const badMethods = methodRates.filter((m) => m.error_rate > 0);
  if (badMethods.length > 0) {
    lines.push('*🔧 Method error rates (high-confidence only)*');
    for (const m of badMethods) {
      const icon = m.error_rate > 0.1 ? '🔴' : m.error_rate > 0.05 ? '🟡' : '🟢';
      const confLine = m.avg_confidence_at_error
        ? `  avg conf at error: ${m.avg_confidence_at_error.toFixed(2)}`
        : '';
      lines.push(`${icon} ${m.method.padEnd(16)} ${pct(m.error_rate)} error rate${confLine}`);
    }
    lines.push('');
  }

  // ── Section 4: Calibration ───────────────────────────────────────────────
  const badBuckets = calibration.filter(
    (b) => b.total >= 5 && Math.abs(b.avg_confidence - b.observed_accuracy) > 0.15,
  );
  if (badBuckets.length > 0) {
    lines.push('*📐 Confidence calibration gaps*');
    for (const b of badBuckets) {
      const stated = b.avg_confidence.toFixed(2);
      const actual = b.observed_accuracy.toFixed(2);
      const gap = (b.avg_confidence - b.observed_accuracy).toFixed(2);
      lines.push(
        `Bucket ${b.bucket}/10: says ${stated} → actually ${actual}  (gap +${gap}, ${b.total} events)`,
      );
    }
    lines.push('');
  }

  // ── Section 5: Unknown Breakdown ────────────────────────────────────────
  lines.push('*❓ Unknown decomposition*');
  lines.push(`Total unknown now:    ${unknownDecomp.total_unknown}`);
  if (unknownDecomp.classifier_weakness > 0) {
    lines.push(`Classifier weakness:  ${unknownDecomp.classifier_weakness} corrected to labeled  ← fix model`);
  }
  if (unknownDecomp.repeated_counterparties > 0) {
    lines.push(`Missing rules:        ${unknownDecomp.repeated_counterparties} addresses with 3+ unknowns  ← add counterparty rule`);
  }
  lines.push('');

  // ── Section 6: Weekly Trend ─────────────────────────────────────────────
  if (weeklyTrend.length >= 2) {
    lines.push('*📈 Weekly trend (correction rate)*');
    const recent = weeklyTrend.slice(0, 6);
    for (const w of recent) {
      const weekLabel = new Date(w.week_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const corrIcon = w.correction_rate > 0.1 ? '🔴' : w.correction_rate > 0.05 ? '🟡' : '🟢';
      lines.push(
        `${corrIcon} ${weekLabel}  corr ${pct(w.correction_rate)}  unk ${pct(w.unknown_rate)}  (${w.total_classified} total)`,
      );
    }
    lines.push('');
  }

  // ── Section 7: Gold Set Pass Rate ────────────────────────────────────────
  if (goldSummary.length > 0) {
    const totalGold = goldSummary.reduce((s, r) => s + r.total, 0);
    const totalCorrect = goldSummary.reduce((s, r) => s + r.correct, 0);
    const overallPassRate = totalGold > 0 ? totalCorrect / totalGold : 1;
    const passIcon = overallPassRate >= 0.95 ? '✅' : overallPassRate >= 0.85 ? '🟡' : '🔴';
    lines.push(`*🏅 Gold set regression — ${passIcon} ${pct(overallPassRate)} pass (${totalCorrect}/${totalGold})*`);
    const failing = goldSummary.filter((r) => r.pass_rate < 1);
    if (failing.length > 0) {
      for (const r of failing.slice(0, 5)) {
        lines.push(`  ${r.pass_rate < 0.8 ? '🔴' : '🟡'} ${r.correct_label.padEnd(18)} ${pct(r.pass_rate)}  (${r.correct}/${r.total})`);
      }
    }
    lines.push('');
  }

  // ── Section 8: Failure Root Causes ──────────────────────────────────────
  if (failureReasons.length > 0) {
    const REASON_LABEL: Record<string, string> = {
      bad_rule: 'Bad rule',
      missing_counterparty: 'Missing counterparty',
      bad_model_inference: 'Bad model inference',
      missing_protocol: 'Missing protocol',
      bad_data: 'Bad data',
    };
    lines.push('*🔬 Why errors happen*');
    for (const r of failureReasons) {
      const label = REASON_LABEL[r.failure_reason] ?? r.failure_reason;
      lines.push(`  ${label.padEnd(24)} ${r.count}  (${(r.pct * 100).toFixed(0)}%)`);
    }
    lines.push('');
  }

  // ── Section 9: What to do this week ─────────────────────────────────────
  const actions: string[] = [];

  if (counterpartyClusters.length > 0) {
    actions.push(`📝 Add counterparty rules for these repeat offenders:`);
    for (const c of counterpartyClusters.slice(0, 3)) {
      const label = c.most_common_correction ? ` → ${c.most_common_correction}` : '';
      actions.push(`   ${formatAddress(c.counterparty_address)}${label}  (${c.correction_count} corrections)`);
    }
  }

  const deterministicErrors = methodRates.find((m) => m.method === 'deterministic' && m.error_rate > 0.05);
  if (deterministicErrors) {
    actions.push(`🔍 Audit deterministic rules — ${pct(deterministicErrors.error_rate)} error rate is too high for rule-based logic`);
  }

  if (snapshot.high_confidence_errors > 3) {
    actions.push(`🚨 Review ${snapshot.high_confidence_errors} high-confidence errors — these hurt the books`);
  }

  if (actions.length > 0) {
    lines.push('*✅ This week*');
    lines.push(...actions);
  } else {
    lines.push('*✅ Nothing critical — classification quality looks healthy*');
  }

  return lines.join('\n');
}
