import { usdValueSql } from '../ingestion/assets.js';

// Dust: a few cents of a token sent in by an address the operator has never dealt with,
// usually spam that copies a real address to trick a later payment ("address poisoning").
// It stays in the books (labeled unknown), but Luca never counts it as something the
// operator has to explain and never asks about it.
export const DUST_INFLOW_USD = 0.1;

// SQL true when the event `a` (a normalized_events alias) is dust
export function dustSql(a: string): string {
  return `(${a}.direction = 'in' AND ${usdValueSql(a)} IS NOT NULL AND ${usdValueSql(a)} < ${DUST_INFLOW_USD}
    AND NOT EXISTS (
      SELECT 1 FROM normalized_events dx
      WHERE dx.user_id = ${a}.user_id AND dx.id <> ${a}.id AND dx.supported IS TRUE
        AND LOWER(CASE WHEN dx.direction = 'in' THEN dx.from_address ELSE dx.to_address END) = LOWER(${a}.from_address)
        AND (dx.direction = 'out' OR COALESCE(${usdValueSql('dx')}, 0) >= ${DUST_INFLOW_USD})
    ))`;
}
