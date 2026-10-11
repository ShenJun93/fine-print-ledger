/**
 * Read-back check after a seed run: for every trusted page, query its snapshots with
 * createdBy(snapshotter), re-hash each payload, print flags and expiry, and confirm the creation
 * transaction receipt succeeded. Read-only.
 *
 *   npx tsx scripts/readback.ts [txHash ...]
 */
import { existsSync } from "node:fs"
import { u64 } from "@arkiv-network/sdk"
import { eq } from "@arkiv-network/sdk/query"
import type { Hex } from "viem"
import { httpClient } from "../src/core/client"
import { DEFAULT_TRUSTED_SNAPSHOTTERS } from "../src/core/config"
import { decodePage, decodeSnapshot } from "../src/core/entities"
import { sha256Hex } from "../src/core/hash"
import { decodeText } from "../src/core/payload"
import { fetchAll, pagesQuery, queryText, snapshotsQuery, type TrustMode } from "../src/core/queries"

if (existsSync(".env.local")) process.loadEnvFile(".env.local") // ARKIV_ACCESS_KEY, if set
const client = httpClient()
const trust: TrustMode = { kind: "trusted", creators: [...DEFAULT_TRUSTED_SNAPSHOTTERS] }
const timing = await client.getBlockTiming()
const toDate = (b: bigint) =>
  new Date((timing.currentBlockTime + Number(b - timing.currentBlock) * timing.blockDuration) * 1000)
    .toISOString()
    .slice(0, 10)

const pq = pagesQuery(trust)
const pages = (await fetchAll(client, pq, { withPayload: true })).entities.map(decodePage)
console.log(`Q1 ${queryText(pq)}\n   -> ${pages.length} pages\n`)
for (const p of pages) {
  const sq = snapshotsQuery(p.urlHash, trust)
  const snaps = (await fetchAll(client, sq, { withPayload: true })).entities.map(decodeSnapshot)
  console.log(`page ${p.key}  ${p.event}  v${p.latestVersion}  creator ${p.creator}  expires block ${p.expiresAt} (~${toDate(p.expiresAt)})  permissionlessExtension=${p.permissionlessExtension} readonly=${p.readonly}  ignore=${JSON.stringify(p.ignore)}`)
  for (const s of snaps) {
    const text = await decodeText(s.payload!, s.contentType)
    const ok = (await sha256Hex(text)) === s.contentHash
    console.log(`  snapshot v${s.version} ${s.key}  ${s.sizeBytes}B ${s.contentType}  hash ${ok ? "OK" : "MISMATCH"}  readonly=${s.readonly} permissionlessExtension=${s.permissionlessExtension}  expires ~${toDate(s.expiresAt)}`)
  }
}

// entry 7 of friction.md: does an i32 literal match a u64-stored attribute?
const base = [eq("app", "fpl"), eq("type", "snapshot"), eq("version", u64(1))]
const asU64 = await client.select({ key: true }).where(base).createdBy(trust.creators[0] as Hex).fetch()
const asI32 = await client
  .select({ key: true })
  .where([eq("app", "fpl"), eq("type", "snapshot"), eq("version", 1)])
  .createdBy(trust.creators[0] as Hex)
  .fetch()
console.log(`\nversion = u64(1): ${asU64.entities.length} rows;  version = i32(1): ${asI32.entities.length} rows`)

for (const h of process.argv.slice(2)) {
  const r = await client.getTransactionReceipt({ hash: h as Hex })
  console.log(`tx ${h} status=${r.status} block=${r.blockNumber} from=${r.from} logs=${r.logs.length}`)
}
