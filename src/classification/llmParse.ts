import { z } from 'zod';
import { CLASSIFICATION_LABELS } from '../types/index.js';
import type { ClassificationLabel } from '../types/index.js';
import type { ClassificationResult } from './types.js';

// Pure parsing/validation of the classifier LLM output — no DB, no network.

const labelSet = new Set<string>(CLASSIFICATION_LABELS);

// Lenient envelope: items are validated one by one below so a single bad item
// never poisons the whole batch.
const envelopeSchema = z.union([
  z.array(z.unknown()),
  z.object({ results: z.array(z.unknown()) }).passthrough(),
]);

const itemSchema = z.object({
  id: z.string().min(1),
  label: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => labelSet.has(s), { message: 'label not in allowed set' }),
  confidence: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z.number().finite(),
  ),
  // Evidence is advisory — never reject an item over it
  evidence: z.unknown().transform((v) => (typeof v === 'string' ? v : null)),
});

export type LlmParseResult = {
  results: Map<string, ClassificationResult>;
  // ids from the batch with no valid item in the response (missing, invalid, or duplicated)
  invalidIds: string[];
  // true when the response as a whole could not be parsed
  malformed: boolean;
};

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

export function parseLlmClassificationResponse(
  text: string,
  batchIds: readonly string[],
): LlmParseResult {
  const allowedIds = new Set(batchIds);
  const results = new Map<string, ClassificationResult>();

  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(text));
  } catch {
    return { results, invalidIds: [...batchIds], malformed: true };
  }

  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { results, invalidIds: [...batchIds], malformed: true };
  }
  const items = Array.isArray(envelope.data) ? envelope.data : envelope.data.results;

  for (const item of items) {
    const parsed = itemSchema.safeParse(item);
    if (!parsed.success) continue;
    const { id, label, confidence, evidence } = parsed.data;
    if (!allowedIds.has(id) || results.has(id)) continue; // unknown id or duplicate → first wins
    results.set(id, {
      label: label as ClassificationLabel,
      confidence: Math.min(1, Math.max(0, confidence)),
      method: 'model',
      evidence: evidence && evidence.trim() ? evidence.trim() : 'LLM classification',
    });
  }

  const invalidIds = batchIds.filter((id) => !results.has(id));
  return { results, invalidIds, malformed: false };
}
