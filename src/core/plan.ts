/**
 * Decides what one check of a page writes to Arkiv. Pure: given what was fetched and what Arkiv
 * already holds, it returns the batch. The CLI executes it (or prints it in --dry-run).
 *
 * - new page:  create [page, snapshot v1]                                  (one atomic batch)
 * - changed:   create [snapshot vN+1, diff vN->vN+1]; patch page; extend page (one atomic batch)
 * - unchanged: patch page (lastCheckedAt); extend page                     (lease renewed)
 *
 * Snapshot and diff land together or not at all, so the ledger never shows a new version without
 * the diff that explains it (or a diff pointing at a snapshot that does not exist).
 */
import type {
  CreateEntityParameters,
  ExecuteBatchParameters,
  ExtendEntityParameters,
  PatchEntityParameters,
} from "@arkiv-network/sdk"
import { makeDiff } from "./diff"
import {
  buildDiffCreate,
  buildPageCreate,
  buildPageExtension,
  buildPagePatch,
  buildSnapshotCreate,
  type PageRecord,
  type SnapshotRecord,
} from "./entities"
import { byteLength, canonicalUrl, domainOf, sha256Hex, urlHash as hashUrl } from "./hash"
import { GZIP_THRESHOLD_BYTES } from "./config"
import { encodeText } from "./payload"

type Hex = `0x${string}`

export type CheckInput = {
  url: string
  event: string
  title: string
  /** Normalized page text. */
  text: string
  /** Unix seconds. */
  fetchedAt: number
  /** The trusted page entity, if this URL is already watched. */
  page?: PageRecord | undefined
  /** The latest trusted snapshot and its decoded text, if any. */
  latest?: { record: SnapshotRecord; text: string } | undefined
}

export type PredictedKey = { key: Hex; salt: bigint }

export type CheckPlan = {
  kind: "new-page" | "changed" | "unchanged"
  url: string
  urlHash: string
  contentHash: string
  version: number
  sizeBytes: number
  diff?: { addedLines: number; removedLines: number; unified: string } | undefined
  /** How many creates the batch carries (so the caller can predict their keys). */
  createCount: number
  batch: Required<Pick<ExecuteBatchParameters, "creates" | "patches" | "extensions">>
}

