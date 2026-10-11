/**
 * The web app's data layer. Reads go straight from the browser to the Tiramisu RPC: there is no
 * Fine Print Ledger backend, so nobody (including us) can censor or rewrite what is shown.
 */
import type { Entity, PublicArkivClient } from "@arkiv-network/sdk"
import {
  type CitationRecord,
  type DiffRecord,
  decodeCitation,
  decodeDiff,
  decodePage,
  decodeSnapshot,
  type PageRecord,
  type SnapshotRecord,
} from "../src/core/entities"
import {
  asOfQuery,
  citationsQuery,
  diffsQuery,
  fetchAll,
  pagesQuery,
  type QuerySpec,
  snapshotsQuery,
  type TrustMode,
} from "../src/core/queries"

export type Ran = { spec: QuerySpec; rows: number; pages: number; block: bigint; withPayload: boolean }

export type PageDetail = {
  snapshots: SnapshotRecord[]
  diffs: DiffRecord[]
  citations: CitationRecord[]
}

export interface DataSource {
  readonly label: string
  listPages(trust: TrustMode): Promise<PageRecord[]>
  detail(urlHash: string, trust: TrustMode): Promise<PageDetail>
  asOf(urlHash: string, at: number, trust: TrustMode): Promise<SnapshotRecord | undefined>
  /** Every query run since the last reset, for the "verify it yourself" panel. */
  ran: Ran[]
  resetRan(): void
}

const byVersionDesc = (a: SnapshotRecord, b: SnapshotRecord) => b.version - a.version || b.fetchedAt - a.fetchedAt

export class ArkivSource implements DataSource {
  readonly label = "Arkiv Tiramisu (live)"
  ran: Ran[] = []
  constructor(private readonly client: PublicArkivClient) {}

  resetRan() {
    this.ran = []
  }

  private async run(spec: QuerySpec, withPayload: boolean): Promise<Entity[]> {
    const r = await fetchAll(this.client, spec, { withPayload })
    this.ran.push({ spec, rows: r.entities.length, pages: r.pages, block: r.blockNumber, withPayload })
    return r.entities
  }

  async listPages(trust: TrustMode) {
    const rows = await this.run(pagesQuery(trust), true)
    return rows.map(decodePage).sort((a, b) => b.lastCheckedAt - a.lastCheckedAt)
  }

  async detail(urlHash: string, trust: TrustMode): Promise<PageDetail> {
    const [s, d, c] = await Promise.all([
      this.run(snapshotsQuery(urlHash, trust), true),
      this.run(diffsQuery(urlHash, trust), true),
      this.run(citationsQuery(urlHash), true),
    ])
    return {
      snapshots: s.map(decodeSnapshot).sort(byVersionDesc),
      diffs: d.map(decodeDiff).sort((a, b) => b.toVersion - a.toVersion),
      citations: c.map(decodeCitation).sort((a, b) => b.citedAt - a.citedAt),
    }
  }

  async asOf(urlHash: string, at: number, trust: TrustMode) {
    const rows = await this.run(asOfQuery(urlHash, at, trust), true)
    return rows.map(decodeSnapshot).sort((a, b) => b.fetchedAt - a.fetchedAt)[0]
  }
}
