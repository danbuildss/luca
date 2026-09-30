-- Migration 027: staking, recognised from the chain
--
-- Additive and safe to re-run. Nothing is deleted.
--
-- 1. Three labels:
--      staked          the operator's own tokens moved into a staking contract: a capital
--                      movement, never an expense
--      unstaked        their staked tokens coming back: capital, never income
--      staking_reward  a reward the staking contract paid: income, kept apart from
--                      creator-fee revenue
--    New enum values cannot be used in the transaction that adds them, so nothing below
--    uses them.
-- 2. staking_contracts: what Luca learned about a counterparty contract when it first
--    met it: whether it names a staking token (stakingToken()), its reward token, and a
--    read of a wallet's staked amount (e.g. stakeOf(address)). Public chain facts about
--    a contract, no operator data. A counterparty that is not a staking contract is kept
--    too, so it is not asked again.
-- 3. stake_checks: for each transfer to or from a staking contract, what the contract
--    showed about the wallet's staked amount just before and just after the
--    transaction. Only 'staked', 'unstaked' and 'staking_reward' become those labels;
--    'unclear' stays unknown (Luca asks), 'unrelated' is labeled as usual.

ALTER TYPE classification_label ADD VALUE IF NOT EXISTS 'staked';
ALTER TYPE classification_label ADD VALUE IF NOT EXISTS 'unstaked';
ALTER TYPE classification_label ADD VALUE IF NOT EXISTS 'staking_reward';

CREATE TABLE IF NOT EXISTS staking_contracts (
  address         TEXT PRIMARY KEY,       -- lowercase
  is_staking      BOOLEAN NOT NULL,
  staking_token   TEXT,                   -- lowercase; stakingToken()
  reward_token    TEXT,                   -- lowercase; rewardsToken() or rewardToken(), when it has one
  position_reader TEXT,                   -- 4-byte selector of the staked-amount read, e.g. stakeOf(address)
  reader_name     TEXT,                   -- that read's signature, for evidence
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stake_checks (
  event_id        UUID PRIMARY KEY REFERENCES normalized_events(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id       UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  contract        TEXT NOT NULL,          -- lowercase staking contract
  verdict         TEXT NOT NULL CHECK (verdict IN ('staked', 'unstaked', 'staking_reward', 'unclear', 'unrelated')),
  amount_raw      NUMERIC(78, 0) NOT NULL, -- this transfer, in the token's smallest unit
  block_number    BIGINT NOT NULL,
  evidence        JSONB NOT NULL,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stake_checks_position ON stake_checks(wallet_id, contract, block_number);
