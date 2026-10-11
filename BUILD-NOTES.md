# Build notes (status as of 2026-10-11)

Arkiv: Global Tour Stop, deadline 2026-10-18 22:59 UTC. Everything below is local; nothing has been pushed,
deployed or submitted.

## Status

| Area | State |
|---|---|
| Core (normalize, hash, diff, payload, entity builders, queries, batch planner) | Done, 30 unit tests pass (`npm test`), `npm run typecheck` clean |
| Snapshotter CLI (`status`, `snap`, `seed`, `history`, `verify`, `cite`, `watch`, `--dry-run`) | Done. Read paths verified against Tiramisu; write path verified up to the funding check |
| Web app (Vite static, no backend) | Done. Verified in Chrome against Tiramisu: browser `arkiv_query` works (CORS ok), WebSocket live feed receives events with no HTTP polling, 375 px layout has no horizontal overflow |
| `arkiv/schema.md`, `arkiv/friction.md`, README, MIT LICENSE, `vercel.json` | Done |
| On-chain entities | **None yet: the snapshotter wallet has 0 GLM** |

### Wallet

- Snapshotter: `0x517bf78c3000991FFbCdf06305F3881382437e98` (key in git-ignored `.env.local`; checked that the key
  string appears in no other file in the repo or the build output).
- Balance on 2026-10-11: **0 GLM** (`npm run snap -- status`). Writes stop with "has 0 GLM on Tiramisu. Fund it from the
  faucet, or re-run with --dry-run."

### Verified on chain

- Nothing written yet, so no transaction hashes. Read-only checks done: chain 7738577 reachable, queries return 0 rows for
  `app = str('fpl')`, `predictEntityKeys` works for the snapshotter, WebSocket subscription delivers live events.
- `npm run snap -- seed --dry-run` (2026-10-11): all 5 targets fetch and plan as `NEW-PAGE` batches
  (page + snapshot v1). Normalized sizes: zindi 4.3 KB, hackapertus 0.8 KB, arkiv devfolio 9.4 KB,
  airwallex 5.1 KB, zacharygoodsell 2.9 KB.

## What remains (in order)

1. **Owner: fund `0x517bf78c3000991FFbCdf06305F3881382437e98` from the Tiramisu faucet.**
2. `npm run snap -- seed` → record the 5 transaction hashes here; open each on
   `https://tiramisu.explorer.arkiv.network/tx/<hash>`; confirm `npm run snap -- status` lists 5 pages.
3. Run `seed` again a day or more later (and before the deadline) so at least one page has v2 + a diff on chain. If no
   page changes by itself, there is no honest way to force a diff on a real page; say so in the demo and show the
   "unchanged → lease renewed" path instead (patch + Lifetime Extension), plus the fixture for the diff viewer.
4. Test a citation from a second wallet (`npm run snap -- cite <snapshotKey> --note "…"` with a different funded key,
   or the browser "Cite" button with MetaMask). The browser wallet path (`web/wallet.ts`) is **untested**.
5. Update `arkiv/friction.md` "Still to test" with real results (batch keys vs predicted, flags read back, extension by a
   second wallet, cursor > 50 rows, `i32` vs `u64` literal match).
6. Owner: create the public GitHub repo, push, deploy to Vercel (static: `npm run build`, output `dist/`), record the URL.
7. Demo video (≤ 3 min): problem (Zindi data page / Devpost "we reserve the right to update"), seed run, web app timeline +
   hash check + verify panel curl, untrusted toggle, live feed, citation extending a snapshot.
8. Fill the Devfolio form (drafts below).

## Open issues / known limits

- Pages that render their rules client-side only would snapshot as near-empty text. All 5 seeds return their terms in
  server HTML (checked). No headless browser on purpose: the normalizer must be reproducible by anyone with `fetch`.
- Devpost's WAF returns 403 to non-browser requests that send `Accept: text/html,...;q=0.9`; the fetcher sends no custom
  Accept header (works as of 2026-10-11).
- The Zindi page has live counters ("1106 joined", "162 active", "21 days left") that changed between two fetches minutes
  apart. `targets.json` gives it public ignore patterns, stored in the page entity payload and applied by `verify`.
  Other 4 seeds were byte-identical across two fetches.
- Snapshot schedule is manual (`seed`), not a cron, because nothing may be deployed from here.
- `BUILD-NOTES.md` is committed for the owner; remove it before making the repo public if preferred.

---

## Devfolio drafts (owner to review and edit)

**Tracks:** Censorship Resistance (primary), Security.

**The problem it solves.** Contest organisers edit rules, timelines and prize terms while a contest runs, and participants
cannot prove what the page said before. Example: the Zindi "Bias Bounty Mapping Equity" data page still lists reference
layers that the data bucket removed on 2026-09-25; Hack Apertus' rules say the organisers "reserve the right to update
the contest timeline". Screenshots can be faked and archive services capture pages irregularly. Fine Print Ledger keeps a
timestamped, hash-checked, readonly copy of each public rules page on Arkiv and a diff whenever it changes, readable
by anyone without our server.

