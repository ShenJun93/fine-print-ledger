# Fine Print Ledger

**What did the rules say, and when did they change?**

Hackathon and bounty organisers edit their rules and prize terms mid-contest. Participants then have no way to prove
what the page said when they signed up. Screenshots are easy to fake, and the Wayback Machine only captures some pages,
when it gets to them.

Fine Print Ledger snapshots public rules and terms pages onto [Arkiv](https://arkiv.network), the Web3 database. Each
snapshot is an Arkiv entity created `readonly` by one known wallet, so nobody (including us) can change it afterwards,
and anyone can read it straight from the chain, without our server. When a page changes, the new snapshot and the diff
that explains it land together in one atomic batch.

Real pages it watches (see [`targets.json`](targets.json)):

| Page | Why |
|---|---|
| zindi.world · Bias Bounty Mapping Equity Challenge / data | The page still lists reference layers that the data bucket removed on 2026-09-25. |
| hackapertus.devpost.com/rules | "We, as organizers, reserve the right to update the contest timeline." |
| arkiv.devfolio.co/overview | The official source for this challenge's rules. |
| airwallex.hackerearth.com | Prize and eligibility terms on a landing page. |
| zacharygoodsell.com · AI Philosophy Competition rules | Self-hosted rules with no public change history. |

Only public page text is stored: no participant data, no HTML, no scripts.

## How it works

```
  public rules page ──fetch──► snapshotter CLI ──normalize, sha256, diff──► one atomic Arkiv batch
                                (Node, our key)                              ├─ snapshot vN+1 (readonly)
                                                                             ├─ diff vN→vN+1 (refers to both by key)
                                                                             └─ page: patch + Lifetime Extension
  browser ──arkiv_query (HTTP) + watchEntityEvents (WebSocket)──► Tiramisu RPC      (no backend in between)
```

- **Trust comes from `$creator` only.** The web app queries with `createdBy(0x517b…7e98)` and labels every other creator
  as untrusted. Anyone can write an entity with the same `urlHash` and `event`; toggle "Also show entities from other
  creators" to see them flagged in red.
- **Verify it yourself.** The browser re-hashes every snapshot payload and compares it with its `contentHash`. The
  side panel prints the exact query string, a curl command and an SDK snippet for everything on screen, and the CLI can
  re-fetch the live page and compare (`npm run snap -- verify <url>`).
- **Entity Expiration follows the product.** Page watches are 30-day leases renewed by each check; snapshots live 180
  days; diffs 365 days. Citing a snapshot extends it (and its diffs) to 365 days, and because snapshots carry the
  `permissionlessExtension` flag, any participant's wallet can do that.

Details: [`arkiv/schema.md`](arkiv/schema.md) (entities, attributes, expiration, every query) and
[`arkiv/friction.md`](arkiv/friction.md) (what got in the way).

## Setup

Requirements: Node 20 or newer (tested on 24.20.0).

```sh
npm install
npm test            # 29 unit tests, no network
npm run typecheck
```

### Read-only (no wallet needed)

```sh
npm run snap -- status                                   # chain, snapshotter balance, watched pages
npm run snap -- history https://hackapertus.devpost.com/rules
npm run snap -- verify  https://hackapertus.devpost.com/rules [--at 2026-10-12T00:00:00Z]
npm run snap -- seed --dry-run                           # fetch every target, print the batches it would write
npm run snap -- watch                                    # live entity events over WebSocket
```

`--dry-run` fetches and normalizes the page, reads the latest trusted snapshot from Arkiv, predicts the entity keys,
and prints every attribute, flag and lifetime it would write, without signing anything.

### Writing snapshots

Create `.env.local` (git-ignored) with the snapshotter key, fund the address from the Tiramisu faucet, then:

```sh
# .env.local
ARKIV_PRIVATE_KEY=0x...        # never commit, never paste anywhere

npm run snap -- seed                                     # snapshot every target in targets.json
npm run snap -- snap <url> --event <slug>                # one page
npm run snap -- cite <snapshotKey> --note "rules on the day I registered"
```

Running `seed` again later re-checks every page: unchanged pages get their lease renewed; changed pages get a new
snapshot and diff. To snapshot on a schedule, run `npm run snap -- seed` from cron or a CI job.

To trust a different snapshotter, set `FPL_TRUSTED_SNAPSHOTTERS` (CLI) and `VITE_TRUSTED_SNAPSHOTTERS` (web build),
comma-separated.

### Web app

```sh
npm run dev          # http://localhost:5173
npm run build        # static files in dist/
```

The build is a static site (Vite, no server code). `vercel.json` is included: import the repo in Vercel, or serve
`dist/` from any static host. `?fixture=1` loads a synthetic, clearly labelled in-browser dataset built with the same
entity builders, for development before the wallet is funded.

## Reproduce our Arkiv usage

1. `npm install && npm test`.
2. `npm run snap -- status`: shows the snapshotter `0x517bf78c3000991FFbCdf06305F3881382437e98` and the pages it has written.
3. Open the web app, pick a page, pick a version. Check "sha256 recomputed in your browser matches contentHash".
4. Copy the curl command from "Verify it yourself" into a terminal: it returns the same entities straight from the RPC.
5. `npm run snap -- verify <url>`: re-fetches the live page and tells you whether it still matches the latest snapshot.
6. On the explorer, open the snapshotter address to see the creation transactions:
   https://tiramisu.explorer.arkiv.network/address/0x517bf78c3000991FFbCdf06305F3881382437e98

## Layout

```
src/core/      shared by CLI and browser: normalize, hash, diff, payload, entity builders/decoders, queries, plan
src/cli/       snapshotter CLI (fetch, plan, executeBatch, cite, verify, watch)
web/           static web app (Vite): data layer, live feed, verify panel, wallet citation, fixture
test/          vitest unit tests (no network)
arkiv/         schema.md, friction.md
targets.json   seed pages
```

## Licence

MIT, see [LICENSE](LICENSE).
