/**
 * Builders for the four Fine Print Ledger entity types, and decoders back from query results.
 *
 * Everything the app filters on is a typed attribute (numbers as u64 so ranges work); everything it
 * only displays lives in the payload. See arkiv/schema.md for the full data contract.
 */
import {
  type Attributes,
  type CreateEntityParameters,
  type Entity,
  type ExtendEntityParameters,
  jsonToPayload,
  key,
  type PatchEntityParameters,
  u64,
} from "@arkiv-network/sdk"
import { APP, CITED_DAYS, ENTITY_TYPES, LIFETIME_DAYS, lifetime } from "./config"
import type { EncodedPayload } from "./payload"

type Hex = `0x${string}`

// ---------------------------------------------------------------------------------------------
// Inputs

export type PageInput = {
  url: string
  urlHash: string
  domain: string
  event: string
  title: string
  checkedAt: number
  latestVersion: number
  latestContentHash: string
  /** Public line-ignore patterns applied before hashing (see normalize.applyIgnore). */
  ignore: string[]
}

export type SnapshotInput = {
  urlHash: string
  domain: string
  event: string
  fetchedAt: number
  version: number
  contentHash: string
  sizeBytes: number
  encoded: EncodedPayload
  salt?: bigint | undefined
}

export type DiffInput = {
  urlHash: string
  domain: string
  event: string
  fromVersion: number
  toVersion: number
  changedAt: number
  addedLines: number
  removedLines: number
  fromSnapshot: Hex
  /** Predicted key of the snapshot created in the same batch. */
  toSnapshot?: Hex | undefined
  unified: string
  salt?: bigint | undefined
}

export type CitationInput = {
  urlHash: string
  snapshotKey: Hex
  version: number
  contentHash: string
  citedAt: number
  /** Short public note, e.g. "rules as of submission day". Never personal data. */
  note: string
}

// ---------------------------------------------------------------------------------------------
// Builders

/** A watched page. A 30-day lease; the snapshotter patches and extends it on every check. */
export function buildPageCreate(p: PageInput): CreateEntityParameters {
  return {
    attributes: {
      app: APP,
      type: ENTITY_TYPES.page,
      url_hash: p.urlHash,
      domain: p.domain,
      event: p.event,
      last_checked_at: u64(p.checkedAt),
      latest_version: u64(p.latestVersion),
      latest_content_hash: p.latestContentHash,
    },
    payload: pagePayload(p),
    contentType: "application/json",
    expires: lifetime(LIFETIME_DAYS.page),
    // Anyone may renew a watch lease, e.g. a participant who wants the page kept on the ledger.
    flags: { permissionlessExtension: true },
  }
}

function pagePayload(p: Pick<PageInput, "url" | "title" | "event" | "ignore">): Uint8Array {
  return jsonToPayload({ url: p.url, title: p.title, event: p.event, ignore: p.ignore })
}

/**
 * Re-check of an existing page: record the check and the latest version, and rewrite the payload
 * so the ignore patterns on chain are always the ones this check applied.
 */
export function buildPagePatch(
  pageKey: Hex,
  p: Pick<
    PageInput,
    "checkedAt" | "latestVersion" | "latestContentHash" | "url" | "title" | "event" | "ignore"
  >,
): PatchEntityParameters {
  return {
    entityKey: pageKey,
    set: {
      last_checked_at: u64(p.checkedAt),
      latest_version: u64(p.latestVersion),
      latest_content_hash: p.latestContentHash,
    },
    payload: pagePayload(p),
    contentType: "application/json",
  }
}

/** Lifetime Extension of a page watch: the lease is renewed by activity (a re-check). */
export function buildPageExtension(pageKey: Hex): ExtendEntityParameters {
  return { entityKey: pageKey, expires: lifetime(LIFETIME_DAYS.page) }
}

/**
 * A snapshot of a page's normalized text. Created `readonly`: once written, not even the
 * snapshotter can change what it says. `permissionlessExtension` lets anyone keep it alive.
 */
export function buildSnapshotCreate(s: SnapshotInput): CreateEntityParameters {
  return {
    attributes: {
      app: APP,
      type: ENTITY_TYPES.snapshot,
      url_hash: s.urlHash,
      domain: s.domain,
      event: s.event,
      fetched_at: u64(s.fetchedAt),
      version: u64(s.version),
      content_hash: s.contentHash,
      size_bytes: u64(s.sizeBytes),
    },
    payload: s.encoded.payload,
    contentType: s.encoded.contentType,
    expires: lifetime(LIFETIME_DAYS.snapshot),
    flags: { readonly: true, permissionlessExtension: true },
    ...(s.salt !== undefined && { salt: s.salt }),
  }
}

/** The change between two consecutive snapshots, as a unified diff. */
export function buildDiffCreate(d: DiffInput): CreateEntityParameters {
  return {
    attributes: {
      app: APP,
      type: ENTITY_TYPES.diff,
      url_hash: d.urlHash,
      domain: d.domain,
      event: d.event,
      from_version: u64(d.fromVersion),
      to_version: u64(d.toVersion),
      changed_at: u64(d.changedAt),
      added_lines: u64(d.addedLines),
      removed_lines: u64(d.removedLines),
      from_snapshot: key(d.fromSnapshot),
      ...(d.toSnapshot !== undefined && { to_snapshot: key(d.toSnapshot) }),
    },
    payload: new TextEncoder().encode(d.unified),
    contentType: "text/plain",
    expires: lifetime(LIFETIME_DAYS.diff),
    flags: { readonly: true, permissionlessExtension: true },
    ...(d.salt !== undefined && { salt: d.salt }),
  }
}

