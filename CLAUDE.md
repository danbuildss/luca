## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- UI polish (radius, shadows, motion, icons, hit areas) → invoke /better-ui
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Product principles

- **Data compounds.** Keep the history of Luca's decisions: append and supersede, never overwrite; record how each decision was made (method, model, evidence, confidence); link a correction to what it replaced and the rule it taught; never hard-delete history. Product first: never add questions, messages or latency to collect data. See `docs/architecture.md` (Decision history) and `docs/operating-rules.md` (History Policy).

