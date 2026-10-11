#!/usr/bin/env node
/**
 * Fine Print Ledger snapshotter.
 *
 *   npm run snap -- status
 *   npm run snap -- snap <url> --event <slug> [--dry-run]
 *   npm run snap -- seed [--dry-run]                      every target in targets.json
 *   npm run snap -- history <url>
 *   npm run snap -- verify <url> [--at 2026-10-12T00:00:00Z]
 *   npm run snap -- cite <snapshotKey> --note "<text>" [--dry-run]
 *   npm run snap -- watch                                 live entity events over WebSocket
 *
 * Writes need ARKIV_PRIVATE_KEY in the environment (or in .env.local). The key is only passed to
 * viem's privateKeyToAccount and is never printed. Reads need nothing.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createWalletClient, type PublicArkivClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { formatEther, type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { findLatestSnapshot, findPage, httpClient, wsClient } from "../core/client"
import {
  APP,
  DEFAULT_TRUSTED_SNAPSHOTTERS,
  explorerAddressUrl,
  explorerTxUrl,
  TIRAMISU,
} from "../core/config"
import { diffStats } from "../core/diff"
import {
  buildCitationCreate,
  buildCitedExtension,
  decodeDiff,
  decodePage,
  decodeSnapshot,
} from "../core/entities"
import { sha256Hex, urlHash } from "../core/hash"
import { decodeText } from "../core/payload"
import { type CheckPlan, describeBatch, planCheck } from "../core/plan"
import {
  asOfQuery,
  curlFor,
  diffsQuery,
  fetchAll,
  pagesQuery,
  queryText,
  snapshotsQuery,
  type TrustMode,
} from "../core/queries"
import { fetchPage } from "./fetchPage"

// ---------------------------------------------------------------------------------------------
// args / env

type Args = { _: string[]; flags: Record<string, string | true> }
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const name = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[name] = next
        i++
      } else out.flags[name] = true
    } else out._.push(a)
  }
  return out
}

function loadEnv(): void {
  const file = resolve(process.cwd(), ".env.local")
  if (existsSync(file) && typeof process.loadEnvFile === "function") process.loadEnvFile(file)
}

function trustedCreators(): Hex[] {
  const fromEnv = process.env.FPL_TRUSTED_SNAPSHOTTERS?.split(",").map((s) => s.trim()).filter(Boolean)
  return (fromEnv?.length ? fromEnv : [...DEFAULT_TRUSTED_SNAPSHOTTERS]) as Hex[]
}

function trust(): TrustMode {
  return { kind: "trusted", creators: trustedCreators() }
}

function wallet() {
  const pk = process.env.ARKIV_PRIVATE_KEY?.trim()
  if (!pk) throw new Error("ARKIV_PRIVATE_KEY is not set (put it in .env.local; never commit it)")
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex)
  return createWalletClient({ chain: tiramisu, transport: http(TIRAMISU.http), account })
}

/** The snapshotter's address, from the key if present, else the configured trusted address. */
function snapshotterAddress(): Hex {
  const pk = process.env.ARKIV_PRIVATE_KEY?.trim()
  if (pk) return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex).address
  return trustedCreators()[0]!
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2)

const iso = (s: number) => new Date(s * 1000).toISOString()

/**
 * SDK 0.8.1 reports e.g. an unfunded wallet as "Transaction failed: Execution error without revert
 * data"; the node's actual reason sits several causes deep. Surface it. (arkiv/friction.md #3)
 */
function rootCause(e: unknown): string {
  const parts: string[] = []
  let c: unknown = e
  for (let i = 0; c && i < 8; i++) {
    const err = c as { message?: string; details?: string; cause?: unknown }
    if (i === 0 && err.message) parts.push(err.message.split("\n")[0]!)
    if (err.details && !parts.includes(err.details)) parts.push(err.details)
    c = err.cause
  }
  return parts.join(" <- ")
}

/** Fail fast with a clear message instead of an opaque gas-estimation error. */
async function requireFunds(client: PublicArkivClient, address: Hex) {
  const balance = await client.getBalance({ address })
  if (balance === 0n) {
    throw new Error(
      `snapshotter ${address} has 0 GLM on Tiramisu. Fund it from the faucet, or re-run with --dry-run.`,
    )
  }
}

// ---------------------------------------------------------------------------------------------
// commands

async function status(client: PublicArkivClient) {
  const address = snapshotterAddress()
  const [chainId, block, balance] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getBalance({ address }),
  ])
  console.log(`chain        ${chainId} (Tiramisu)  block ${block}`)
  console.log(`snapshotter  ${address}  ${explorerAddressUrl(address)}`)
  console.log(`balance      ${formatEther(balance)} GLM${balance === 0n ? "  <- unfunded: writes will fail, use --dry-run" : ""}`)
  const pages = await fetchAll(client, pagesQuery(trust()), { withPayload: true })
  console.log(`pages        ${pages.entities.length} trusted page entities (app=${APP})`)
  for (const p of pages.entities.map(decodePage)) {
    console.log(`  v${p.latestVersion}  ${p.event.padEnd(34)} ${p.url}  checked ${iso(p.lastCheckedAt)}`)
  }
}