/** A citation: someone pins a snapshot as evidence. Created by any wallet. */
export function buildCitationCreate(c: CitationInput): CreateEntityParameters {
  if (c.note.length > 280) throw new Error("citation note must be 280 characters or fewer")
  return {
    attributes: {
      app: APP,
      type: ENTITY_TYPES.citation,
      url_hash: c.urlHash,
      snapshot: key(c.snapshotKey),
      version: u64(c.version),
      cited_at: u64(c.citedAt),
    },
    payload: jsonToPayload({ note: c.note, snapshotKey: c.snapshotKey, contentHash: c.contentHash }),
    contentType: "application/json",
    expires: lifetime(LIFETIME_DAYS.citation),
  }
}

/** Citing extends the cited evidence to CITED_DAYS from now. */
export function buildCitedExtension(entityKey: Hex): ExtendEntityParameters {
  return { entityKey, expires: lifetime(CITED_DAYS) }
}

// ---------------------------------------------------------------------------------------------
// Decoders

function attr(a: Attributes | undefined, name: string): unknown {
  return a?.[name]?.value
}
function attrStr(a: Attributes | undefined, name: string): string {
  const v = attr(a, name)
  return typeof v === "string" ? v : ""
}
function attrNum(a: Attributes | undefined, name: string): number {
  const v = attr(a, name)
  if (typeof v === "bigint") return Number(v)
  if (typeof v === "number") return v
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v)
  return 0
}

export type Meta = {
  key: Hex
  creator: Hex
  owner: Hex
  expiresAt: bigint
  createdAtBlock: bigint
  readonly: boolean
  permissionlessExtension: boolean
}

function meta(e: Entity): Meta {
  return {
    key: (e.key ?? "0x") as Hex,
    creator: (e.creator ?? "0x") as Hex,
    owner: (e.owner ?? "0x") as Hex,
    expiresAt: e.expiresAt ?? 0n,
    createdAtBlock: e.createdAt ?? 0n,
    readonly: e.creationFlags?.readonly ?? false,
    permissionlessExtension: e.creationFlags?.permissionlessExtension ?? false,
  }
}

export type PageRecord = Meta & {
  urlHash: string
  domain: string
  event: string
  lastCheckedAt: number
  latestVersion: number
  latestContentHash: string
  url: string
  title: string
  ignore: string[]
}

export function decodePage(e: Entity): PageRecord {
  const a = e.attributes
  let url = ""
  let title = ""
  let ignore: string[] = []
  try {
    const j = e.payload ? e.toJson() : {}
    url = typeof j.url === "string" ? j.url : ""
    title = typeof j.title === "string" ? j.title : ""
    if (Array.isArray(j.ignore)) ignore = j.ignore.filter((x: unknown) => typeof x === "string")
  } catch {
    /* untrusted payload: leave blank */
  }
  return {
    ...meta(e),
    urlHash: attrStr(a, "url_hash"),
    domain: attrStr(a, "domain"),
    event: attrStr(a, "event"),
    lastCheckedAt: attrNum(a, "last_checked_at"),
    latestVersion: attrNum(a, "latest_version"),
    latestContentHash: attrStr(a, "latest_content_hash"),
    url,
    title,
    ignore,
  }
}

export type SnapshotRecord = Meta & {
  urlHash: string
  domain: string
  event: string
  fetchedAt: number
  version: number
  contentHash: string
  sizeBytes: number
  contentType: string
  payload: Uint8Array | undefined
}

export function decodeSnapshot(e: Entity): SnapshotRecord {
  const a = e.attributes
  return {
    ...meta(e),
    urlHash: attrStr(a, "url_hash"),
    domain: attrStr(a, "domain"),
    event: attrStr(a, "event"),
    fetchedAt: attrNum(a, "fetched_at"),
    version: attrNum(a, "version"),
    contentHash: attrStr(a, "content_hash"),
    sizeBytes: attrNum(a, "size_bytes"),
    contentType: e.contentType ?? "",
    payload: e.payload,
  }
}

export type DiffRecord = Meta & {
  urlHash: string
  fromVersion: number
  toVersion: number
  changedAt: number
  addedLines: number
  removedLines: number
  fromSnapshot: string
  toSnapshot: string
  unified: string
}

export function decodeDiff(e: Entity): DiffRecord {
  const a = e.attributes
  return {
    ...meta(e),
    urlHash: attrStr(a, "url_hash"),
    fromVersion: attrNum(a, "from_version"),
    toVersion: attrNum(a, "to_version"),
    changedAt: attrNum(a, "changed_at"),
    addedLines: attrNum(a, "added_lines"),
    removedLines: attrNum(a, "removed_lines"),
    fromSnapshot: attrStr(a, "from_snapshot"),
    toSnapshot: attrStr(a, "to_snapshot"),
    unified: e.payload ? new TextDecoder().decode(e.payload) : "",
  }
}

export type CitationRecord = Meta & {
  urlHash: string
  snapshot: string
  version: number
  citedAt: number
  note: string
}

export function decodeCitation(e: Entity): CitationRecord {
  const a = e.attributes
  let note = ""
  try {
    const j = e.payload ? e.toJson() : {}
    note = typeof j.note === "string" ? j.note.slice(0, 280) : ""
  } catch {
    /* ignore */
  }
  return {
    ...meta(e),
    urlHash: attrStr(a, "url_hash"),
    snapshot: attrStr(a, "snapshot"),
    version: attrNum(a, "version"),
    citedAt: attrNum(a, "cited_at"),
    note,
  }
}