/** Pass 1: everything except entity keys. */
export async function planCheck(input: CheckInput, predicted: PredictedKey[] = []): Promise<CheckPlan> {
  const url = canonicalUrl(input.url)
  const uh = await hashUrl(url)
  const domain = domainOf(url)
  const contentHash = await sha256Hex(input.text)
  const sizeBytes = byteLength(input.text)
  const encoded = await encodeText(input.text)

  const creates: CreateEntityParameters[] = []
  const patches: PatchEntityParameters[] = []
  const extensions: ExtendEntityParameters[] = []

  if (!input.page) {
    creates.push(
      buildPageCreate({
        url,
        urlHash: uh,
        domain,
        event: input.event,
        title: input.title,
        checkedAt: input.fetchedAt,
        latestVersion: 1,
        latestContentHash: contentHash,
      }),
    )
    creates.push(
      buildSnapshotCreate({
        urlHash: uh,
        domain,
        event: input.event,
        fetchedAt: input.fetchedAt,
        version: 1,
        contentHash,
        sizeBytes,
        encoded,
        salt: predicted[1]?.salt,
      }),
    )
    if (predicted[0]) creates[0] = { ...creates[0]!, salt: predicted[0].salt }
    return {
      kind: "new-page",
      url,
      urlHash: uh,
      contentHash,
      version: 1,
      sizeBytes,
      createCount: 2,
      batch: { creates, patches, extensions },
    }
  }

  const pageKey = input.page.key
  const latest = input.latest
  if (latest && latest.record.contentHash === contentHash) {
    patches.push(
      buildPagePatch(pageKey, {
        checkedAt: input.fetchedAt,
        latestVersion: latest.record.version,
        latestContentHash: contentHash,
      }),
    )
    extensions.push(buildPageExtension(pageKey))
    return {
      kind: "unchanged",
      url,
      urlHash: uh,
      contentHash,
      version: latest.record.version,
      sizeBytes,
      createCount: 0,
      batch: { creates, patches, extensions },
    }
  }

  const version = (latest?.record.version ?? input.page.latestVersion ?? 0) + 1
  const snapshotKey = predicted[0]?.key
  creates.push(
    buildSnapshotCreate({
      urlHash: uh,
      domain,
      event: input.event,
      fetchedAt: input.fetchedAt,
      version,
      contentHash,
      sizeBytes,
      encoded,
      salt: predicted[0]?.salt,
    }),
  )
  let diff: CheckPlan["diff"]
  if (latest) {
    diff = makeDiff(latest.text, input.text, {
      fromVersion: latest.record.version,
      toVersion: version,
      fromFetchedAt: latest.record.fetchedAt,
      toFetchedAt: input.fetchedAt,
    })
    creates.push(
      buildDiffCreate({
        urlHash: uh,
        domain,
        event: input.event,
        fromVersion: latest.record.version,
        toVersion: version,
        changedAt: input.fetchedAt,
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        fromSnapshot: latest.record.key,
        toSnapshot: snapshotKey,
        unified: capDiff(diff.unified),
        salt: predicted[1]?.salt,
      }),
    )
  }
  patches.push(
    buildPagePatch(pageKey, {
      checkedAt: input.fetchedAt,
      latestVersion: version,
      latestContentHash: contentHash,
    }),
  )
  extensions.push(buildPageExtension(pageKey))
  return {
    kind: "changed",
    url,
    urlHash: uh,
    contentHash,
    version,
    sizeBytes,
    diff,
    createCount: creates.length,
    batch: { creates, patches, extensions },
  }
}

/**
 * Keeps a diff payload under the engine's 128 KiB cap. Both full snapshots are on chain, so a
 * truncated diff loses nothing that cannot be recomputed; the marker says so.
 */
export function capDiff(unified: string, maxBytes: number = GZIP_THRESHOLD_BYTES): string {
  if (byteLength(unified) <= maxBytes) return unified
  const marker = "\n\\ diff truncated by Fine Print Ledger; compare the two full snapshots\n"
  let cut = unified.slice(0, maxBytes)
  while (byteLength(cut) + byteLength(marker) > maxBytes) cut = cut.slice(0, cut.length - 1024)
  return cut.slice(0, cut.lastIndexOf("\n") + 1) + marker.slice(1)
}

/** A JSON-safe view of a batch for --dry-run output and logs (payloads summarized). */
export function describeBatch(batch: CheckPlan["batch"]): unknown {
  const show = (v: unknown): unknown =>
    typeof v === "bigint"
      ? v.toString()
      : v && typeof v === "object" && "type" in v && "value" in v
        ? `${(v as { type: string }).type}(${String((v as { value: unknown }).value)})`
        : v
  return {
    creates: batch.creates.map((c) => ({
      attributes: Object.fromEntries(Object.entries(c.attributes ?? {}).map(([k, v]) => [k, show(v)])),
      contentType: c.contentType,
      payloadBytes: c.payload.length,
      payloadPreview: c.contentType.startsWith("text/") || c.contentType === "application/json"
        ? new TextDecoder().decode(c.payload.slice(0, 240))
        : `<${c.contentType}>`,
      expiresInBlocks: c.expires.minLifetime.toString(),
      flags: c.flags ?? {},
      salt: c.salt === undefined ? "random" : String(c.salt),
    })),
    patches: batch.patches.map((p) => ({
      entityKey: p.entityKey,
      set: Object.fromEntries(Object.entries(p.set ?? {}).map(([k, v]) => [k, show(v)])),
    })),
    extensions: batch.extensions.map((e) => ({
      entityKey: e.entityKey,
      expiresInBlocks: e.expires.minLifetime.toString(),
    })),
  }
}
