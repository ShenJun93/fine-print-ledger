# Build notes (status as of 2026-10-11)

Arkiv: Global Tour Stop, deadline 2026-10-18 22:59 UTC. Everything below is local; nothing has been pushed,
deployed or submitted.

## Status

| Area | State |
|---|---|
| Core (normalize, hash, diff, payload, entity builders, queries, batch planner) | Done, 32 unit tests pass (`npm test`), `npm run typecheck` clean |
| Snapshotter CLI (`status`, `snap`, `seed`, `history`, `verify`, `cite`, `watch`, `--dry-run`) | Done. `seed` wrote all 5 pages on Tiramisu; `verify` re-fetched Hack Apertus and reported IDENTICAL to v1 |
| Web app (Vite static, no backend) | Done. `npm run dev` shows the 5 on-chain pages; for each, the browser recomputes the snapshot sha256 and it matches `content_hash`. WebSocket live feed works with no HTTP polling; 375 px layout has no horizontal overflow |
| `arkiv/schema.md`, `arkiv/friction.md`, README, MIT LICENSE, `vercel.json` | Done |
| On-chain entities | **10 entities (5 `page` + 5 `snapshot` v1), 5 transactions, all verified** |

### Wallet

- Snapshotter: `0x517bf78c3000991FFbCdf06305F3881382437e98` (key in git-ignored `.env.local`; checked that the key
  string appears in no other file in the repo or the build output).
- Funded with 10 GLM by the owner on 2026-10-11. After the repro (1 tiny entity) and the seed: **9.99823 GLM** left
  (the seed cost about 0.0003 GLM per page).

### First write attempt failed: uppercase attribute names

The first real `seed` reverted for all 5 pages: Tiramisu rejects uppercase bytes in attribute names (`lastCheckedAt`),
although SDK 0.8.1 validates them as legal and its error message lists "A"-"Z" as allowed. Confirmed with a minimal repro
(`scripts/repro-uppercase-attr.ts`): `checkedAt` reverted (no tx hash, failed at gas estimation), `checked_at` succeeded in
tx `0x14cc44dc68519f55461d2ce64776edf3f7488e6bfb5844bbeb92d29ad045c508` (entity
`0x96a79f3821fbd0b380d673bd34c56e628f4b2de87601562f0406d078301567ec`, attributes `repro`/`checked_at`, expires after 1 hour).
Every attribute is now lowercase snake_case; a unit test guards it. Details: `arkiv/friction.md` #1.

### Verified on chain (seed, 2026-10-11, blocks 416231-416248)

Each transaction is one atomic batch creating the `page` and its `snapshot` v1. All 10 created keys equal the keys
predicted by `predictEntityKeys`; all 5 receipts are `status=success` from the snapshotter; each transaction was opened on
the explorer (status Success, both CREATE operations listed with the expected keys, attributes and lifetimes 30 d / 180 d).
Read back with `scripts/readback.ts` (queries with `createdBy(0x517b…7e98)`): 5 pages, 5 snapshots, every payload hash
matches `content_hash`, snapshots `readonly` + `permissionlessExtension`, pages `permissionlessExtension`.

