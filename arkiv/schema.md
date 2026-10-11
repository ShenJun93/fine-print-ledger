# Fine Print Ledger: Arkiv schema

Network: Tiramisu testnet (chain ID 7738577). SDK: `@arkiv-network/sdk` 0.8.1.
Source of truth in code: [`src/core/entities.ts`](../src/core/entities.ts) (builders and decoders),
[`src/core/queries.ts`](../src/core/queries.ts) (every query), [`src/core/config.ts`](../src/core/config.ts) (lifetimes).

## Who writes what

| Wallet | Role | Writes |
|---|---|---|
| `0x517bf78c3000991FFbCdf06305F3881382437e98` | Snapshotter (the only trusted `$creator`) | `page`, `snapshot`, `diff`; renews page leases |
| Any wallet | Participant / reader | `citation`; Lifetime Extension of snapshots and diffs (they carry `permissionlessExtension`) |

The web app trusts an entity only through its `$creator`, which the chain sets at creation and nobody
can change. Every attribute below can be written by anyone, so none of them is a trust signal on its own.

## Conventions

- Every entity has `app = "fpl"` and `type = <entity type>`. Every query starts with both (compound predicate).
- Numbers that are range-filtered are `u64` (unix seconds or counters). Queries must use `u64(...)` literals too:
  a bare JS number becomes `i32` in the SDK.
- `urlHash` = sha256 (hex) of the canonical URL (lower-case host, no fragment, no `utm_*`, sorted query, no trailing slash).
  See [`canonicalUrl`](../src/core/hash.ts).
- `contentHash` = sha256 (hex) of the normalized page text, i.e. of the decoded snapshot payload. The browser recomputes it.
- Only public page text is stored. No personal data, no secrets.

## Entity types

### `page`: a watched URL

| Attribute | Type | Meaning |
|---|---|---|
| `app` | str | `fpl` |
| `type` | str | `page` |
| `urlHash` | str | sha256 of the canonical URL |
| `domain` | str | host without `www.` |
| `event` | str | contest slug, e.g. `hackapertus` |
| `lastCheckedAt` | u64 | unix seconds of the last check |
| `latestVersion` | u64 | latest snapshot version |
| `latestContentHash` | str | contentHash of that version |

Payload (`application/json`): `{ "url", "title", "event" }`.
Flags: `permissionlessExtension`. Patched on every check (so not `readonly`).

### `snapshot`: what the page said at one fetch

| Attribute | Type | Meaning |
|---|---|---|
| `app`, `type` | str | `fpl`, `snapshot` |
| `urlHash`, `domain`, `event` | str | as on the page |
| `fetchedAt` | u64 | unix seconds of the HTTP response |
| `version` | u64 | 1, 2, 3… per page |
| `contentHash` | str | sha256 of the normalized text |
| `sizeBytes` | u64 | UTF-8 size of the normalized text |

Payload: normalized text, `text/plain` (UTF-8). If the text is over 96 KiB it is gzip-compressed and the
content type is `application/gzip` (engine limit: 128 KiB per payload).
Flags: `readonly` (the text can never be edited, not even by the snapshotter) and `permissionlessExtension`.

### `diff`: the change between two consecutive snapshots

| Attribute | Type | Meaning |
|---|---|---|
| `app`, `type` | str | `fpl`, `diff` |
| `urlHash`, `domain`, `event` | str | as on the page |
| `fromVersion`, `toVersion` | u64 | versions compared |
| `changedAt` | u64 | unix seconds the change was detected (= `fetchedAt` of `toVersion`) |
| `addedLines`, `removedLines` | u64 | line counts |
| `fromSnapshot` | key | entity key of the older snapshot |
| `toSnapshot` | key | entity key of the newer snapshot, predicted with `predictEntityKeys` because it is created in the same batch |

Payload: unified diff (`text/plain`, 2 lines of context).
Flags: `readonly`, `permissionlessExtension`.

### `citation`: someone pins a snapshot as evidence

| Attribute | Type | Meaning |
|---|---|---|
| `app`, `type` | str | `fpl`, `citation` |
| `urlHash` | str | page cited |
| `snapshot` | key | entity key of the cited snapshot |
| `version` | u64 | its version |
| `citedAt` | u64 | unix seconds |

Payload (`application/json`): `{ "note", "snapshotKey", "contentHash" }`. The note is a short public remark
(max 280 characters, no personal data). Created by any wallet; the UI shows its `$creator`.

## Entity Expiration per type

Lifetimes are set with `ExpirationTime.fromDays(n)`; at 2-second blocks one day is 43,200 blocks.

