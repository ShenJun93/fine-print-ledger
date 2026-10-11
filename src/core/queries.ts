/**
 * Every Arkiv query the app and the CLI run. Each one is built here, once, so the web app's
 * "verify it yourself" panel can show the exact query string that produced what is on screen
 * (SelectQueryBuilder.toString() is the text the node parses).
 *
 * Arkiv 0.8 has no server-side ordering, so every list is sorted on the client.
 */
import { addr, type Entity, type PublicArkivClient, u64 } from "@arkiv-network/sdk"
import { and, eq, type Expression, gte, lte, or } from "@arkiv-network/sdk/query"
import { APP, ENTITY_TYPES, TIRAMISU } from "./config"

type Hex = `0x${string}`

/** Page size for every list query. The node maximum is 200; small pages exercise the cursor. */
export const PAGE_SIZE = 50

export type TrustMode =
  /** Only entities whose immutable $creator is one of these addresses. */
  | { kind: "trusted"; creators: readonly Hex[] }
  /** No creator filter. Used to show what an attacker could write, flagged as untrusted. */
  | { kind: "any" }

export type Range = { from?: number | undefined; to?: number | undefined }

/** app = "fpl" AND type = <type> — the compound predicate every query starts from. */
export function baseFilter(type: (typeof ENTITY_TYPES)[keyof typeof ENTITY_TYPES]): Expression[] {
  return [eq("app", APP), eq("type", type)]
}

/** Numeric range on a u64 attribute. Attribute values are typed, so the literal must be u64 too. */
export function rangeFilter(name: string, range: Range | undefined): Expression[] {
  const out: Expression[] = []
  if (range?.from !== undefined) out.push(gte(name, u64(range.from)))
  if (range?.to !== undefined) out.push(lte(name, u64(range.to)))
  return out
}

/** The creator filter: $creator is set by the chain and can never change. */
export function creatorFilter(trust: TrustMode): Expression[] {
  if (trust.kind === "any") return []
  const [first, ...rest] = trust.creators
  if (first === undefined) throw new Error("trusted mode needs at least one creator")
  if (rest.length === 0) return [eq("$creator", addr(first))]
  return [or(trust.creators.map((c) => eq("$creator", addr(c))))]
}

export type QuerySpec = {
  /** Human name shown in the verify panel. */
  name: string
  /** Attribute predicates (everything except the creator filter). */
  filters: Expression[]
  /** Creator filter, applied with createdBy() when there is a single trusted snapshotter. */
  trust: TrustMode
}

export function pagesQuery(trust: TrustMode, opts: { domain?: string } = {}): QuerySpec {
  return {
    name: "Watched pages",
    filters: [
      ...baseFilter(ENTITY_TYPES.page),
      ...(opts.domain ? [eq("domain", opts.domain)] : []),
    ],
    trust,
  }
}

export function pageByUrlHashQuery(urlHash: string, trust: TrustMode): QuerySpec {
  return {
    name: "Page by urlHash",
    filters: [...baseFilter(ENTITY_TYPES.page), eq("url_hash", urlHash)],
    trust,
  }
}

/** Snapshots of one page, optionally limited to a fetchedAt window and a minimum version. */
export function snapshotsQuery(
  urlHash: string,
  trust: TrustMode,
  opts: { fetchedAt?: Range; version?: Range } = {},
): QuerySpec {
  return {
    name: "Snapshots of a page",
    filters: [
      ...baseFilter(ENTITY_TYPES.snapshot),
      eq("url_hash", urlHash),
      ...rangeFilter("fetched_at", opts.fetchedAt),
      ...rangeFilter("version", opts.version),
    ],
    trust,
  }
}

/** "What did the page say at time T?" — every snapshot fetched at or before T; newest wins. */
export function asOfQuery(urlHash: string, at: number, trust: TrustMode): QuerySpec {
  return {
    name: `Snapshots fetched at or before ${new Date(at * 1000).toISOString()}`,
    filters: [
      ...baseFilter(ENTITY_TYPES.snapshot),
      eq("url_hash", urlHash),
      lte("fetched_at", u64(at)),
    ],
    trust,
  }
}

