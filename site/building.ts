// The content of askluca.xyz/building: Luca's public record.
//
// Every Sunday:
//   1. Update `current` (the sentence and `lastUpdated`).
//   2. Move roadmap items by changing `stage`; change `status` as things are proven.
//   3. Add Build Log entries (newest dates are shown first; entries on the same day keep
//      the order they have here).
//   4. Run `npm run site:building`, commit both this file and landing/building/index.html.
//
// Visibility: an item or entry is published only when `public: true` and `draft: false`.
// Drafts stay here until they are ready, but this repository is public: anything
// sensitive belongs in luca-private until it is published.
//
// Claim rules: never invent capabilities or metrics; TESTING is not proven; NEXT and
// LATER are direction, not commitments; Luca is read-only and cannot move funds.

export const STAGES = ['shipped', 'now', 'next', 'later'] as const;
export type Stage = (typeof STAGES)[number];

export const STATUSES = ['live', 'testing', 'building', 'exploring'] as const;
export type Status = (typeof STATUSES)[number];

export const LOG_STATUSES = ['shipped', 'fixed'] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

export type RoadmapItem = {
  title: string;
  stage: Stage;
  status: Status;
  description?: string;
  public: boolean;
  draft: boolean;
};

export type BuildLogEntry = {
  date: string; // YYYY-MM-DD
  title: string;
  description: string;
  status: LogStatus;
  evidenceLink?: string;
  public: boolean;
  draft: boolean;
};

export type BuildingData = {
  current: {
    text: string;
    statusLine: string;
    lastUpdated: string; // YYYY-MM-DD
  };
  roadmap: RoadmapItem[];
  buildLog: BuildLogEntry[];
};

const item = (stage: Stage, title: string, status: Status): RoadmapItem =>
  ({ title, stage, status, public: true, draft: false });

export const buildingData: BuildingData = {
  current: {
    text: 'Testing Luca against real financial activity and onboarding the first outside operators.',
    statusLine: 'Base · Invite-only beta · Read-only',
    lastUpdated: '2026-09-27',
  },

  roadmap: [
    item('shipped', 'Base wallet tracking', 'live'),
    item('shipped', 'ETH / USDC / BNKR books', 'live'),
    item('shipped', 'Transaction classification', 'testing'),
    item('shipped', 'Financial memory', 'live'),
    item('shipped', 'Natural-language Telegram', 'live'),
    item('shipped', 'Balance reconciliation against Base', 'live'),
    item('shipped', 'Transaction evidence / BaseScan', 'live'),
    item('shipped', 'Historical pricing', 'live'),
    item('shipped', 'Conversational corrections', 'live'),
    item('shipped', 'Classification quality measurement', 'live'),
    item('shipped', 'ACCUM fee accounting', 'testing'),

    item('now', 'Real operator testing', 'testing'),
    item('now', 'Classification trust', 'testing'),
    item('now', 'Learning from corrections across different operators', 'testing'),
    item('now', 'Improving proactive briefs & financial judgment', 'building'),

    item('next', 'Deeper entity & counterparty memory', 'exploring'),
    item('next', 'Deeper entity-level books', 'exploring'),
    item('next', 'Project / agent-level P&Ls', 'exploring'),
    item('next', 'iMessage', 'exploring'),

    item('later', 'Runway & budgets', 'exploring'),
    item('later', 'Predictive financial intelligence', 'exploring'),
    item('later', 'Financial system of record', 'exploring'),
    // Long-term exploration only: Luca is read-only today
    item('later', 'Controlled financial actions', 'exploring'),
  ],

  buildLog: [
    {
      date: '2026-09-27',
      title: 'Corrections now ask before changing history',
      description: 'When a correction could apply to earlier transactions, Luca asks before changing those books.',
      status: 'shipped',
      public: true,
      draft: false,
    },
    {
      date: '2026-09-27',
      title: 'Books can now be checked against Base',
      description: 'Luca can verify whether its books match the financial activity onchain.',
      status: 'shipped',
      public: true,
      draft: false,
    },
    {
      date: '2026-09-27',
      title: 'ACCUM creator-fee accounting went live',
      description: 'Luca can now account for the BNKR creator-fee activity used in the ACCUM experiment.',
      status: 'shipped',
      public: true,
      draft: false,
    },
    {
      date: '2026-09-27',
      title: 'Incomplete recent-transaction answers fixed',
      description: 'Luca previously returned a recent-transaction answer that omitted a swap. Real-wallet testing exposed it. The issue was fixed and verified.',
      status: 'fixed',
      public: true,
      draft: false,
    },
    {
      date: '2026-09-27',
      title: 'Classification quality reporting fixed',
      description: "Old spam-token rules were incorrectly affecting Luca's quality report. They are now excluded.",
      status: 'fixed',
      public: true,
      draft: false,
    },
    {
      date: '2026-09-24',
      title: 'Balance reconciliation caught missing gas entries',
      description: 'Luca found missing network-fee records while checking its books against the chain and repaired them.',
      status: 'fixed',
      public: true,
      draft: false,
    },
  ],
};
