import { createPublicClient, type PublicArkivClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http, webSocket } from "viem"
import { TIRAMISU } from "./config"
import { decodePage, decodeSnapshot, type PageRecord, type SnapshotRecord } from "./entities"
import { decodeText } from "./payload"
import { fetchAll, pageByUrlHashQuery, snapshotByVersionQuery, snapshotsQuery, type TrustMode } from "./queries"

/** Read-only client over HTTP. No key, no backend: this is all the web app needs to read. */
export function httpClient(url: string = TIRAMISU.http): PublicArkivClient {
  return createPublicClient({ chain: tiramisu, transport: http(url) }) as PublicArkivClient
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
