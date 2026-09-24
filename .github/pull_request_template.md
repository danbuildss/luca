## What changed

## Why

## How it was verified
- [ ] `npm run lint` and `npm run typecheck` pass
- [ ] `LUCA_INTEGRATION=1 npx vitest run` passes
- [ ] New or changed behaviour has a test

## Checklist
- [ ] Luca stays read-only and every financial query stays scoped to one operator
- [ ] Schema changes are a new, additive migration
- [ ] No secrets, keys or personal wallet details added