async function plan(client: PublicArkivClient, url: string, event: string, addr: Hex) {
  const fetched = await fetchPage(url)
  const uh = await urlHash(fetched.url)
  const page = await findPage(client, uh, trust())
  const latest = page ? await findLatestSnapshot(client, page, trust()) : undefined
  const input = {
    url: fetched.url,
    event: page?.event || event,
    title: fetched.title,
    text: fetched.text,
    fetchedAt: fetched.fetchedAt,
    page,
    latest,
  }
  const draft = await planCheck(input)
  // Predict the keys of the creates so the diff can reference the snapshot created in the same
  // batch. Read-only (eth_call for the entity nonce), so it also works in --dry-run.
  const predicted =
    draft.createCount > 0
      ? await client.predictEntityKeys({ owner: addr, count: draft.createCount })
      : []
  const final = await planCheck(input, predicted as { key: Hex; salt: bigint }[])
  return { fetched, plan: final, predicted: predicted as { key: Hex; salt: bigint }[] }
}

async function snap(client: PublicArkivClient, url: string, event: string, dryRun: boolean) {
  const addr = snapshotterAddress()
  const { fetched, plan: p, predicted } = await plan(client, url, event, addr)
  printPlan(p, fetched.title)
  if (predicted.length) {
    console.log(`  predicted keys: ${predicted.map((k) => k.key).join(", ")}`)
  }
  if (dryRun) {
    console.log(json(describeBatch(p.batch)))
    console.log("  --dry-run: nothing written")
    return { plan: p }
  }
  await requireFunds(client, addr)
  const w = wallet()
  const res = await w.executeBatch(p.batch)
  console.log(`  tx ${res.txHash}  ${explorerTxUrl(res.txHash)}`)
  if (res.createdEntities.length) console.log(`  created ${res.createdEntities.join(", ")}`)
  const mismatch = res.createdEntities.some((k, i) => predicted[i] && predicted[i]!.key.toLowerCase() !== k.toLowerCase())
  if (mismatch) console.warn("  WARNING: created keys differ from predicted keys (nonce moved?)")
  return { plan: p, tx: res.txHash, created: res.createdEntities }
}

function printPlan(p: CheckPlan, title: string) {
  console.log(`\n${p.kind.toUpperCase().padEnd(9)} ${p.url}`)
  console.log(`  title "${title}"  ${p.sizeBytes} bytes  sha256 ${p.contentHash}`)
  console.log(`  urlHash ${p.urlHash}  version v${p.version}`)
  if (p.diff) console.log(`  diff +${p.diff.addedLines} -${p.diff.removedLines} lines`)
  console.log(
    `  batch: ${p.batch.creates.length} create, ${p.batch.patches.length} patch, ${p.batch.extensions.length} extend`,
  )
}

async function seed(client: PublicArkivClient, dryRun: boolean) {
  const targets = JSON.parse(readFileSync(resolve(process.cwd(), "targets.json"), "utf8")) as {
    url: string
    event: string
  }[]
  const results: unknown[] = []
  for (const t of targets) {
    try {
      const r = await snap(client, t.url, t.event, dryRun)
      results.push({ url: t.url, kind: r.plan.kind, version: r.plan.version, tx: "tx" in r ? r.tx : undefined })
    } catch (e) {
      console.error(`  FAILED ${t.url}: ${rootCause(e)}`)
      results.push({ url: t.url, error: rootCause(e) })
    }
  }
  console.log(`\n${json(results)}`)
}

async function history(client: PublicArkivClient, url: string) {
  const uh = await urlHash(url)
  const sq = snapshotsQuery(uh, trust())
  const dq = diffsQuery(uh, trust())
  const [s, d] = await Promise.all([fetchAll(client, sq), fetchAll(client, dq)])
  console.log(`urlHash ${uh}`)
  console.log(`query   ${queryText(sq)}`)
  for (const r of s.entities.map(decodeSnapshot).sort((a, b) => a.version - b.version)) {
    console.log(`  v${r.version}  ${iso(r.fetchedAt)}  ${r.sizeBytes}B  ${r.contentHash.slice(0, 16)}  ${r.key}  creator ${r.creator}`)
  }
  for (const r of d.entities.map(decodeDiff).sort((a, b) => a.toVersion - b.toVersion)) {
    console.log(`  diff v${r.fromVersion}->v${r.toVersion}  ${iso(r.changedAt)}  +${r.addedLines} -${r.removedLines}  ${r.key}`)
  }
  console.log(`\nreproduce with curl:\n${curlFor(sq)}`)
}

/**
 * Independent verification: fetch the page now, normalize it with the same code, and compare its
 * hash to the trusted snapshot (latest, or as of --at). Also re-hashes the stored payload to
 * prove the snapshot's contentHash attribute matches its own content.
 */
