import { query } from '../db.js';
import { txLink } from '../ledger/links.js';
import { usdDisplay } from '../books/breakdown.js';

// The canonical classification-quality baseline: how often Luca's labels were confirmed,
// corrected or left unknown, and whether corrections teach it. Read-only. Definitions:
//
// Evidence is an operator decision: a label the operator set (classifications.source =
// 'user': a correction, an answer to Luca's question, a confirmed change in chat). What
// it is compared with is Luca's label on that transfer just before the decision:
//   - Luca had a real label  -> a reviewed prediction: confirmed (same label) or corrected
//   - Luca had no label / unknown / a failed attempt -> an unknown answered (not an error)
//   - the operator's own earlier label -> the operator changed their mind (not counted)
// "Not corrected" never means "correct": transfers nobody reviewed are counted as
// unreviewed, and every percentage is reviewed precision, based on N reviewed decisions.
//
// Two clocks:
//   - Activity (when the transfer happened): movements, still unknown, unreviewed.
//   - Decision (when the operator decided, whatever the transfer's date): confirmed,
//     corrected, unknowns answered, high-confidence wrong, reviewed precision, rules learned.
// Learned-rule performance is counted since each rule was learned (all time).
//
// The gold set (gold_transactions) is a curated evaluation set, reported on its own and
// never mixed into live review numbers. All operators together are summed from raw
// counts, never averaged percentages.

export const HIGH_CONFIDENCE = 0.9;
export const MIN_SAMPLE = 5;
export const HCW_WARN_RATE = 0.05;
export const PRECISION_WARN_RATE = 0.8;

export type Rate = { num: number; den: number; rate: number | null };  // rate null: too few to judge
const rate = (num: number, den: number): Rate => ({ num, den, rate: den >= MIN_SAMPLE ? num / den : null });

export type Mistake = { hash: string; luca: string; operator: string; confidence: number; decided_at: Date };

export type QualityBaseline = {
  scope: { userId: string | null; days: number };
  activity: { movements: number; still_unknown: number; still_unknown_usd: number; unreviewed: number; unknown_rate: Rate };
  decisions: {
    reviewed: number; confirmed: number; corrected: number; unknown_answered: number; operator_revisions: number;
    correction_rate: Rate;
    high_confidence: Rate & { mistakes: Mistake[] };
    by_label: Array<{ label: string; reviewed: number; confirmed: number; precision: Rate; actually: Record<string, number> }>;
    internal: { wrongly_internal: number; missed_internal: number };
    rules_learned: number;         // rules that can take effect
    rules_learned_inert: number;   // rules for addresses Luca does not book
  };
  rules: {
    rules: number; inert: number; matched: number; reviewed: number; confirmed: number; corrected: number; unreviewed: number;
    precision: Rate;
    repeated_mistakes: Array<{ hash: string; luca: string; taught: string }>;
  };
  gold: { examples: number; matching: number; rate: Rate };
  warnings: string[];
};

const COUNTERPARTY = (a: string): string => `LOWER(CASE WHEN ${a}.direction = 'in' THEN ${a}.from_address ELSE ${a}.to_address END)`;

// A rule can only take effect for an address Luca books transfers with, in its direction.
// Rules for addresses whose transfers Luca does not book (for example labels given to
// spam-token transfers before Luca tracked only ETH, USDC and BNKR) can never label
// anything; they are reported separately and not counted as learned rules.
const EFFECTIVE = (r: string): string => `EXISTS (
  SELECT 1 FROM normalized_events be
  WHERE be.user_id = ${r}.user_id AND be.supported IS TRUE
    AND ${COUNTERPARTY('be')} = LOWER(${r}.address)
    AND (${r}.direction IS NULL OR be.direction = ${r}.direction))`;

// Every operator decision with Luca's label just before it. $1 = user (NULL: everyone)
const DECISIONS = `
  SELECT u.id AS decision_id, u.user_id, u.event_id, u.label::text AS answer, u.created_at AS decided_at, ne.hash,
         ne.block_time, p.label::text AS prior_label, p.confidence::float AS prior_confidence, p.source AS prior_source,
         p.rule_id AS prior_rule_id,
         CASE
           WHEN p.id IS NULL OR p.source = 'failure' OR p.label = 'unknown' THEN 'unknown_answered'
           WHEN p.source = 'user' THEN 'operator_revision'
           WHEN p.label = u.label THEN 'confirmed'
           ELSE 'corrected'
         END AS outcome
  FROM classifications u
  JOIN normalized_events ne ON ne.id = u.event_id AND ne.supported IS TRUE
  LEFT JOIN LATERAL (
    SELECT p.* FROM classifications p
    WHERE p.event_id = u.event_id AND p.id <> u.id AND p.created_at < u.created_at
    ORDER BY p.created_at DESC LIMIT 1
  ) p ON TRUE
  WHERE u.source = 'user' AND ($1::uuid IS NULL OR u.user_id = $1)`;

