import { createPublicClient, type PublicArkivClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http, webSocket } from "viem"
import { TIRAMISU } from "./config"
import { decodePage, decodeSnapshot, type PageRecord, type SnapshotRecord } from "./entities"
import { decodeText } from "./payload"
import { fetchAll, pageByUrlHashQuery, snapshotByVersionQuery, snapshotsQuery, type TrustMode } from "./queries"

/**
 * Read-only client over HTTP. Without a key it uses the public RPC's anonymous budget (on
 * 2026-10-11: 10,000 cost units per window, about 100 queries). The CLI passes ARKIV_ACCESS_KEY
 * as an X-API-KEY header (not in the URL, so it never shows up in error messages).
 */
export function httpClient(
  url: string = TIRAMISU.http,
  apiKey: string | undefined = nodeAccessKey(),
  opts: { retryCount?: number } = {},
): PublicArkivClient {
  const transport = http(url, {
    ...(apiKey ? { fetchOptions: { headers: { "X-API-KEY": apiKey } } } : {}),
    ...(opts.retryCount === undefined ? {} : { retryCount: opts.retryCount }),
  })
  return createPublicClient({ chain: tiramisu, transport }) as PublicArkivClient
}

/**
 * If an error (anywhere in its cause chain) is the public RPC's HTTP 429, the seconds until the
 * anonymous budget resets (from Retry-After), else undefined. viem honours Retry-After when it
 * retries, which on 2026-10-11 meant a silent ~40-minute wait; the web app sets retryCount 0 and
 * reports the limit instead (friction.md #10).
 */
export function rateLimitedFor(e: unknown): number | undefined {
  for (let c: unknown = e, i = 0; c && i < 10; c = (c as { cause?: unknown }).cause, i++) {
    const err = c as { status?: number; headers?: Headers; body?: unknown; details?: string }
    if (err.status === 429 || /ANON_COST_LIMITED/.test(String(err.details ?? ""))) {
      const ra = Number(err.headers?.get?.("retry-after"))
      return Number.isFinite(ra) && ra > 0 ? ra : 0
    }
  }
  return undefined
}

/** ARKIV_ACCESS_KEY from the Node environment; always undefined in the browser. */
function nodeAccessKey(): string | undefined {
  return typeof process === "undefined" ? undefined : process.env?.ARKIV_ACCESS_KEY?.trim() || undefined
}

/**
 * Read-only client over WebSocket. watchEntityEvents only opens a real subscription over a
 * WebSocket transport (and without fromBlock); over HTTP it silently polls.
 */
export function wsClient(url: string = TIRAMISU.ws): PublicArkivClient {
  return createPublicClient({ chain: tiramisu, transport: webSocket(url) }) as PublicArkivClient
}

/** The trusted page entity for a urlHash, if any. Newest lastCheckedAt wins if several exist. */
export async function findPage(
  client: PublicArkivClient,
  urlHash: string,
  trust: TrustMode,
): Promise<PageRecord | undefined> {
  const { entities } = await fetchAll(client, pageByUrlHashQuery(urlHash, trust), { withPayload: true })
  return entities.map(decodePage).sort((a, b) => b.lastCheckedAt - a.lastCheckedAt)[0]
}

/**
 * The latest trusted snapshot of a page and its decoded text. Uses the page's latestVersion as an
 * equality lookup first, and falls back to listing every snapshot and sorting on the client
 * (Arkiv has no ORDER BY).
 */
export async function findLatestSnapshot(
  client: PublicArkivClient,
  page: PageRecord,
  trust: TrustMode,
): Promise<{ record: SnapshotRecord; text: string } | undefined> {
  let candidates: SnapshotRecord[] = []
  if (page.latestVersion > 0) {
    const r = await fetchAll(client, snapshotByVersionQuery(page.urlHash, page.latestVersion, trust), {
      withPayload: true,
    })
    candidates = r.entities.map(decodeSnapshot)
  }
  if (candidates.length === 0) {
    const r = await fetchAll(client, snapshotsQuery(page.urlHash, trust), { withPayload: true })
    candidates = r.entities.map(decodeSnapshot)
  }
  const record = candidates.sort((a, b) => b.version - a.version || b.fetchedAt - a.fetchedAt)[0]
  if (!record || !record.payload) return undefined
  return { record, text: await decodeText(record.payload, record.contentType) }
}
