import { Entity, jsonToPayload, str, u64 } from "@arkiv-network/sdk"
import { describe, expect, it } from "vitest"
import { httpClient } from "../src/core/client"
import { APP, CITED_DAYS, LIFETIME_DAYS } from "../src/core/config"
import {
  buildCitationCreate,
  buildCitedExtension,
  buildDiffCreate,
  buildPageCreate,
  buildSnapshotCreate,
  decodePage,
  decodeSnapshot,
  type PageRecord,
  type SnapshotRecord,
} from "../src/core/entities"
import { sha256Hex, urlHash } from "../src/core/hash"
import { encodeText } from "../src/core/payload"
import { planCheck } from "../src/core/plan"
import {
  asOfQuery,
  builderFor,
  citationsQuery,
  curlFor,
  pagesQuery,
  queryText,
  snapshotsQuery,
  type TrustMode,
} from "../src/core/queries"

const SNAPSHOTTER = "0x517bf78c3000991FFbCdf06305F3881382437e98" as const
const TRUST: TrustMode = { kind: "trusted", creators: [SNAPSHOTTER] }
const KEY_A = `0x${"a".repeat(64)}` as const
const KEY_B = `0x${"b".repeat(64)}` as const
const KEY_P = `0x${"c".repeat(64)}` as const
const BLOCKS_PER_DAY = 43_200n // 2-second blocks

describe("entity builders", () => {
  it("page: queryable attributes, JSON payload, 30-day lease, permissionless extension", () => {
    const c = buildPageCreate({
      url: "https://example.org/rules",
      urlHash: "ab",
      domain: "example.org",
      event: "demo-cup",
      title: "Rules",
      checkedAt: 1760000000,
      latestVersion: 1,
      latestContentHash: "ff",
    })
    expect(c.attributes).toMatchObject({ app: APP, type: "page", urlHash: "ab", event: "demo-cup" })
    expect(c.attributes?.lastCheckedAt).toEqual(u64(1760000000))
    expect(c.contentType).toBe("application/json")
    expect(JSON.parse(new TextDecoder().decode(c.payload))).toEqual({
      url: "https://example.org/rules",
      title: "Rules",
      event: "demo-cup",
    })
    expect(c.expires.minLifetime).toBe(BigInt(LIFETIME_DAYS.page) * BLOCKS_PER_DAY)
    expect(c.flags).toEqual({ permissionlessExtension: true })
  })

  it("snapshot: u64 numbers for ranges, readonly + permissionless extension, 180 days", async () => {
    const encoded = await encodeText("Rules text")
    const c = buildSnapshotCreate({
      urlHash: "ab",
      domain: "example.org",
      event: "demo-cup",
      fetchedAt: 1760000000,
      version: 3,
      contentHash: await sha256Hex("Rules text"),
      sizeBytes: 10,
      encoded,
      salt: 7n,
    })
    expect(c.attributes?.fetchedAt).toEqual(u64(1760000000))
    expect(c.attributes?.version).toEqual(u64(3))
    expect(c.attributes?.sizeBytes).toEqual(u64(10))
    expect(c.flags).toEqual({ readonly: true, permissionlessExtension: true })
    expect(c.expires.minLifetime).toBe(BigInt(LIFETIME_DAYS.snapshot) * BLOCKS_PER_DAY)
    expect(c.salt).toBe(7n)
    expect(new TextDecoder().decode(c.payload)).toBe("Rules text")
  })

  it("diff: references both snapshots by key, 365 days", () => {
    const c = buildDiffCreate({
      urlHash: "ab",
      domain: "example.org",
      event: "demo-cup",
      fromVersion: 1,
      toVersion: 2,
      changedAt: 1760086400,
      addedLines: 2,
      removedLines: 1,
      fromSnapshot: KEY_A,
      toSnapshot: KEY_B,
      unified: "--- v1\n+++ v2\n",
    })
    expect(c.attributes?.fromSnapshot).toEqual({ type: "key", value: KEY_A })
    expect(c.attributes?.toSnapshot).toEqual({ type: "key", value: KEY_B })
    expect(c.expires.minLifetime).toBe(BigInt(LIFETIME_DAYS.diff) * BLOCKS_PER_DAY)
  })

  it("citation: capped note, extension to CITED_DAYS", () => {
    const c = buildCitationCreate({
      urlHash: "ab",
      snapshotKey: KEY_A,
      version: 2,
      contentHash: "ff",
      citedAt: 1760000000,
      note: "rules as of submission day",
    })
    expect(c.attributes?.snapshot).toEqual({ type: "key", value: KEY_A })
    expect(() => buildCitationCreate({ urlHash: "ab", snapshotKey: KEY_A, version: 2, contentHash: "ff", citedAt: 1, note: "x".repeat(281) })).toThrow()
    expect(buildCitedExtension(KEY_A).expires.minLifetime).toBe(BigInt(CITED_DAYS) * BLOCKS_PER_DAY)
  })

  it("decoders read typed attributes back (u64 arrives as bigint)", () => {
    const e = new Entity({
      key: KEY_P,
      creator: SNAPSHOTTER,
      owner: SNAPSHOTTER,
      expiresAt: 999n,
      attributes: {
        app: str(APP),
        type: str("page"),
        urlHash: str("ab"),
        lastCheckedAt: u64(1760000000),
        latestVersion: u64(4),
      },
      payload: jsonToPayload({ url: "https://example.org/rules", title: "Rules" }),
      contentType: "application/json",
    })
    const p = decodePage(e)
    expect(p).toMatchObject({ key: KEY_P, latestVersion: 4, lastCheckedAt: 1760000000, url: "https://example.org/rules" })
    const s = decodeSnapshot(new Entity({ attributes: { version: u64(2), fetchedAt: u64(5) } }))
    expect(s.version).toBe(2)
    expect(s.fetchedAt).toBe(5)
  })
})

