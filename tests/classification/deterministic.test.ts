import { describe, it, expect } from 'vitest';
import { classifyDeterministic, addX402Contract } from '../../src/classification/deterministic.js';
import type { UnclassifiedEvent } from '../../src/classification/types.js';

const WALLET_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.toLowerCase();
const WALLET_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'.toLowerCase();
const EXTERNAL = '0x1234567890123456789012345678901234567890';

function makeEvent(overrides: Partial<UnclassifiedEvent> = {}): UnclassifiedEvent {
  return {
    id: 'evt-1',
    user_id: 'user-1',
    wallet_id: 'wallet-1',
    hash: '0xdeadbeef',
    log_index: null,
    block_time: new Date('2024-01-15T10:00:00Z'),
    from_address: EXTERNAL,
    to_address: WALLET_A,
    asset: 'USDC',
    amount: 100,
    direction: 'in',
    ...overrides,
  };
}

describe('classifyDeterministic', () => {
  const userWallets = [WALLET_A, WALLET_B];

  describe('internal transfer', () => {
    it('classifies transfer between two user wallets as internal_transfer', () => {
      const event = makeEvent({
        from_address: WALLET_A,
        to_address: WALLET_B,
        direction: 'out',
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).toBe('internal_transfer');
      expect(result?.confidence).toBe(1.0);
      expect(result?.method).toBe('deterministic');
    });

    it('is case-insensitive for wallet address matching', () => {
      const event = makeEvent({
        from_address: WALLET_A.toUpperCase(),
        to_address: WALLET_B.toUpperCase(),
        direction: 'out',
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).toBe('internal_transfer');
    });

    it('does not classify as internal when only one side is a user wallet', () => {
      const event = makeEvent({
        from_address: EXTERNAL,
        to_address: WALLET_A,
        direction: 'in',
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).not.toBe('internal_transfer');
    });
  });

  describe('x402 income', () => {
    it('classifies incoming from known x402 contract as x402_income', () => {
      const x402 = '0x7777777777777777777777777777777777777777';
      const event = makeEvent({
        from_address: x402,
        to_address: WALLET_A,
        direction: 'in',
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).toBe('x402_income');
      expect(result?.confidence).toBe(1.0);
    });

    it('does not classify outgoing to x402 contract as x402_income', () => {
      const x402 = '0x7777777777777777777777777777777777777777';
      const event = makeEvent({
        from_address: WALLET_A,
        to_address: x402,
        direction: 'out',
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).not.toBe('x402_income');
    });
  });

  describe('x402 spend', () => {
    it('classifies outgoing to known x402 contract as x402_spend', () => {
      const x402 = '0x7777777777777777777777777777777777777777';
      const event = makeEvent({
        from_address: WALLET_A,
        to_address: x402,
        direction: 'out',
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).toBe('x402_spend');
      expect(result?.confidence).toBe(1.0);
    });
  });

  describe('addX402Contract', () => {
    it('dynamically added x402 contract is recognised', () => {
      const newContract = '0xDEADDEADDEADDEADDEADDEADDEADDEADDEADDEAD';
      addX402Contract(newContract);
      const event = makeEvent({
        from_address: newContract,
        to_address: WALLET_A,
        direction: 'in',
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).toBe('x402_income');
    });
  });

  describe('gas', () => {
    // Gas is paid by the transaction, not sent as a transfer: a small ETH transfer is a payment
    it('does not label a small outgoing ETH payment as gas', () => {
      const event = makeEvent({
        asset: 'ETH',
        amount: 0.000042,
        direction: 'out',
        from_address: WALLET_A,
        to_address: EXTERNAL,
      });
      expect(classifyDeterministic(event, userWallets)).toBeNull();
    });

    it('does not classify non-ETH tiny amounts as gas', () => {
      const event = makeEvent({
        asset: 'USDC',
        amount: 0.000042,
        direction: 'out',
        from_address: WALLET_A,
        to_address: EXTERNAL,
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).not.toBe('gas');
    });

    it('does not classify incoming tiny ETH as gas', () => {
      const event = makeEvent({
        asset: 'ETH',
        amount: 0.000042,
        direction: 'in',
        from_address: EXTERNAL,
        to_address: WALLET_A,
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).not.toBe('gas');
    });

    it('does not classify large ETH outgoing as gas', () => {
      const event = makeEvent({
        asset: 'ETH',
        amount: 0.5,
        direction: 'out',
        from_address: WALLET_A,
        to_address: EXTERNAL,
      });
      const result = classifyDeterministic(event, userWallets);
      expect(result?.label).not.toBe('gas');
    });
  });

  it('returns null when no rule matches', () => {
    const event = makeEvent({
      from_address: EXTERNAL,
      to_address: WALLET_A,
      asset: 'USDC',
      amount: 500,
      direction: 'in',
    });
    const result = classifyDeterministic(event, userWallets);
    expect(result).toBeNull();
  });

  it('returns null when userWalletAddresses is empty', () => {
    const event = makeEvent({
      from_address: WALLET_A,
      to_address: WALLET_B,
      direction: 'out',
    });
    const result = classifyDeterministic(event, []);
    expect(result).toBeNull();
  });
});
