import {
  getHealthSnapshot,
  getMethodErrorRates,
  getCalibrationBuckets,
  getCounterpartyCorrections,
  getLabelPrecision,
  getUnknownDecomposition,
} from './metrics.js';
import { formatAddress } from '../telegram/format.js';

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export async function formatQualityReport(userId: string): Promise<string> {
  const [snapshot, methodRates, calibration, counterpartyClusters, labelPrecision, unknownDecomp] =
    await Promise.all([
      getHealthSnapshot(userId, 7),
      getMethodErrorRates(userId),
      getCalibrationBuckets(userId),
      getCounterpartyCorrections(userId, 2),
      getLabelPrecision(userId),
      getUnknownDecomposition(userId),
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

  // ── Section 6: What to do this week ─────────────────────────────────────
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