async function pageRecord(url: string, latestVersion: number): Promise<PageRecord> {
  return {
    key: KEY_P,
    creator: SNAPSHOTTER,
    owner: SNAPSHOTTER,
    expiresAt: 0n,
    createdAtBlock: 0n,
    readonly: false,
    permissionlessExtension: true,
    urlHash: await urlHash(url),
    domain: "example.org",
    event: "demo-cup",
    lastCheckedAt: 1760000000,
    latestVersion,
    latestContentHash: "",
    url,
    title: "Rules",
  }
}

async function snapshotRecord(url: string, text: string, version: number): Promise<SnapshotRecord> {
  return {
    key: KEY_A,
    creator: SNAPSHOTTER,
    owner: SNAPSHOTTER,
    expiresAt: 0n,
    createdAtBlock: 0n,
    readonly: true,
    permissionlessExtension: true,
    urlHash: await urlHash(url),
    domain: "example.org",
    event: "demo-cup",
    fetchedAt: 1760000000,
    version,
    contentHash: await sha256Hex(text),
    sizeBytes: text.length,
    contentType: "text/plain",
    payload: new TextEncoder().encode(text),
  }
}

describe("planCheck", () => {
  const url = "https://example.org/rules"
  const base = { url, event: "demo-cup", title: "Rules", fetchedAt: 1760086400 }

  it("new page: one batch creating page + snapshot v1, with predicted salts", async () => {
    const p = await planCheck({ ...base, text: "v1 text" }, [
      { key: KEY_P, salt: 11n },
      { key: KEY_A, salt: 12n },
    ])
    expect(p.kind).toBe("new-page")
    expect(p.batch.creates.map((c) => c.attributes?.type)).toEqual(["page", "snapshot"])
    expect(p.batch.creates.map((c) => c.salt)).toEqual([11n, 12n])
    expect(p.batch.patches).toHaveLength(0)
  })

  it("unchanged: no creates, page patched and its lease extended", async () => {
    const text = "same text"
    const p = await planCheck({
      ...base,
      text,
      page: await pageRecord(url, 1),
      latest: { record: await snapshotRecord(url, text, 1), text },
    })
    expect(p.kind).toBe("unchanged")
    expect(p.batch.creates).toHaveLength(0)
    expect(p.batch.patches[0]?.entityKey).toBe(KEY_P)
    expect(p.batch.extensions[0]?.entityKey).toBe(KEY_P)
  })

  it("changed: snapshot v2 and diff v1->v2 in the same batch, diff points at predicted key", async () => {
    const p = await planCheck(
      {
        ...base,
        text: "Prize: $5,000",
        page: await pageRecord(url, 1),
        latest: { record: await snapshotRecord(url, "Prize: $10,000", 1), text: "Prize: $10,000" },
      },
      [
        { key: KEY_B, salt: 21n },
        { key: `0x${"d".repeat(64)}`, salt: 22n },
      ],
    )
    expect(p.kind).toBe("changed")
    expect(p.version).toBe(2)
    const [snap, diff] = p.batch.creates
    expect(snap?.attributes?.type).toBe("snapshot")
    expect(snap?.attributes?.version).toEqual(u64(2))
    expect(diff?.attributes?.type).toBe("diff")
    expect(diff?.attributes?.fromSnapshot).toEqual({ type: "key", value: KEY_A })
    expect(diff?.attributes?.toSnapshot).toEqual({ type: "key", value: KEY_B })
    expect(diff?.attributes?.addedLines).toEqual(u64(1))
    expect(diff?.attributes?.removedLines).toEqual(u64(1))
    expect(p.batch.patches[0]?.set?.latestVersion).toEqual(u64(2))
    expect(p.batch.extensions).toHaveLength(1)
  })
})