| Type | Lifetime | Why | Lifetime Extension |
|---|---|---|---|
| `page` | 30 days (1,296,000 blocks) | A watch is a lease. A page nobody checks any more drops out by itself. | Every check (changed or not) sets it to 30 days from now, in the same batch as the check. |
| `snapshot` | 180 days | Covers a contest, its judging and a dispute window. | Citing it sets it to 365 days from the citation. Anyone can do this (`permissionlessExtension`). |
| `diff` | 365 days | The diff is the evidence people need in a dispute ("the prize changed on this date"), so it outlives the snapshots. | Citing a snapshot also extends the diffs that touch it to 365 days. |
| `citation` | 365 days | Same horizon as the evidence it extends. | — |

## Writes (all atomic batches via `executeBatch`)

| When | Batch |
|---|---|
| First check of a URL | create `page` + create `snapshot` v1 |
| Content changed | create `snapshot` vN+1 + create `diff` vN→vN+1 (with `toSnapshot` = predicted key) + patch `page` (`lastCheckedAt`, `latestVersion`, `latestContentHash`) + extend `page` 30 days |
| Content unchanged | patch `page` (`lastCheckedAt`) + extend `page` 30 days |
| Citation (CLI or browser wallet) | create `citation` + extend `snapshot` 365 days + extend each `diff` touching it 365 days |

Code: [`src/core/plan.ts`](../src/core/plan.ts) (`planCheck`), [`src/cli/snapshotter.ts`](../src/cli/snapshotter.ts) (`snap`, `cite`),
[`web/wallet.ts`](../web/wallet.ts) (browser citation).

## Queries the app runs

All of them select `key, creator, owner, createdAt, expiresAt, creationFlags, contentType, attributes` (+ `payload`
where the text is shown), use `.limit(50)` and walk further pages with the cursor (`QueryResult.next()`).
Arkiv has no ORDER BY, so every list is sorted in the client (versions descending, pages by `lastCheckedAt`).
`<S>` below is `$creator = addr(0x517bf78c3000991FFbCdf06305F3881382437e98)`, added with `.createdBy(snapshotter)`.
The "show untrusted" toggle drops `<S>` and labels every other creator in red.

| # | Purpose | Query string (exactly what the node receives) | Where |
|---|---|---|---|
| Q1 | Watched pages (home list) | `app = str('fpl') AND type = str('page') AND <S>` | web `listPages`, CLI `status` |
| Q2 | Page by URL | `app = str('fpl') AND type = str('page') AND urlHash = str('<h>') AND <S>` | CLI `snap` (`findPage`) |
| Q3 | Latest snapshot by version (equality) | `app = str('fpl') AND type = str('snapshot') AND urlHash = str('<h>') AND version = u64(<n>) AND <S>` | CLI `snap` (`findLatestSnapshot`) |
| Q4 | Version timeline of a page | `app = str('fpl') AND type = str('snapshot') AND urlHash = str('<h>') AND <S>` | web detail, CLI `history`, fallback of Q3 |
| Q5 | Snapshots in a time window (range) | Q4 `AND fetchedAt >= u64(<from>) AND fetchedAt <= u64(<to>)` | `snapshotsQuery(…, { fetchedAt })` |
| Q6 | "What did it say at time T?" (range) | `app = str('fpl') AND type = str('snapshot') AND urlHash = str('<h>') AND fetchedAt <= u64(<T>) AND <S>`, newest `fetchedAt` wins | web "What did it say on…", CLI `verify --at` |
| Q7 | Diffs of a page | `app = str('fpl') AND type = str('diff') AND urlHash = str('<h>') AND <S>` | web detail, CLI `history`, CLI `cite` |
| Q8 | Recent changes everywhere (range) | `app = str('fpl') AND type = str('diff') AND changedAt >= u64(<since>) AND <S>` | `recentDiffsQuery` |
| Q9 | Citations of a page (any creator) | `app = str('fpl') AND type = str('citation') AND urlHash = str('<h>')` | web detail |
| Q10 | One entity by key | `getEntity(key)` | CLI `cite`, live feed |

Live updates: `watchEntityEvents` over `webSocket("wss://rpc.tiramisu.db-chain.testnet.arkiv.network")`, no `fromBlock`.
Events from the snapshotter (or about entities on screen) trigger a `getEntity` and a re-run of Q1/Q4/Q7/Q9.

Reproduce any query with curl (the web app's "Verify it yourself" panel prints the exact command):

```sh
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["app = str('\''fpl'\'') AND type = str('\''page'\'') AND $creator = addr(0x517bf78c3000991FFbCdf06305F3881382437e98)",{"select":{"key":true,"creator":true,"attributes":true,"payload":true},"limit":"0x32"}]}'
```

## What stays off Arkiv

- The raw HTML (scripts, trackers, styles): only normalized text is stored. The normalizer is open source, so anyone
  can re-derive the same text and hash from the live page.
- The snapshotter's private key: read from `ARKIV_PRIVATE_KEY` in the environment, never logged.
- Any personal data: rules pages are public documents; participant lists, emails and profiles are never fetched.
