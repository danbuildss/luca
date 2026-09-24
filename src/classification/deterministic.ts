import { ClassificationLabel } from '../types/index.js';
import type { UnclassifiedEvent, ClassificationResult } from './types.js';

// Known x402 protocol contract addresses on Base
// Expand this list as new x402 contracts are deployed
const X402_CONTRACTS = new Set([
  '0x7777777777777777777777777777777777777777', // placeholder — replace with real x402 contracts
]);

export function classifyDeterministic(
  event: UnclassifiedEvent,
  userWalletAddresses: string[],
): ClassificationResult | null {
  const wallets = new Set(userWalletAddresses.map((a) => a.toLowerCase()));

  // 0. Network fee recorded from the transaction receipt
  if (event.source_key === 'gas') {
    return {
      label: ClassificationLabel.GAS,
      confidence: 1.0,
      method: 'deterministic',
      evidence: 'Network fee from the transaction receipt',
    };
  }

  // 1. Internal transfer: both sides are user-owned wallets
  if (
    event.from_address &&
    event.to_address &&
    wallets.has(event.from_address.toLowerCase()) &&
    wallets.has(event.to_address.toLowerCase())
  ) {
    return {
      label: ClassificationLabel.INTERNAL_TRANSFER,
      confidence: 1.0,
      method: 'deterministic',
      evidence: 'Transfer between two wallets belonging to the same user',
    };
  }

  // 2. x402 income: incoming from a known x402 contract
  if (
    event.direction === 'in' &&
    event.from_address &&
    X402_CONTRACTS.has(event.from_address.toLowerCase())
  ) {
    return {
      label: ClassificationLabel.X402_INCOME,
      confidence: 1.0,
      method: 'deterministic',
      evidence: `Incoming from known x402 contract ${event.from_address}`,
    };
  }

  // 3. x402 spend: outgoing to a known x402 contract
  if (
    event.direction === 'out' &&
    event.to_address &&
    X402_CONTRACTS.has(event.to_address.toLowerCase())
  ) {
    return {
      label: ClassificationLabel.X402_SPEND,
      confidence: 1.0,
      method: 'deterministic',
      evidence: `Outgoing to known x402 contract ${event.to_address}`,
    };
  }

  return null;
}

export function addX402Contract(address: string): void {
  X402_CONTRACTS.add(address.toLowerCase());
}
