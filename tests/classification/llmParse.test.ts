import { describe, it, expect } from 'vitest';
import { parseLlmClassificationResponse } from '../../src/classification/llmParse.js';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';
const BATCH = [A, B, C];

function item(id: string, overrides: Record<string, unknown> = {}) {
  return { id, label: 'revenue', confidence: 0.9, evidence: 'Customer payment', ...overrides };
}

describe('parseLlmClassificationResponse', () => {
  it('accepts a bare array', () => {
    const r = parseLlmClassificationResponse(JSON.stringify([item(A), item(B), item(C)]), BATCH);
    expect(r.malformed).toBe(false);
    expect(r.results.size).toBe(3);
    expect(r.invalidIds).toEqual([]);
    expect(r.results.get(A)).toEqual({
      label: 'revenue',
      confidence: 0.9,
      method: 'model',
      evidence: 'Customer payment',
    });
  });

  it('accepts a {results:[...]} envelope', () => {
    const r = parseLlmClassificationResponse(JSON.stringify({ results: [item(A), item(B)] }), BATCH);
    expect(r.results.size).toBe(2);
    expect(r.invalidIds).toEqual([C]);
  });

  it('strips markdown code fences', () => {
    const text = '```json\n' + JSON.stringify([item(A)]) + '\n```';
    const r = parseLlmClassificationResponse(text, [A]);
    expect(r.results.get(A)?.label).toBe('revenue');
  });

  it('marks every id invalid on malformed / truncated JSON', () => {
    const truncated = JSON.stringify([item(A), item(B)]).slice(0, 60);
    const r = parseLlmClassificationResponse(truncated, BATCH);
    expect(r.malformed).toBe(true);
    expect(r.results.size).toBe(0);
    expect(r.invalidIds).toEqual(BATCH);
  });

  it('marks every id invalid when the envelope has the wrong shape', () => {
    const r = parseLlmClassificationResponse(JSON.stringify({ foo: 1 }), BATCH);
    expect(r.malformed).toBe(true);
    expect(r.invalidIds).toEqual(BATCH);
  });

  it('drops items whose id is not in the batch', () => {
    const r = parseLlmClassificationResponse(JSON.stringify([item('not-in-batch'), item(A)]), BATCH);
    expect(r.results.has('not-in-batch')).toBe(false);
    expect(r.results.has(A)).toBe(true);
    expect(r.invalidIds).toEqual([B, C]);
  });

  it('rejects labels outside the allowed set individually', () => {
    const r = parseLlmClassificationResponse(
      JSON.stringify([item(A, { label: 'salary' }), item(B, { label: 'expense' })]),
      BATCH,
    );
    expect(r.results.has(A)).toBe(false);
    expect(r.results.get(B)?.label).toBe('expense');
    expect(r.invalidIds).toEqual([A, C]);
  });

  it('normalises label case/whitespace', () => {
    const r = parseLlmClassificationResponse(JSON.stringify([item(A, { label: ' Revenue ' })]), [A]);
    expect(r.results.get(A)?.label).toBe('revenue');
  });

  it('keeps genuine model "unknown" as a valid result', () => {
    const r = parseLlmClassificationResponse(
      JSON.stringify([item(A, { label: 'unknown', confidence: 0.2 })]),
      [A],
    );
    expect(r.results.get(A)?.label).toBe('unknown');
    expect(r.invalidIds).toEqual([]);
  });

  it('clamps confidence to [0,1] and coerces numeric strings', () => {
    const r = parseLlmClassificationResponse(
      JSON.stringify([
        item(A, { confidence: 1.7 }),
        item(B, { confidence: -3 }),
        item(C, { confidence: '0.42' }),
      ]),
      BATCH,
    );
    expect(r.results.get(A)?.confidence).toBe(1);
    expect(r.results.get(B)?.confidence).toBe(0);
    expect(r.results.get(C)?.confidence).toBe(0.42);
  });

  it('rejects non-numeric or missing confidence', () => {
    const r = parseLlmClassificationResponse(
      JSON.stringify([
        item(A, { confidence: 'high' }),
        item(B, { confidence: null }),
        { id: C, label: 'revenue', evidence: 'x' },
      ]),
      BATCH,
    );
    expect(r.results.size).toBe(0);
    expect(r.invalidIds).toEqual(BATCH);
  });

  it('first item wins on duplicate ids', () => {
    const r = parseLlmClassificationResponse(
      JSON.stringify([item(A, { label: 'expense' }), item(A, { label: 'revenue' })]),
      [A],
    );
    expect(r.results.get(A)?.label).toBe('expense');
  });

  it('defaults evidence when missing or not a string', () => {
    const r = parseLlmClassificationResponse(
      JSON.stringify([item(A, { evidence: undefined }), item(B, { evidence: 42 })]),
      [A, B],
    );
    expect(r.results.get(A)?.evidence).toBe('LLM classification');
    expect(r.results.get(B)?.evidence).toBe('LLM classification');
  });

  it('skips non-object items without failing the batch', () => {
    const r = parseLlmClassificationResponse(JSON.stringify([null, 'x', 3, item(A)]), BATCH);
    expect(r.malformed).toBe(false);
    expect(r.results.has(A)).toBe(true);
  });
});