type DecisionRow = {
  hash: string; answer: string; decided_at: Date; prior_label: string | null; prior_confidence: number | null;
  outcome: 'unknown_answered' | 'operator_revision' | 'confirmed' | 'corrected';
};

export async function getQualityBaseline(p: { userId: string | null; days: number }): Promise<QualityBaseline> {
  const scope = [p.userId, p.days];

  const [activity, decisions, rulesLearned, rules, repeated, gold] = await Promise.all([
    // Activity clock: transfers that happened in the period
    query<{ movements: number; still_unknown: number; still_unknown_usd: string | null; unreviewed: number }>(
      `SELECT COUNT(*)::int AS movements,
              COUNT(*) FILTER (WHERE c.id IS NULL OR c.label = 'unknown')::int AS still_unknown,
              SUM(ne.usd_value) FILTER (WHERE c.id IS NULL OR c.label = 'unknown')::text AS still_unknown_usd,
              COUNT(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM classifications o WHERE o.event_id = ne.id AND o.source = 'user'))::int AS unreviewed
       FROM normalized_events ne
       LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.supported IS TRUE AND ($1::uuid IS NULL OR ne.user_id = $1)
         AND ne.block_time >= NOW() - INTERVAL '1 day' * $2`,
      scope,
    ),
    // Decision clock: what operators decided in the period
    query<DecisionRow>(`SELECT * FROM (${DECISIONS}) d WHERE d.decided_at >= NOW() - INTERVAL '1 day' * $2 ORDER BY d.decided_at DESC`, scope),
    query<{ n: number; inert: number }>(
      `SELECT COUNT(*) FILTER (WHERE ${EFFECTIVE('r')})::int AS n,
              COUNT(*) FILTER (WHERE NOT ${EFFECTIVE('r')})::int AS inert
       FROM counterparty_rules r
       WHERE ($1::uuid IS NULL OR r.user_id = $1) AND r.created_at >= NOW() - INTERVAL '1 day' * $2`,
      scope,
    ),
    // Learned rules, since each was learned: the later transfers each one labeled, and
    // what operators decided about those labels
    query<{ rules: number; inert: number; matched: number; reviewed: number; confirmed: number; corrected: number }>(
      `WITH d AS (${DECISIONS}),
       m AS (
         SELECT DISTINCT r.id AS rule_id, c.event_id
         FROM counterparty_rules r
         JOIN classifications c ON c.rule_id = r.id AND c.source IS NULL AND c.method = 'counterparty'
         JOIN normalized_events ne ON ne.id = c.event_id AND ne.supported IS TRUE AND ne.block_time > r.created_at
         WHERE ($1::uuid IS NULL OR r.user_id = $1)
       ),
       rv AS (
         SELECT DISTINCT ON (m.rule_id, m.event_id) m.rule_id, m.event_id, d.outcome
         FROM m JOIN d ON d.event_id = m.event_id AND d.prior_rule_id = m.rule_id AND d.prior_source IS NULL
         WHERE d.outcome IN ('confirmed', 'corrected')
         ORDER BY m.rule_id, m.event_id, d.decided_at ASC
       )
       SELECT (SELECT COUNT(*)::int FROM counterparty_rules r WHERE ($1::uuid IS NULL OR r.user_id = $1) AND ${EFFECTIVE('r')}) AS rules,
              (SELECT COUNT(*)::int FROM counterparty_rules r WHERE ($1::uuid IS NULL OR r.user_id = $1) AND NOT ${EFFECTIVE('r')}) AS inert,
              (SELECT COUNT(*)::int FROM m) AS matched,
              (SELECT COUNT(*)::int FROM rv) AS reviewed,
              (SELECT COUNT(*)::int FROM rv WHERE outcome = 'confirmed') AS confirmed,
              (SELECT COUNT(*)::int FROM rv WHERE outcome = 'corrected') AS corrected`,
      [p.userId],
    ),
    // A repeated mistake: after the operator taught a label for an address and direction,
    // Luca labeled another transfer with them differently, where the learned rule was
    // meant to apply (single transfer, not a fee, not decided by a whole-transaction check,
    // the rule with that label active at the time)
    query<{ hash: string; luca: string; taught: string }>(
      `WITH t AS (${DECISIONS})
       SELECT DISTINCT ON (c.id) ne.hash, c.label::text AS luca, t.answer AS taught
       FROM t
       JOIN normalized_events te ON te.id = t.event_id
       JOIN normalized_events ne ON ne.user_id = te.user_id AND ne.id <> te.id AND ne.direction = te.direction
         AND ${COUNTERPARTY('ne')} = ${COUNTERPARTY('te')} AND ne.supported IS TRUE AND ne.source_key <> 'gas'
       JOIN classifications c ON c.event_id = ne.id AND c.source IS NULL AND c.created_at > t.decided_at
         AND COALESCE(c.shape, 'single') = 'single' AND c.method <> 'deterministic'
       JOIN counterparty_rules r ON r.user_id = te.user_id AND LOWER(r.address) = ${COUNTERPARTY('te')}
         AND (r.direction = te.direction OR r.direction IS NULL) AND r.label::text = t.answer
         AND r.created_at <= c.created_at AND (r.active OR r.disabled_at > c.created_at)
       WHERE t.outcome <> 'operator_revision' AND t.answer <> 'unknown' AND c.label::text <> t.answer
       ORDER BY c.id`,
      [p.userId],
    ),
    // Gold set: curated examples, compared with Luca's current label; never live evidence
    query<{ examples: number; matching: number }>(
      `SELECT COUNT(*)::int AS examples,
              COUNT(*) FILTER (WHERE c.label::text = gt.correct_label)::int AS matching
       FROM gold_transactions gt
       LEFT JOIN classifications c ON c.event_id = gt.event_id AND c.superseded_at IS NULL
       WHERE ($1::uuid IS NULL OR gt.user_id = $1)`,
      [p.userId],
    ),
  ]);

  const a = activity.rows[0];
  const d = decisions.rows;
  const predictions = d.filter((x) => x.outcome === 'confirmed' || x.outcome === 'corrected');
  const confirmed = predictions.filter((x) => x.outcome === 'confirmed').length;
  const corrected = predictions.length - confirmed;
  const high = predictions.filter((x) => (x.prior_confidence ?? 0) >= HIGH_CONFIDENCE);
  const highWrong = high.filter((x) => x.outcome === 'corrected');

  const labels = new Map<string, { reviewed: number; confirmed: number; actually: Record<string, number> }>();
  for (const x of predictions) {
    const l = labels.get(x.prior_label!) ?? { reviewed: 0, confirmed: 0, actually: {} };
    l.reviewed++;
    if (x.outcome === 'confirmed') l.confirmed++;
    else l.actually[x.answer] = (l.actually[x.answer] ?? 0) + 1;
    labels.set(x.prior_label!, l);
  }
  const byLabel = [...labels.entries()]
    .map(([label, l]) => ({ label, ...l, precision: rate(l.confirmed, l.reviewed) }))
    .sort((x, y) => y.reviewed - x.reviewed || x.label.localeCompare(y.label));

  const r = rules.rows[0];
  const g = gold.rows[0];
  const baseline: QualityBaseline = {
    scope: { userId: p.userId, days: p.days },
    activity: {
      movements: a.movements, still_unknown: a.still_unknown,
      still_unknown_usd: a.still_unknown_usd ? parseFloat(a.still_unknown_usd) : 0,
      unreviewed: a.unreviewed,
      // Not a sample of reviews: every movement counts, so no minimum applies
      unknown_rate: { num: a.still_unknown, den: a.movements, rate: a.movements > 0 ? a.still_unknown / a.movements : null },
    },
    decisions: {
      reviewed: predictions.length, confirmed, corrected,
      unknown_answered: d.filter((x) => x.outcome === 'unknown_answered').length,
      operator_revisions: d.filter((x) => x.outcome === 'operator_revision').length,
      correction_rate: rate(corrected, predictions.length),
      high_confidence: {
        ...rate(highWrong.length, high.length),
        mistakes: highWrong.map((x) => ({ hash: x.hash, luca: x.prior_label!, operator: x.answer, confidence: x.prior_confidence!, decided_at: x.decided_at })),
      },
      by_label: byLabel,
      internal: {
        wrongly_internal: predictions.filter((x) => x.prior_label === 'internal_transfer' && x.answer !== 'internal_transfer').length,
        missed_internal: predictions.filter((x) => x.prior_label !== 'internal_transfer' && x.answer === 'internal_transfer').length,
      },
      rules_learned: rulesLearned.rows[0].n,
      rules_learned_inert: rulesLearned.rows[0].inert,
    },
    rules: {
      rules: r.rules, inert: r.inert, matched: r.matched, reviewed: r.reviewed, confirmed: r.confirmed, corrected: r.corrected,
      unreviewed: r.matched - r.reviewed,
      precision: rate(r.confirmed, r.reviewed),
      repeated_mistakes: repeated.rows,
    },
    gold: { examples: g.examples, matching: g.matching, rate: rate(g.matching, g.examples) },
    warnings: [],
  };

  // Read-only warnings, only on enough evidence
  const hc = baseline.decisions.high_confidence;
  if (hc.rate !== null && hc.rate > HCW_WARN_RATE) {
    baseline.warnings.push(`High-confidence wrong is ${pctText(hc.rate)} (${hc.num} of ${hc.den} reviewed high-confidence predictions), above ${pctText(HCW_WARN_RATE)}.`);
  }
  for (const l of byLabel) {
    if (l.precision.rate !== null && l.precision.rate < PRECISION_WARN_RATE) {
      baseline.warnings.push(`Reviewed precision for ${labelText(l.label)} is ${pctText(l.precision.rate)} (${l.confirmed} of ${l.reviewed} reviewed), below ${pctText(PRECISION_WARN_RATE)}.`);
    }
  }
  if (baseline.rules.repeated_mistakes.length > 0) {
    baseline.warnings.push(`Luca repeated a mistake it had been taught ${baseline.rules.repeated_mistakes.length} ${baseline.rules.repeated_mistakes.length === 1 ? 'time' : 'times'}.`);
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// Wording: fixed, from the numbers above
// ---------------------------------------------------------------------------

const LABELS: Record<string, string> = {
  revenue: 'revenue', expense: 'expense', internal_transfer: 'internal transfer', treasury: 'treasury', gas: 'network fee',
  x402_income: 'x402 income', x402_spend: 'x402 spend', refund: 'refund', swap: 'swap', unknown: 'unknown',
};
const labelText = (l: string): string => LABELS[l] ?? l;
const pctText = (x: number): string => `${(x * 100).toFixed(x * 100 < 10 && x > 0 ? 1 : 0)}%`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// "12%: 3 wrong of 25 reviewed high-confidence predictions", or "too few to judge: …"
function rateText(r: Rate, numWord: string, denNoun: string): string {
  if (r.den === 0) return `no ${denNoun} yet`;
  const counts = `${r.num} ${numWord} of ${r.den} ${denNoun}`;
  return r.rate === null ? `too few to judge: ${counts} (needs at least ${MIN_SAMPLE})` : `${pctText(r.rate)}: ${counts}`;
}

// " (17 more are for addresses Luca does not book and cannot take effect; not counted)"
function inertText(n: number): string {
  return n === 0 ? '' : ` (${n} more ${n === 1 ? 'is' : 'are'} for addresses Luca does not book, such as unsupported tokens, and cannot take effect; not counted)`;
}

export function describeQuality(q: QualityBaseline, subject: string): string {
  const days = q.scope.days;
  const period = days === 1 ? 'the last day' : `the last ${days} days`;
  const a = q.activity;
  const d = q.decisions;
  const lines: string[] = [`Classification quality: ${subject}`];

  lines.push('', `Transfers that happened in ${period}:`);
  lines.push(`- ${plural(a.movements, 'movement')}; ${a.still_unknown} still unknown${a.still_unknown_usd > 0 ? ` (${usdDisplay(a.still_unknown_usd)})` : ''}; ${a.unreviewed} never reviewed by an operator`);
  lines.push(`- Unknown rate: ${a.unknown_rate.rate === null ? 'no movements' : `${pctText(a.unknown_rate.rate)} (${a.still_unknown} of ${a.movements})`}`);

  lines.push('', `Operator decisions made in ${period}, whatever the transfer's date:`);
  lines.push(`- ${plural(d.reviewed, "reviewed label")} of Luca's: ${d.confirmed} confirmed, ${d.corrected} corrected`);
  lines.push(`- ${plural(d.unknown_answered, 'unknown')} answered (Luca said it did not know; not an error)`);
  lines.push(`- Correction rate: ${rateText(d.correction_rate, 'corrected', 'reviewed labels')}`);
  lines.push(`- High-confidence wrong (Luca at least ${pctText(HIGH_CONFIDENCE)} sure): ${rateText(d.high_confidence, 'wrong', 'reviewed high-confidence predictions')}`);
  for (const m of d.high_confidence.mistakes.slice(0, 5)) {
    lines.push(`  - ${txLink(m.hash)}: Luca said ${labelText(m.luca)} (${pctText(m.confidence)} sure), the operator said ${labelText(m.operator)}`);
  }
  const focus = ['revenue', 'expense'];
  const labelLines = [...focus.map((f) => d.by_label.find((l) => l.label === f) ?? { label: f, reviewed: 0, confirmed: 0, precision: rate(0, 0), actually: {} }),
    ...d.by_label.filter((l) => !focus.includes(l.label))];
  lines.push('- Reviewed precision by label (confirmed of reviewed; not overall accuracy):');
  for (const l of labelLines) {
    const wrong = Object.entries(l.actually).map(([k, n]) => `${labelText(k)} x${n}`).join(', ');
    lines.push(`  - ${labelText(l.label)}: ${rateText(l.precision, 'confirmed', 'reviewed')}${wrong ? `; the corrected ones were ${wrong}` : ''}`);
  }
  lines.push(`- Internal transfers: ${d.internal.wrongly_internal} wrongly called internal, ${d.internal.missed_internal} internal ${d.internal.missed_internal === 1 ? 'transfer' : 'transfers'} missed`);
  lines.push(`- Rules learned: ${d.rules_learned}${inertText(d.rules_learned_inert)}`);

  const r = q.rules;
  lines.push('', 'Learned rules, since each was learned:');
  lines.push(`- ${plural(r.rules, 'rule')}${inertText(r.inert)}; ${plural(r.matched, 'later transfer')} labeled by them: ${r.reviewed} reviewed (${r.confirmed} confirmed, ${r.corrected} corrected), ${r.unreviewed} unreviewed`);
  lines.push(`- Reviewed rule precision: ${rateText(r.precision, 'confirmed', 'reviewed rule matches')}`);
  lines.push(`- Repeated mistakes after being taught: ${r.repeated_mistakes.length}`);
  for (const m of r.repeated_mistakes.slice(0, 5)) lines.push(`  - ${txLink(m.hash)}: labeled ${labelText(m.luca)} after being taught ${labelText(m.taught)}`);

  const g = q.gold;
  lines.push('', 'Gold set (curated examples, kept separate from live reviews):');
  lines.push(`- ${g.examples === 0 ? 'No examples yet' : `${plural(g.examples, 'example')}: ${g.matching} match Luca's current label${g.rate.rate === null ? ' (too few to judge)' : ` (${pctText(g.rate.rate)})`}`}`);

  lines.push('', q.warnings.length > 0 ? 'Warnings:' : 'Warnings: none');
  for (const w of q.warnings) lines.push(`- ${w}`);
  return lines.join('\n');
}

// A few lines for /ops (the full report is the admin chat answer)
export function describeQualityShort(q: QualityBaseline): string[] {
  const a = q.activity;
  const d = q.decisions;
  const r = q.rules;
  const hc = d.high_confidence;
  const short = (x: Rate): string => (x.den === 0 ? 'none reviewed' : x.rate === null ? `too few to judge (${x.num} of ${x.den})` : `${pctText(x.rate)} (${x.num} of ${x.den})`);
  return [
    `  Transfers in the period: ${a.movements}  |  Unknown: ${a.still_unknown}${a.movements > 0 ? ` (${pctText(a.still_unknown / a.movements)})` : ''}  |  Never reviewed: ${a.unreviewed}`,
    `  Decisions in the period: ${d.reviewed} reviewed (${d.confirmed} confirmed, ${d.corrected} corrected)  |  Unknowns answered: ${d.unknown_answered}`,
    `  High-confidence wrong: ${short(hc)}  |  Correction rate: ${short(d.correction_rate)}`,
    `  Rules: ${r.rules}${r.inert > 0 ? ` (+${r.inert} that cannot take effect)` : ''}  |  Later transfers labeled: ${r.matched} (${r.reviewed} reviewed, ${r.unreviewed} unreviewed)  |  Repeated mistakes: ${r.repeated_mistakes.length}`,
    `  Warnings: ${q.warnings.length === 0 ? 'none' : q.warnings.length}`,
  ];
}