| Event | Transaction | Page entity | Snapshot v1 entity |
|---|---|---|---|
| zindi-bias-bounty-mapping-equity | [`0x5f440e4e76e44b0830ce6b8e71431cd463e67547fe6bedbcbc9d708afaee412a`](https://tiramisu.explorer.arkiv.network/tx/0x5f440e4e76e44b0830ce6b8e71431cd463e67547fe6bedbcbc9d708afaee412a) | `0x5c2fe5cd6002bbc088dba2ba0490e4a719b00bd97d698495202914e5180afef3` | `0x7526b02463411ef25cd13d0624141216df589145775fa4fd5c7b1c63869da9c8` (4,227 B) |
| hackapertus | [`0xe133ffea78ea3dca40e17cff4ffec8146628c2dd2dc6ea5cea1b33da5e9a1859`](https://tiramisu.explorer.arkiv.network/tx/0xe133ffea78ea3dca40e17cff4ffec8146628c2dd2dc6ea5cea1b33da5e9a1859) | `0x63afdc27cf53daaf7999f759c318e29fb0983ba4ebe93afe5a3f76c9e596e675` | `0xcd05dfae58414b452ddb8163234c07cbd4f25ea5744bab79c1a8b5cbd15ac8ba` (795 B) |
| arkiv-global-tour-stop | [`0x562a6687719b8bb85736ee3c8bacae6703fb52037f4c091213a380a2a0fa3ee9`](https://tiramisu.explorer.arkiv.network/tx/0x562a6687719b8bb85736ee3c8bacae6703fb52037f4c091213a380a2a0fa3ee9) | `0x8028ee67ceeead2ce9ef1ea156eab34a200cd78043015eb8ac31a8a3f92192ec` | `0x3dda3057601edf30ec0a92895e445831057258f8c82f7164112fe1aac166b471` (9,419 B) |
| airwallex-agentic-banking | [`0x1c6aabffc36bb3a5d44a920296fb8cf0577532a3d8f0c97ed156701aa5276b6d`](https://tiramisu.explorer.arkiv.network/tx/0x1c6aabffc36bb3a5d44a920296fb8cf0577532a3d8f0c97ed156701aa5276b6d) | `0xac90dc3f7eed517aac38a5121611d7838addc373606524ac95dfdce569008d85` | `0x236ab765d1e1ef380634614aafea7433322de5423474885f8f8927687e541c89` (5,117 B) |
| ai-philosophy-competition | [`0xa5ced4e38c3ba3b5df98e28c783ee62916d8630f543bd216b0df6ca8f6631869`](https://tiramisu.explorer.arkiv.network/tx/0xa5ced4e38c3ba3b5df98e28c783ee62916d8630f543bd216b0df6ca8f6631869) | `0x630f6bc86378adc6bba0710bfc6a5b947a2e427c93c7e5af88232223217878bf` | `0x1543f40ad04ccb32d2fbc4b6da07cf3b33f6756119a8d5a24bc451f0a334ebe5` (2,921 B) |

Page leases expire around 2026-11-10 (renewed by every re-check); snapshots around 2027-04-09.

## What remains (in order)

1. Run `npm run snap -- seed` again a day or more later (and before the deadline) so pages get re-checked (patch +
   Lifetime Extension on chain) and, if a page changed, a v2 + diff batch. If no page changes by itself, there is no honest
   way to force a diff on a real page; say so in the demo and show the "unchanged → lease renewed" path plus the fixture
   for the diff viewer.
2. Test a citation from a second wallet (`npm run snap -- cite <snapshotKey> --note "…"` with a different funded key,
   or the browser "Cite" button with MetaMask). The browser wallet path (`web/wallet.ts`) is **untested**.
3. Update `arkiv/friction.md` "Still to test" with real results (extension by a second wallet, diff batch, cursor > 50 rows).
4. Owner: create the public GitHub repo, push, deploy to Vercel (static: `npm run build`, output `dist/`), record the URL.
5. Demo video (≤ 3 min): problem (Zindi data page / Devpost "we reserve the right to update"), seed run, web app timeline +
   hash check + verify panel curl, untrusted toggle, live feed, citation extending a snapshot.
6. Fill the Devfolio form (drafts below). First Arkiv entity: written within 2 hours of starting work on the code
   (the repro entity), so "2 hours or less" is defensible; owner to confirm.

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

**Challenges I ran into.** Our first real write reverted for every page because Tiramisu rejects uppercase letters in
attribute names, although the SDK validates them as legal and its error message lists "A"-"Z" as allowed; we confirmed it
with a two-entity repro and renamed everything to snake_case. A bare JS number in a query becomes `i32` and silently
matches nothing against `u64` attributes (5 rows vs 0). The SDK refuses `$createdAt` range predicates that the node accepts, so we store our own
`fetched_at`; an unfunded wallet surfaces as "Execution error without revert data" with the real reason five causes deep;
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
- Attributes vs payload: everything filtered on is a typed attribute (`u64` for `fetched_at`, `version`, `changed_at`); text and
  diffs are payloads. `src/core/entities.ts`.
- Queries: compound `app + type + url_hash` predicates, `fetched_at <= u64(T)` range for "what did it say at time T",
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
3. Open the live app, pick a page and a version; the page shows "sha256 recomputed in your browser matches content_hash".
4. In "Verify it yourself", copy the curl command and run it: same entities, straight from the Tiramisu RPC.
5. `npm run snap -- verify <url>` re-fetches the live page and compares it to the latest snapshot.
6. `npm run snap -- seed --dry-run` prints the exact batch (attributes, flags, lifetimes, predicted keys) a check would write.
7. Explorer: `https://tiramisu.explorer.arkiv.network/address/0x517bf78c3000991FFbCdf06305F3881382437e98`.

**Pre-existing work reused.** None, except open-source libraries (`@arkiv-network/sdk`, `viem`, `diff`, Vite, Vitest, tsx,
TypeScript).

**Arkiv surfaces used.** TypeScript SDK, Direct JSON-RPC (curl reproduction, verify panel), WebSocket events, Docs,
Block Explorer, Faucet.

**How long until first entity?** Owner to confirm: the code was ready about 2 hours after starting; the first entity was
written as soon as the wallet was funded (after one failed attempt, see friction #1).

**Which LLMs did you use?** Claude (Anthropic), via Claude Code.

**One thing Arkiv should improve first.** Make the SDK's validation match the engine: the SDK accepted uppercase attribute
names and `$createdAt` predicates that the engine treats differently, so we only found out on chain. Validate client-side
exactly what the engine enforces, and surface the engine's real reason (unfunded wallet, query syntax) in error messages.