export function snapshotByVersionQuery(urlHash: string, version: number, trust: TrustMode): QuerySpec {
  return {
    name: `Snapshot v${version}`,
    filters: [
      ...baseFilter(ENTITY_TYPES.snapshot),
      eq("url_hash", urlHash),
      eq("version", u64(version)),
    ],
    trust,
  }
}

export function diffsQuery(urlHash: string, trust: TrustMode, opts: { changedAt?: Range } = {}): QuerySpec {
  return {
    name: "Diffs of a page",
    filters: [
      ...baseFilter(ENTITY_TYPES.diff),
      eq("url_hash", urlHash),
      ...rangeFilter("changed_at", opts.changedAt),
    ],
    trust,
  }
}

/** Recent changes across every watched page (the home page feed). */
export function recentDiffsQuery(since: number, trust: TrustMode): QuerySpec {
  return {
    name: "Changes since",
    filters: [...baseFilter(ENTITY_TYPES.diff), gte("changed_at", u64(since))],
    trust,
  }
}

/**
 * Citations of a page. Deliberately NOT filtered by creator: anyone may cite. The UI shows each
 * citation's $creator so readers can judge who pinned what.
 */
export function citationsQuery(urlHash: string): QuerySpec {
  return {
    name: "Citations of a page (any creator)",
    filters: [...baseFilter(ENTITY_TYPES.citation), eq("url_hash", urlHash)],
    trust: { kind: "any" },
  }
}

// ---------------------------------------------------------------------------------------------
// Running

/** Metadata-only selection (lists, timelines): no payload, so pages stay small. */
const META = {
  key: true,
  creator: true,
  owner: true,
  createdAt: true,
  expiresAt: true,
  creationFlags: true,
  contentType: true,
  attributes: true,
} as const

export function builderFor(client: PublicArkivClient, spec: QuerySpec, withPayload: boolean) {
  const b = withPayload ? client.select({ ...META, payload: true }) : client.select(META)
  b.where(spec.filters).limit(PAGE_SIZE)
  const [only, ...more] = spec.trust.kind === "trusted" ? spec.trust.creators : []
  if (only !== undefined && more.length === 0) b.createdBy(only)
  else if (only !== undefined) b.where(creatorFilter(spec.trust))
  return b
}

/**
 * The exact query string the node receives for a spec — identical to the builder's toString(),
 * which appends the createdBy() predicate after the where() filters.
 */
export function queryText(spec: QuerySpec): string {
  return and([...spec.filters, ...creatorFilter(spec.trust)]).toString()
}

export type FetchResult = { entities: Entity[]; pages: number; blockNumber: bigint }

/**
 * Runs a query and walks every page with the cursor (up to maxPages). Returns all entities, the
 * number of pages fetched, and the block the walk was read at.
 */
export async function fetchAll(
  client: PublicArkivClient,
  spec: QuerySpec,
  opts: { withPayload?: boolean; maxPages?: number } = {},
): Promise<FetchResult> {
  const maxPages = opts.maxPages ?? 20
  let page = await builderFor(client, spec, opts.withPayload ?? false).fetch()
  const entities: Entity[] = [...(page.entities as unknown as Entity[])]
  let pages = 1
  while (page.hasNextPage() && pages < maxPages) {
    page = await page.next()
    entities.push(...(page.entities as unknown as Entity[]))
    pages++
  }
  return { entities, pages, blockNumber: page.blockNumber }
}

/** A copy-pasteable curl command that runs the same query over raw JSON-RPC. */
export function curlFor(spec: QuerySpec, withPayload = false): string {
  const select = { ...Object.fromEntries(Object.keys(META).map((k) => [k, true])), payload: withPayload }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "arkiv_query",
    params: [queryText(spec), { select, limit: `0x${PAGE_SIZE.toString(16)}` }],
  })
  return `curl -s ${TIRAMISU.http} -H 'content-type: application/json' -d '${body.replaceAll("'", "'\\''")}'`
}