async function verify(client: PublicArkivClient, url: string, at?: string) {
  const uh = await urlHash(url)
  const when = at ? Math.floor(new Date(at).getTime() / 1000) : Math.floor(Date.now() / 1000)
  const spec = asOfQuery(uh, when, trust())
  const { entities } = await fetchAll(client, spec, { withPayload: true })
  const snap = entities.map(decodeSnapshot).sort((a, b) => b.fetchedAt - a.fetchedAt)[0]
  console.log(`query   ${queryText(spec)}`)
  if (!snap?.payload) {
    console.log("no trusted snapshot at or before that time")
    return
  }
  const stored = await decodeText(snap.payload, snap.contentType)
  const storedHash = await sha256Hex(stored)
  console.log(`snapshot v${snap.version}  fetched ${iso(snap.fetchedAt)}  key ${snap.key}`)
  console.log(`creator  ${snap.creator}  ${trustedCreators().some((c) => c.toLowerCase() === snap.creator.toLowerCase()) ? "(trusted snapshotter)" : "(NOT TRUSTED)"}`)
  console.log(`payload hash ${storedHash === snap.contentHash ? "matches" : "DOES NOT MATCH"} contentHash attribute ${snap.contentHash}`)
  const live = await fetchPage(url)
  const liveHash = await sha256Hex(live.text)
  if (liveHash === snap.contentHash) {
    console.log(`live page now: IDENTICAL to v${snap.version}`)
  } else {
    const st = diffStats(stored, live.text)
    console.log(`live page now: DIFFERENT from v${snap.version} (+${st.addedLines} -${st.removedLines} lines)  live sha256 ${liveHash}`)
  }
}

async function cite(client: PublicArkivClient, snapshotKey: Hex, note: string, dryRun: boolean) {
  const e = await client.getEntity(snapshotKey)
  const s = decodeSnapshot(e)
  if (e.attributes?.app?.value !== APP || e.attributes?.type?.value !== "snapshot") {
    throw new Error(`${snapshotKey} is not a Fine Print Ledger snapshot`)
  }
  // Diffs that touch this snapshot are evidence too; keep them alive with it.
  const diffs = (await fetchAll(client, diffsQuery(s.urlHash, trust()))).entities
    .map(decodeDiff)
    .filter((d) => [d.fromSnapshot, d.toSnapshot].some((k) => k.toLowerCase() === snapshotKey.toLowerCase()))
  const batch = {
    creates: [
      buildCitationCreate({
        urlHash: s.urlHash,
        snapshotKey,
        version: s.version,
        contentHash: s.contentHash,
        citedAt: Math.floor(Date.now() / 1000),
        note,
      }),
    ],
    extensions: [buildCitedExtension(snapshotKey), ...diffs.map((d) => buildCitedExtension(d.key))],
    patches: [],
  }
  console.log(`cite v${s.version} of ${s.urlHash}; extends snapshot + ${diffs.length} diff(s)`)
  console.log(json(describeBatch(batch)))
  if (dryRun) return console.log("--dry-run: nothing written")
  const w = wallet()
  await requireFunds(client, w.account.address)
  const res = await w.executeBatch(batch)
  console.log(`tx ${res.txHash}  ${explorerTxUrl(res.txHash)}  citation ${res.createdEntities[0]}`)
}

function watch() {
  const ws = wsClient()
  const creators = new Set(trustedCreators().map((c) => c.toLowerCase()))
  console.log(`watching ${TIRAMISU.ws} for entity events (Ctrl+C to stop)`)
  ws.watchEntityEvents({
    onEvent: (ev) => {
      const owner = "owner" in ev ? ev.owner : ev.newOwner
      const mark = creators.has(owner.toLowerCase()) ? "[snapshotter]" : ""
      console.log(`${ev.type.padEnd(20)} block ${ev.blockNumber} ${ev.entityKey} ${mark}`)
    },
    onError: (err) => console.error("watch error:", err.message),
  })
}

// ---------------------------------------------------------------------------------------------

async function main() {
  loadEnv()
  const args = parseArgs(process.argv.slice(2))
  const [cmd, arg] = args._
  const dryRun = args.flags["dry-run"] === true
  const client = httpClient()
  switch (cmd) {
    case "status":
      return status(client)
    case "snap":
      if (!arg) throw new Error("usage: snap <url> --event <slug> [--dry-run]")
      await snap(client, arg, String(args.flags.event ?? "unspecified"), dryRun)
      return
    case "seed":
      return seed(client, dryRun)
    case "history":
      if (!arg) throw new Error("usage: history <url>")
      return history(client, arg)
    case "verify":
      if (!arg) throw new Error("usage: verify <url> [--at <iso-date>]")
      return verify(client, arg, typeof args.flags.at === "string" ? args.flags.at : undefined)
    case "cite":
      if (!arg || typeof args.flags.note !== "string") throw new Error('usage: cite <snapshotKey> --note "<text>" [--dry-run]')
      return cite(client, arg as Hex, args.flags.note, dryRun)
    case "watch":
      return watch()
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).join("\n"))
  }
}

main().catch((e) => {
  console.error(`error: ${rootCause(e)}`)
  process.exit(1)
})
