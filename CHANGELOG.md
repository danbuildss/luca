# Changelog

What changed in Luca, newest first. Each entry links the pull request that made it. Luca deploys from `main`; a migration number means the deploy applies that migration.

## Unreleased

- A new README with graphics in Luca's own colours and fonts, in light and dark, rebuilt by `scripts/readme-assets/build.py`. The chat cards show Luca's real messages on sample data.
- After one answer teaches rules for more than one address, Luca says "New transfers with these addresses will be labeled the same way." instead of "this address".
- Dependabot opens weekly dependency updates, and CI fails if a README image or link points at a missing file.

## October 2026

- **Oct 6** · Numbered answers to Luca's lists ("1 was an expense, 4 and 7 were swaps") are read in code and become one yes/no question. CI runs on Ubuntu 24.04. [#110](https://github.com/danbuildss/luca/pull/110)
- **Oct 5** · "What still needs context?" is answered from the books in code, never by the model. [#109](https://github.com/danbuildss/luca/pull/109)
- **Oct 5** · That list uses Luca's own numbered wording, with dollar amounts and names. [#108](https://github.com/danbuildss/luca/pull/108)
- **Oct 5** · The Monday message reminds you of what is still open; unknown lists are readable; tiny unsolicited transfers are left out. [#107](https://github.com/danbuildss/luca/pull/107)
- **Oct 5** · A label that runs against the money's direction labels that transfer only and teaches no rule; older corrections are linked to their rules. Migration 031. [#106](https://github.com/danbuildss/luca/pull/106)
- **Oct 5** · Decision history: every label records how it was made, and corrections never overwrite what they replaced. Migration 030. [#105](https://github.com/danbuildss/luca/pull/105)
- **Oct 4** · One morning message, only when there is something to say; Mondays cover the week. Migration 029. [#104](https://github.com/danbuildss/luca/pull/104)
- **Oct 4** · Quiet hours in your timezone, staked balances in answers, health alerts for admins only. [#103](https://github.com/danbuildss/luca/pull/103)

## September 2026

- **Sep 30** · First run: one welcome, then "reading" until your wallets are ready. [#101](https://github.com/danbuildss/luca/pull/101)
- **Sep 30** · Staking recognised from the chain: staked, unstaked and staking rewards. [#100](https://github.com/danbuildss/luca/pull/100)
- **Sep 28** · A new wallet gets its balances right away, and Luca says when it is still reading. [#99](https://github.com/danbuildss/luca/pull/99)
- **Sep 28** · The classifier uses the chat agent's LLM provider. [#98](https://github.com/danbuildss/luca/pull/98)
- **Sep 28** · Time limits on provider calls, and worker check-ins during slow cycles. [#97](https://github.com/danbuildss/luca/pull/97)

Earlier changes are in the [pull request history](https://github.com/danbuildss/luca/pulls?q=is%3Apr+is%3Amerged).