**Challenges I ran into.** The SDK refuses `$createdAt` range predicates that the node accepts, so we store our own
`fetchedAt`; an unfunded wallet surfaces as "Execution error without revert data" with the real reason five causes deep;
Devpost's WAF rejected our first fetcher; keeping snapshot and diff consistent required predicting the snapshot's entity key
so the diff can reference it inside the same atomic batch. Details in `arkiv/friction.md`.

**Why Arkiv?** The evidence has to outlive and be independent of whoever publishes it. With Postgres or our own API we would
be one more party who could quietly edit a snapshot or take it down, the same trust problem we are trying to remove. IPFS
gives immutability but no queries (we need "snapshots of this URL fetched before time T, by this creator") and no expiry,
so pinned junk lives forever and someone has to pay to pin. A subgraph needs our own contracts and an indexer to run.
Arkiv gives us: an immutable, chain-set `$creator` to anchor trust; `readonly` entities so not even our snapshotter key can
rewrite a snapshot; typed attribute queries with numeric ranges straight from the browser; per-type Entity Expiration so
evidence lives as long as disputes do and stale watches disappear; and `permissionlessExtension` so participants, not us,
decide which evidence stays alive. What stays off Arkiv on purpose: raw HTML and scripts (only normalized text; the
normalizer is open source so anyone can re-derive the hash), the private key, and any personal data.

**How do you use Arkiv?** (each with code)
- Attributes vs payload: everything filtered on is a typed attribute (`u64` for `fetchedAt`, `version`, `changedAt`); text and
  diffs are payloads. `src/core/entities.ts`.
- Queries: compound `app + type + urlHash` predicates, `fetchedAt <= u64(T)` range for "what did it say at time T",
  `createdBy(snapshotter)`, cursor pagination with client-side sorting (no ORDER BY). `src/core/queries.ts`, `web/data.ts`.
- Batch writes: snapshot + diff + page patch + page extension in one `executeBatch`; diff references the new snapshot via
  `predictEntityKeys`. `src/core/plan.ts`, `src/cli/snapshotter.ts`.
- Entity Expiration: page 30 d, snapshot 180 d, diff 365 d, citation 365 d. `src/core/config.ts`.
- Lifetime Extension: page lease renewed on each check; citing extends a snapshot and its diffs to 365 d.
  `src/core/plan.ts`, `src/cli/snapshotter.ts` (`cite`), `web/wallet.ts`.
- Creation flags: snapshots and diffs are `readonly` + `permissionlessExtension`. `src/core/entities.ts`.
- `$creator`: UI queries with `createdBy`, shows creator with explorer links, flags others as untrusted. `web/main.ts`.
- WebSocket events: `watchEntityEvents` over `webSocket()`, no `fromBlock`; UI refreshes on snapshotter events.
  `web/main.ts` (`startLive`), `src/core/client.ts`.

**Wallet addresses.** `0x517bf78c3000991FFbCdf06305F3881382437e98`: snapshotter, creates every `page`, `snapshot` and `diff`
and renews page leases; the only creator the app trusts. (Citations can come from any wallet.)

**How can judges reproduce your Arkiv usage?**
1. `git clone <repo> && cd fine-print-ledger && npm install && npm test`.
2. `npm run snap -- status` lists the pages written by `0x517b…7e98`.
3. Open the live app, pick a page and a version; the page shows "sha256 recomputed in your browser matches contentHash".
4. In "Verify it yourself", copy the curl command and run it: same entities, straight from the Tiramisu RPC.
5. `npm run snap -- verify <url>` re-fetches the live page and compares it to the latest snapshot.
6. `npm run snap -- seed --dry-run` prints the exact batch (attributes, flags, lifetimes, predicted keys) a check would write.
7. Explorer: `https://tiramisu.explorer.arkiv.network/address/0x517bf78c3000991FFbCdf06305F3881382437e98`.

**Pre-existing work reused.** None, except open-source libraries (`@arkiv-network/sdk`, `viem`, `diff`, Vite, Vitest, tsx,
TypeScript).

**Arkiv surfaces used.** TypeScript SDK, Direct JSON-RPC (curl reproduction, verify panel), WebSocket events, Docs,
Block Explorer, Faucet (once funded).

**How long until first entity?** Fill in after the first funded write (code was ready about 2 hours after starting; the
wallet was unfunded).

**Which LLMs did you use?** Claude (Anthropic), via Claude Code.

**One thing Arkiv should improve first.** Make the SDK and node agree on what is queryable (`$createdAt`) and surface the
node's actual error reason (unfunded wallet, query syntax) instead of generic transaction errors.
