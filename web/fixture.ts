/**
 * Offline fixture, enabled only with ?fixture=1 and always shown under a banner. It runs the real
 * planCheck() on synthetic pages and keeps the resulting entities in memory, so the UI can be
 * developed and demoed before the snapshotter wallet is funded. Nothing here is read from Arkiv.
 */
import { type CreateEntityParameters, Entity, toValue } from "@arkiv-network/sdk"
import {
  type CitationRecord,
  decodeCitation,
  decodeDiff,
  decodePage,
  decodeSnapshot,
  type PageRecord,
  type SnapshotRecord,
} from "../src/core/entities"
import { buildCitationCreate } from "../src/core/entities"
import { planCheck } from "../src/core/plan"
import { asOfQuery, citationsQuery, diffsQuery, pagesQuery, snapshotsQuery, type TrustMode } from "../src/core/queries"
import type { DataSource, PageDetail, Ran } from "./data"

type Hex = `0x${string}`
const SNAPSHOTTER = "0x517bf78c3000991FFbCdf06305F3881382437e98" as Hex
const FORGER = "0x000000000000000000000000000000000000dEaD" as Hex
const CITER = "0x1111111111111111111111111111111111111111" as Hex

const DAY = 86_400
const T0 = 1_791_000_000

const V1 = `Demo Cup 2026 (synthetic example)
Official Rules
Prize pool: $10,000 USD, split 1st $6,000 / 2nd $3,000 / 3rd $1,000
Eligibility: 18+, worldwide
Team size: up to 5
Submission deadline: 31 Oct 2026, 23:59 UTC
Judging: four criteria, 25 points each`

const V2 = `Demo Cup 2026 (synthetic example)
Official Rules
Prize pool: $5,000 USD, split 1st $3,000 / 2nd $1,500 / 3rd $500
Eligibility: 18+, worldwide
Team size: up to 5
Submission deadline: 31 Oct 2026, 23:59 UTC
Judging: four criteria, 25 points each
The organisers may amend these rules at any time without notice.`

let counter = 0
const fakeKey = (): Hex => `0x${(++counter).toString(16).padStart(64, "0")}` as Hex

function toEntity(c: CreateEntityParameters, creator: Hex, key: Hex, createdAt: bigint): Entity {
  return new Entity({
    key,
    creator,
    owner: creator,
    createdAt,
    expiresAt: createdAt + c.expires.minLifetime,
    creationFlags: {
      readonly: c.flags?.readonly ?? false,
      permissionlessExtension: c.flags?.permissionlessExtension ?? false,
      raw: (c.flags?.readonly ? 1 : 0) | (c.flags?.permissionlessExtension ? 2 : 0),
    },
    contentType: c.contentType,
    payload: c.payload,
    attributes: Object.fromEntries(Object.entries(c.attributes ?? {}).map(([k, v]) => [k, toValue(v, k)])),
  })
}

export class FixtureSource implements DataSource {
  readonly label = "FIXTURE (synthetic, not on chain)"
  ran: Ran[] = []
  private entities: Entity[] = []
  private ready: Promise<void>

  constructor() {
    this.ready = this.build()
  }

  resetRan() {
    this.ran = []
  }

  private async build() {
    const url = "https://example.org/demo-cup/rules"
    const block = 400_000n
    // v1: new page
    const p1 = await planCheck({ url, event: "demo-cup-2026", title: "Demo Cup Rules", text: V1, fetchedAt: T0 })
    const keys1 = [fakeKey(), fakeKey()]
    const [page, snap1] = p1.batch.creates.map((c, i) => toEntity(c, SNAPSHOTTER, keys1[i]!, block))
    // v2: changed, diff references snapshot v1 and the new snapshot
    const pageRec = decodePage(page!)
    const snap1Rec = decodeSnapshot(snap1!)
    const keys2 = [fakeKey(), fakeKey()]
    const p2 = await planCheck(
      { url, event: "demo-cup-2026", title: "Demo Cup Rules", text: V2, fetchedAt: T0 + 3 * DAY, page: pageRec, latest: { record: snap1Rec, text: V1 } },
      keys2.map((key, i) => ({ key, salt: BigInt(i + 1) })),
    )
    const created2 = p2.batch.creates.map((c, i) => toEntity(c, SNAPSHOTTER, keys2[i]!, block + 129_600n))
    // apply the page patch from the plan
    const set = p2.batch.patches[0]?.set ?? {}
    page!.attributes = { ...page!.attributes, ...Object.fromEntries(Object.entries(set).map(([k, v]) => [k, toValue(v, k)])) }
    // a forged "snapshot" by another wallet: same attributes, different $creator
    const forged = (await planCheck({ url, event: "demo-cup-2026", title: "Demo Cup Rules", text: V1.replace("$10,000", "$50,000"), fetchedAt: T0 + 4 * DAY, page: pageRec, latest: { record: snap1Rec, text: V1 } })).batch.creates[0]!
    // a citation by a participant
    const cite = buildCitationCreate({ urlHash: p1.urlHash, snapshotKey: keys1[1]!, version: 1, contentHash: snap1Rec.contentHash, citedAt: T0 + 5 * DAY, note: "Prize terms on the day I registered" })
    this.entities = [
      page!,
      snap1!,
      ...created2,
      toEntity(forged, FORGER, fakeKey(), block + 172_800n),
      toEntity(cite, CITER, fakeKey(), block + 216_000n),
    ]
  }

  private match(trust: TrustMode, e: Entity) {
    return trust.kind === "any" || trust.creators.some((c) => c.toLowerCase() === e.creator?.toLowerCase())
  }

  private of(type: string, urlHash?: string) {
    return this.entities.filter(
      (e) => e.attributes?.type?.value === type && (urlHash === undefined || e.attributes?.url_hash?.value === urlHash),
    )
  }

  private log(spec: Ran["spec"], rows: number) {
    this.ran.push({ spec, rows, pages: 1, block: 0n, withPayload: true })
  }

  async listPages(trust: TrustMode): Promise<PageRecord[]> {
    await this.ready
    const rows = this.of("page").filter((e) => this.match(trust, e))
    this.log(pagesQuery(trust), rows.length)
    return rows.map(decodePage)
  }

  async detail(urlHash: string, trust: TrustMode): Promise<PageDetail> {
    await this.ready
    const s = this.of("snapshot", urlHash).filter((e) => this.match(trust, e))
    const d = this.of("diff", urlHash).filter((e) => this.match(trust, e))
    const c = this.of("citation", urlHash)
    this.log(snapshotsQuery(urlHash, trust), s.length)
    this.log(diffsQuery(urlHash, trust), d.length)
    this.log(citationsQuery(urlHash), c.length)
    return {
      snapshots: s.map(decodeSnapshot).sort((a, b) => b.version - a.version || b.fetchedAt - a.fetchedAt),
      diffs: d.map(decodeDiff).sort((a, b) => b.toVersion - a.toVersion),
      citations: c.map(decodeCitation).sort((a: CitationRecord, b: CitationRecord) => b.citedAt - a.citedAt),
    }
  }

  async asOf(urlHash: string, at: number, trust: TrustMode): Promise<SnapshotRecord | undefined> {
    await this.ready
    const rows = this.of("snapshot", urlHash)
      .filter((e) => this.match(trust, e))
      .map(decodeSnapshot)
      .filter((s) => s.fetchedAt <= at)
    this.log(asOfQuery(urlHash, at, trust), rows.length)
    return rows.sort((a, b) => b.fetchedAt - a.fetchedAt)[0]
  }
}

