# 2026-10-12 Devpost announcement normalization fix

The five Devpost entries in `targets.json` had a typo in the public ignore regex: `^d+ ... ago$` instead of `^\\d+ ... ago$`. The intended filter silently failed, causing rolling labels such as `4 days ago` to look like changes to an organiser's announcement.

## Fix and verification

- Replace the five bad expressions with a numeric matcher; keep genuine deadline, prize and eligibility text untouched.
- Regression coverage: `test/targets.test.ts` checks four Devpost Updates targets against rolling numeric time labels, and asserts genuine announcement text survives.
- Local verification: `npm test` **37 PASS**; `npm run typecheck` **PASS**.
- Dry-run before fix: 6 unchanged and 4 changed, due largely to dynamic relative timestamps.
- Dry-run after fix: 6 unchanged and 4 changed; each of the four changed pages is a **one-time normalization migration from historical v1 snapshots**, not evidence that the organiser changed its contest rules.
- Existing `readonly` snapshots cannot be edited or rewritten. A new normalized version is the only integrity-preserving way to correct the historical text; downstream readers must interpret this version as a normalization migration.
- Do **not** present these particular v1 -> v2 differences as proof of a substantive contest-rule edit in the demo. A genuine rules edit must be confirmed against the primary source.

The on-chain seed receipt and readback verification should be recorded in the coordinating Bounty Hub session note; no secrets are needed here.
