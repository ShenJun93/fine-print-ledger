/**
 * Shared constants for the snapshotter CLI and the web app.
 *
 * Nothing here is secret: the private key is read only by the CLI, from the
 * ARKIV_PRIVATE_KEY environment variable, and never touches this module.
 */
import { ExpirationTime } from "@arkiv-network/sdk"

/** Every Fine Print Ledger entity carries app = "fpl" so our queries never match other apps. */
export const APP = "fpl"

/** The four entity types. Stored in the `type` attribute. */
export const ENTITY_TYPES = {
  page: "page",
  snapshot: "snapshot",
  diff: "diff",
  citation: "citation",
} as const
export type EntityType = (typeof ENTITY_TYPES)[keyof typeof ENTITY_TYPES]

/**
 * The wallet that runs the official snapshotter. The UI trusts snapshots and diffs only when
 * their on-chain `$creator` is in this list; every other field is writable by anyone.
 */
export const DEFAULT_TRUSTED_SNAPSHOTTERS = [
  "0x517bf78c3000991FFbCdf06305F3881382437e98",
] as const satisfies readonly `0x${string}`[]

export const TIRAMISU = {
  chainId: 7738577,
  http: "https://rpc.tiramisu.db-chain.testnet.arkiv.network",
  ws: "wss://rpc.tiramisu.db-chain.testnet.arkiv.network",
  explorer: "https://tiramisu.explorer.arkiv.network",
} as const

/**
 * Entity Expiration per type, in days. Product logic:
 * - page: a watch is a 30-day lease, renewed (Lifetime Extension) every time the page is re-checked.
 *   A page nobody checks any more quietly drops out of the ledger.
 * - snapshot: 180 days covers a contest plus its judging and dispute window. Citing a snapshot
 *   extends it to CITED_DAYS from the moment of citation.
 * - diff: 365 days. A diff is the evidence people actually need in a dispute ("the rules changed on
 *   this date"), so it outlives the snapshots it compares.
 * - citation: 365 days, the same horizon the cited evidence is extended to.
 */
export const LIFETIME_DAYS = {
  page: 30,
  snapshot: 180,
  diff: 365,
  citation: 365,
} as const

/** How long a cited snapshot (and the diffs touching it) is kept alive from the citation moment. */
export const CITED_DAYS = 365

export const lifetime = (days: number) => ExpirationTime.fromDays(days)

/** Payloads above this many bytes are gzip-compressed (the engine limit is 128 KiB). */
export const GZIP_THRESHOLD_BYTES = 96 * 1024

export const explorerAddressUrl = (address: string) => `${TIRAMISU.explorer}/address/${address}`
export const explorerTxUrl = (hash: string) => `${TIRAMISU.explorer}/tx/${hash}`
export const explorerEntityUrl = (key: string) => `${TIRAMISU.explorer}/entity/${key}`