describe("queries (built offline; no request is sent)", () => {
  const client = httpClient("http://127.0.0.1:9") // never contacted: toString() only
  const uh = "5fae6008396922d26c33b848245192f376f0338ef12313fcacbfe8cefb45aeac"

  it("compound predicate + createdBy() renders exactly what queryText() shows in the UI", () => {
    const spec = snapshotsQuery(uh, TRUST, { fetchedAt: { from: 1760000000, to: 1760086400 } })
    const text = queryText(spec)
    expect(builderFor(client, spec, false).toString()).toBe(text)
    expect(text).toContain("app = str('fpl')")
    expect(text).toContain("type = str('snapshot')")
    expect(text).toContain(`urlHash = str('${uh}')`)
    expect(text).toContain("fetchedAt >= u64(1760000000)")
    expect(text).toContain("fetchedAt <= u64(1760086400)")
    expect(text.toLowerCase()).toContain(`$creator = addr(${SNAPSHOTTER.toLowerCase()})`.toLowerCase())
  })

  it("as-of query is a numeric range on fetchedAt", () => {
    expect(queryText(asOfQuery(uh, 1760050000, TRUST))).toContain("fetchedAt <= u64(1760050000)")
  })

  it("several trusted creators become an OR group; 'any' drops the creator filter", () => {
    const two = queryText(pagesQuery({ kind: "trusted", creators: [SNAPSHOTTER, `0x${"1".repeat(40)}`] }))
    expect(two).toMatch(/\(\$creator = .* OR \$creator = .*\)/)
    expect(queryText(pagesQuery({ kind: "any" }))).not.toContain("$creator")
    expect(queryText(citationsQuery(uh))).not.toContain("$creator")
  })

  it("curl reproduces the same query over raw JSON-RPC", () => {
    const spec = pagesQuery(TRUST)
    const cmd = curlFor(spec)
    expect(cmd).toContain('"method":"arkiv_query"')
    expect(cmd).toContain("https://rpc.tiramisu.db-chain.testnet.arkiv.network")
    expect(cmd).toContain(JSON.stringify(queryText(spec)).slice(1, -1).replaceAll("'", "'\\''"))
  })
})
