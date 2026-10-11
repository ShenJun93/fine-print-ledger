import type { EntityEvent, PublicArkivClient } from "@arkiv-network/sdk"
import { httpClient, rateLimitedFor, wsClient } from "../src/core/client"
import {
  APP,
  DEFAULT_TRUSTED_SNAPSHOTTERS,
  explorerAddressUrl,
  explorerEntityUrl,
  explorerTxUrl,
  TIRAMISU,
} from "../src/core/config"
import { parseUnified } from "../src/core/diff"
import { decodePage, type DiffRecord, type PageRecord, type SnapshotRecord } from "../src/core/entities"
import { sha256Hex } from "../src/core/hash"
import { decodeText } from "../src/core/payload"
import { curlFor, queryText, type TrustMode } from "../src/core/queries"
import { ArkivSource, type DataSource, type PageDetail } from "./data"
import { FixtureSource } from "./fixture"
import { citeWithWallet, hasWallet } from "./wallet"

type Hex = `0x${string}`

// ---------------------------------------------------------------------------------------------
// config

const TRUSTED: Hex[] = (
  (import.meta.env.VITE_TRUSTED_SNAPSHOTTERS as string | undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [...DEFAULT_TRUSTED_SNAPSHOTTERS]
) as Hex[]

const params = new URLSearchParams(location.search)
const FIXTURE = params.has("fixture")

// retryCount 0: on HTTP 429 viem would otherwise wait out Retry-After (tens of minutes) in silence.
const client: PublicArkivClient | undefined = FIXTURE ? undefined : httpClient(TIRAMISU.http, undefined, { retryCount: 0 })
const source: DataSource = FIXTURE ? new FixtureSource() : new ArkivSource(client!)

// ---------------------------------------------------------------------------------------------
// state

type State = {
  showUntrusted: boolean
  pages: PageRecord[]
  selected?: string | undefined
  detail?: PageDetail | undefined
  version?: number | undefined
  /** key of the selected snapshot, when several share a version (forgeries). */
  snapKey?: string | undefined
  tab: "changes" | "text"
  asOf?: { at: number; result: SnapshotRecord | undefined } | undefined
  timing: { block: bigint; time: number; duration: number }
}

const state: State = {
  showUntrusted: false,
  pages: [],
  tab: "changes",
  timing: { block: 0n, time: Math.floor(Date.now() / 1000), duration: 2 },
}

const trust = (): TrustMode =>
  state.showUntrusted ? { kind: "any" } : { kind: "trusted", creators: TRUSTED }

const isTrusted = (creator: string) => TRUSTED.some((t) => t.toLowerCase() === creator.toLowerCase())

// ---------------------------------------------------------------------------------------------
// helpers

const $ = (id: string) => document.getElementById(id)!

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const short = (h: string, n = 6) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h)
const fmt = (s: number) =>
  s ? new Date(s * 1000).toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC") : "—"
const blockToTime = (b: bigint) =>
  state.timing.time + Number(b - state.timing.block) * state.timing.duration
const fmtDay = (s: number) => new Date(s * 1000).toISOString().slice(0, 10)

function safeHttpUrl(u: string): string | undefined {
  try {
    const x = new URL(u)
    return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : undefined
  } catch {
    return undefined
  }
}

function creatorBadge(creator: string) {
  const ok = isTrusted(creator)
  return `<a class="badge ${ok ? "ok" : "bad"}" href="${esc(explorerAddressUrl(creator))}" target="_blank" rel="noopener noreferrer" title="$creator ${esc(creator)}">${ok ? "trusted" : "UNTRUSTED"} · ${esc(short(creator, 4))}</a>`
}

/** A read error as banner HTML; the public RPC's anonymous budget gets its own explanation. */
function readErrorHtml(e: unknown): string {
  const wait = rateLimitedFor(e)
  if (wait === undefined) return `Could not read from Arkiv: ${esc((e as Error).message.split("\n")[0])}`
  const mins = Math.max(1, Math.ceil(wait / 60))
  return `The public Tiramisu RPC has used up its anonymous query budget for your network (keyless reads: about 100 queries per hour per IP). It resets in about ${mins} min. This app has no backend and ships no access key, so it reads only what your browser may read. Meanwhile, the <a href="?fixture=1">offline demo</a> shows the same UI, and the README's terminal commands read the same data with your own access key.`
}

function banner(html: string, kind: "info" | "warn" | "error" = "info") {
  $("banner").innerHTML = html ? `<div class="banner ${kind}">${html}</div>` : ""
}

// ---------------------------------------------------------------------------------------------
// rendering

function renderTrust() {
  $("trust").innerHTML = `
    <div>Trusted snapshotter${TRUSTED.length > 1 ? "s" : ""}:
      ${TRUSTED.map((t) => `<a class="mono" href="${esc(explorerAddressUrl(t))}" target="_blank" rel="noopener noreferrer">${esc(short(t, 4))}</a>`).join(", ")}</div>
    <label class="toggle"><input type="checkbox" id="untrusted" ${state.showUntrusted ? "checked" : ""}/> Also show entities from other creators</label>
    <div class="muted small">Source: ${esc(source.label)}</div>`
  ;($("untrusted") as HTMLInputElement).onchange = (e) => {
    state.showUntrusted = (e.target as HTMLInputElement).checked
    void loadPages()
  }
}

function renderPages() {
  const el = $("pages")
  if (state.pages.length === 0) {
    el.innerHTML = `<div class="empty">
      <p><strong>No snapshots on chain yet.</strong></p>
      <p class="muted small">The snapshotter has not written to Tiramisu yet, or every page lease has expired. The query in "Verify it yourself" returned 0 rows. Run <code>npm run snap -- seed</code> with a funded wallet, or open <a href="?fixture=1">the synthetic fixture</a>.</p></div>`
    return
  }
  el.innerHTML = `<ul class="pagelist">${state.pages
    .map((p) => {
      const leaseEnd = blockToTime(p.expiresAt)
      return `<li><button class="pagebtn ${p.urlHash === state.selected ? "sel" : ""}" data-uh="${esc(p.urlHash)}">
        <span class="ev">${esc(p.event || p.domain)}</span>
        <span class="t">${esc(p.title || p.url)}</span>
        <span class="meta">v${p.latestVersion} · checked ${esc(fmtDay(p.lastCheckedAt))} · lease to ≈${esc(fmtDay(leaseEnd))}</span>
        ${isTrusted(p.creator) ? "" : `<span class="badge bad">UNTRUSTED ${esc(short(p.creator, 4))}</span>`}
      </button></li>`
    })
    .join("")}</ul>`
  el.querySelectorAll<HTMLButtonElement>(".pagebtn").forEach((b) => {
    b.onclick = () => select(b.dataset.uh!)
  })
}

function selectedSnapshot(): SnapshotRecord | undefined {
  const snaps = state.detail?.snapshots ?? []
  if (state.snapKey) return snaps.find((s) => s.key === state.snapKey)
  return snaps.find((s) => s.version === state.version && isTrusted(s.creator)) ?? snaps.find((s) => s.version === state.version)
}

function diffInto(s: SnapshotRecord | undefined): DiffRecord | undefined {
  if (!s) return undefined
  const diffs = state.detail?.diffs ?? []
  return (
    diffs.find((d) => d.toSnapshot && d.toSnapshot.toLowerCase() === s.key.toLowerCase()) ??
    diffs.find((d) => d.toVersion === s.version && d.creator.toLowerCase() === s.creator.toLowerCase())
  )
}

async function renderDetail() {
  const el = $("detail")
  const page = state.pages.find((p) => p.urlHash === state.selected)
  if (!page || !state.detail) {
    el.innerHTML = `<p class="muted">Select a page to see its versions.</p>`
    return
  }
  const { snapshots, citations } = state.detail
  const url = safeHttpUrl(page.url)
  const snap = selectedSnapshot()
  const diff = diffInto(snap)
  const leaseEnd = blockToTime(page.expiresAt)

  el.innerHTML = `
    <div class="phead">
      <div class="ev">${esc(page.event)} · ${esc(page.domain)}</div>
      <h2>${esc(page.title || page.url)}</h2>
      ${url ? `<a class="mono small" href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url)}</a>` : ""}
      <div class="kv small">
        <span>url_hash <code>${esc(short(page.urlHash, 8))}</code></span>
        <span>last checked ${esc(fmt(page.lastCheckedAt))}</span>
        <span title="Entity Expiration of the page watch. Each re-check renews it (Lifetime Extension).">watch lease ends ≈ ${esc(fmtDay(leaseEnd))} (block ${page.expiresAt})</span>
        ${creatorBadge(page.creator)}
      </div>
      ${page.ignore.length ? `<div class="small muted" title="Lines matching these public patterns are dropped before hashing, so live counters do not create new versions.">Ignored lines: ${page.ignore.map((p) => `<code>${esc(p)}</code>`).join(" ")}</div>` : ""}
    </div>

    <form class="asof" id="asof">
      <label>What did it say on <input type="datetime-local" id="asof-at" required value="${state.asOf ? new Date(state.asOf.at * 1000).toISOString().slice(0, 16) : ""}"/> UTC?</label>
      <button type="submit">Look up</button>
      ${state.asOf ? `<span class="small">${state.asOf.result ? `→ <button type="button" class="linkish" id="asof-go">v${state.asOf.result.version}, fetched ${esc(fmt(state.asOf.result.fetchedAt))}</button>` : "→ no snapshot at or before that time"}</span>` : ""}
    </form>

    <h3>Versions</h3>
    <ol class="timeline">
      ${snapshots
        .map((s) => {
          const d = state.detail!.diffs.find((x) => x.toSnapshot?.toLowerCase() === s.key.toLowerCase()) ??
            state.detail!.diffs.find((x) => x.toVersion === s.version && x.creator.toLowerCase() === s.creator.toLowerCase())
          return `<li class="${snap?.key === s.key ? "sel" : ""} ${isTrusted(s.creator) ? "" : "forged"}">
          <button class="vbtn" data-key="${esc(s.key)}" data-v="${s.version}">
            <span class="v">v${s.version}</span>
            <span>${esc(fmt(s.fetchedAt))}</span>
            <span class="muted">${s.sizeBytes} B · ${esc(s.contentHash.slice(0, 10))}</span>
            ${d ? `<span class="chg"><span class="add">+${d.addedLines}</span> <span class="del">−${d.removedLines}</span></span>` : s.version === 1 ? `<span class="muted">first snapshot</span>` : ""}
            ${isTrusted(s.creator) ? "" : `<span class="badge bad">UNTRUSTED</span>`}
          </button></li>`
        })
        .join("")}
    </ol>

    ${snap ? snapshotPanel(snap, diff) : ""}

    <h3>Citations <span class="muted small">(anyone can cite; creator shown)</span></h3>
    ${
      citations.length
        ? `<ul class="cites">${citations
            .map(
              (c) => `<li><span class="v">v${c.version}</span> “${esc(c.note)}” <span class="muted small">${esc(fmt(c.citedAt))}</span>
              <a class="badge ${isTrusted(c.creator) ? "ok" : "neutral"}" href="${esc(explorerAddressUrl(c.creator))}" target="_blank" rel="noopener noreferrer">cited by ${esc(short(c.creator, 4))}</a></li>`,
            )
            .join("")}</ul>`
        : `<p class="muted small">No citations yet. Citing a snapshot pins it as evidence and extends its lifetime.</p>`
    }`

  el.querySelectorAll<HTMLButtonElement>(".vbtn").forEach((b) => {
    b.onclick = () => {
      state.version = Number(b.dataset.v)
      state.snapKey = b.dataset.key
      writeHash()
      void renderDetail()
    }
  })
  el.querySelectorAll<HTMLButtonElement>(".tabbtn").forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab as State["tab"]
      void renderDetail()
    }
  })
  ;($("asof") as HTMLFormElement).onsubmit = (e) => {
    e.preventDefault()
    const v = ($("asof-at") as HTMLInputElement).value
    if (v) void lookupAsOf(Math.floor(new Date(`${v}:00Z`).getTime() / 1000))
  }
  const go = document.getElementById("asof-go")
  if (go && state.asOf?.result) {
    const r = state.asOf.result
    go.onclick = () => {
      state.version = r.version
      state.snapKey = r.key
      writeHash()
      void renderDetail()
    }
  }
  const cite = document.getElementById("cite")
  if (cite && snap) cite.onclick = () => void cite_(snap)
  if (snap) void fillSnapshotBody(snap, diff)
  renderVerify(page, snap)
}

function snapshotPanel(s: SnapshotRecord, diff: DiffRecord | undefined) {
  const expires = blockToTime(s.expiresAt)
  return `
    <div class="snap ${isTrusted(s.creator) ? "" : "forged"}">
      <div class="snaphead">
        <strong>v${s.version}</strong> fetched ${esc(fmt(s.fetchedAt))}
        ${creatorBadge(s.creator)}
        <a class="mono small" href="${esc(explorerEntityUrl(s.key))}" target="_blank" rel="noopener noreferrer">entity ${esc(short(s.key, 6))}</a>
      </div>
      <div class="kv small">
        <span id="hashcheck">checking hash…</span>
        <span title="Entity Expiration. Citing extends it.">kept until ≈ ${esc(fmtDay(expires))} (block ${s.expiresAt})</span>
        <span>${s.readonly ? "readonly: content can never be edited" : "editable"}</span>
        <span>${s.permissionlessExtension ? "anyone may extend its lifetime" : "only the owner may extend"}</span>
      </div>
      ${isTrusted(s.creator) ? "" : `<p class="warn small">This entity was not created by the trusted snapshotter. Its attributes copy a real page, but anyone can write those. Do not rely on it.</p>`}
      <div class="tabs" role="tablist">
        <button class="tabbtn ${state.tab === "changes" ? "on" : ""}" data-tab="changes" role="tab">Changes ${diff ? `v${diff.fromVersion} → v${diff.toVersion}` : ""}</button>
        <button class="tabbtn ${state.tab === "text" ? "on" : ""}" data-tab="text" role="tab">Full text</button>
      </div>
      <div id="snapbody" class="snapbody"><p class="muted">Loading…</p></div>
      <div class="citebox">
        <button id="cite" ${hasWallet() && !FIXTURE ? "" : "disabled"} title="${hasWallet() ? "Create a citation with your wallet" : "Needs a browser wallet on Tiramisu"}">Cite this snapshot as evidence</button>
        <span class="muted small">Or from a terminal: <code>npm run snap -- cite ${esc(s.key)} --note "…"</code></span>
      </div>
    </div>`
}

async function fillSnapshotBody(s: SnapshotRecord, diff: DiffRecord | undefined) {
  const body = document.getElementById("snapbody")
  const hc = document.getElementById("hashcheck")
  if (!body) return
  let text = ""
  try {
    text = s.payload ? await decodeText(s.payload, s.contentType) : ""
    const h = await sha256Hex(text)
    if (hc)
      hc.innerHTML =
        h === s.contentHash
          ? `<span class="okc">✓ sha256 recomputed in your browser matches content_hash</span>`
          : `<span class="badc">✗ payload hash ${esc(h.slice(0, 12))} ≠ content_hash ${esc(s.contentHash.slice(0, 12))}</span>`
  } catch (e) {
    if (hc) hc.textContent = `could not decode payload: ${(e as Error).message}`
  }
  if (state.tab === "text") {
    body.innerHTML = `<pre class="fulltext">${esc(text)}</pre>`
    return
  }
  if (!diff) {
    body.innerHTML = `<p class="muted small">${s.version === 1 ? "First snapshot of this page: nothing to compare with yet." : "No diff entity for this version."} See “Full text”.</p>`
    return
  }
  const lines = parseUnified(diff.unified)
  body.innerHTML = `<div class="diffmeta small muted">diff entity <a class="mono" href="${esc(explorerEntityUrl(diff.key))}" target="_blank" rel="noopener noreferrer">${esc(short(diff.key, 6))}</a> · changed ${esc(fmt(diff.changedAt))} · ${creatorBadge(diff.creator)}</div>
    <pre class="diff">${lines
      .map((l) => `<span class="${l.kind}">${l.kind === "add" ? "+ " : l.kind === "del" ? "− " : l.kind === "hunk" ? "" : "  "}${esc(l.text)}</span>`)
      .join("")}</pre>`
}

function renderVerify(page?: PageRecord, snap?: SnapshotRecord) {
  const ran = source.ran.slice(-7)
  const main = ran.find((r) => r.spec.name.startsWith("Snapshots")) ?? ran[0]
  $("verify").innerHTML = `
    <p class="small">Everything on this page came from these Arkiv queries, run by your browser against
    <code>${esc(TIRAMISU.http)}</code>. Run them yourself:</p>
    ${ran
      .map(
        (r) => `<details ${r === main ? "open" : ""}><summary>${esc(r.spec.name)} <span class="muted">· ${r.rows} rows${r.block ? ` · block ${r.block}` : ""}${r.pages > 1 ? ` · ${r.pages} pages via cursor` : ""}</span></summary>
        <pre class="code">${esc(queryText(r.spec))}</pre></details>`,
      )
      .join("")}
    ${
      main
        ? `<details><summary>Same query with curl (raw JSON-RPC)</summary><pre class="code">${esc(curlFor(main.spec, main.withPayload))}</pre></details>
           <details><summary>Same query with the SDK</summary><pre class="code">${esc(sdkSnippet(queryText(main.spec)))}</pre></details>`
        : ""
    }
    ${
      page
        ? `<details><summary>Re-fetch the live page and compare</summary><pre class="code">git clone &lt;this repo&gt; &amp;&amp; npm install
npm run snap -- verify ${esc(page.url)}${snap ? ` --at ${esc(new Date(snap.fetchedAt * 1000 + 1000).toISOString())}` : ""}</pre>
          <p class="small muted">Normalizes the live page with the same code, hashes it, and compares with the trusted snapshot.</p></details>`
        : ""
    }`
}

function sdkSnippet(q: string) {
  return `import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"

const client = createPublicClient({ chain: tiramisu, transport: http() })
// the query below is what .where(...).createdBy(...) renders
const res = await client.request({
  method: "arkiv_query",
  params: [${JSON.stringify(q)}, { select: { key: true, creator: true, attributes: true, payload: true } }],
})`
}

// ---------------------------------------------------------------------------------------------
// actions

function writeHash() {
  const h = new URLSearchParams()
  if (state.selected) h.set("p", state.selected)
  if (state.version) h.set("v", String(state.version))
  history.replaceState(null, "", `${location.pathname}${location.search}#${h}`)
}

async function loadTiming() {
  if (!client) return
  try {
    const t = await client.getBlockTiming()
    state.timing = { block: t.currentBlock, time: t.currentBlockTime, duration: t.blockDuration || 2 }
  } catch {
    /* fall back to estimates */
  }
}

async function loadPages() {
  source.resetRan()
  try {
    state.pages = await source.listPages(trust())
    renderPages()
    renderTrust()
    if (state.selected && state.pages.some((p) => p.urlHash === state.selected)) await select(state.selected, true)
    else if (!state.selected && state.pages[0]) await select(state.pages[0].urlHash)
    else renderVerify()
  } catch (e) {
    banner(readErrorHtml(e), "error")
    renderVerify()
  }
}

async function select(urlHash: string, keepVersion = false) {
  state.selected = urlHash
  state.asOf = undefined
  if (!keepVersion) {
    state.version = undefined
    state.snapKey = undefined
  }
  renderPages()
  // keep the page-list query in the verify panel, drop the previous page's queries
  source.ran = source.ran.filter((r) => r.spec.name === "Watched pages")
  try {
    state.detail = await source.detail(urlHash, trust())
  } catch (e) {
    banner(readErrorHtml(e), "error")
    return
  }
  if (state.version === undefined) {
    const top = state.detail.snapshots.find((s) => isTrusted(s.creator)) ?? state.detail.snapshots[0]
    state.version = top?.version
    state.snapKey = top?.key
  }
  writeHash()
  await renderDetail()
}

async function lookupAsOf(at: number) {
  if (!state.selected) return
  let result: SnapshotRecord | undefined
  try {
    result = await source.asOf(state.selected, at, trust())
  } catch (e) {
    banner(readErrorHtml(e), "error")
    return
  }
  state.asOf = { at, result }
  await renderDetail()
}

async function cite_(s: SnapshotRecord) {
  const note = prompt("Short public note for this citation (no personal data), max 280 characters:", "Rules as of my registration")
  if (note === null) return
  try {
    banner("Waiting for your wallet…")
    const res = await citeWithWallet(s, state.detail?.diffs ?? [], note.slice(0, 280))
    banner(`Citation written: <a href="${esc(explorerTxUrl(res.txHash))}" target="_blank" rel="noopener noreferrer">${esc(short(res.txHash, 8))}</a>. The snapshot's lifetime was extended.`)
    source.invalidate()
    if (state.selected) await select(state.selected, true)
  } catch (e) {
    banner(`Citation failed: ${esc((e as Error).message.split("\n")[0])}`, "error")
  }
}

// ---------------------------------------------------------------------------------------------
// live feed: watchEntityEvents over a WebSocket transport, no fromBlock, so it is a real
// eth_subscribe and the page updates without polling or reloading.

let otherEvents = 0
function feedItem(html: string) {
  const ol = $("feed")
  const li = document.createElement("li")
  li.innerHTML = html
  ol.prepend(li)
  while (ol.children.length > 25) ol.lastElementChild?.remove()
}

function startLive() {
  if (FIXTURE) {
    $("live-status").textContent = "Disabled in fixture mode."
    return
  }
  const ws = wsClient()
  const dot = $("live-dot")
  const statusEl = $("live-status")
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      source.invalidate()
      void loadPages()
    }, 1500)
  }
  const known = () =>
    new Set(
      [
        ...state.pages.map((p) => p.key),
        ...(state.detail?.snapshots.map((s) => s.key) ?? []),
        ...(state.detail?.diffs.map((d) => d.key) ?? []),
      ].map((k) => k.toLowerCase()),
    )

  ws.watchEntityEvents({
    onEvent: async (ev: EntityEvent) => {
      dot.className = "dot live"
      dot.title = "live"
      const owner = ("owner" in ev ? ev.owner : ev.newOwner).toLowerCase()
      const fromSnapshotter = TRUSTED.some((t) => t.toLowerCase() === owner)
      if (!fromSnapshotter && !known().has(ev.entityKey.toLowerCase())) {
        otherEvents++
        statusEl.textContent = `Live over WebSocket. ${otherEvents} other Arkiv entity event${otherEvents === 1 ? "" : "s"} seen on Tiramisu (other apps), ignored.`
        return
      }
      let label: string = ev.type
      try {
        if (ev.type === "EntityCreated" || ev.type === "EntityPatched") {
          const e = await ws.getEntity(ev.entityKey)
          if (e.attributes?.app?.value !== APP) return
          const type = String(e.attributes?.type?.value)
          const p = type === "page" ? decodePage(e) : undefined
          label = `${ev.type === "EntityCreated" ? "new" : "updated"} ${type}${p ? ` · ${p.event}` : ""}`
        } else if (ev.type === "ExpiryExtended") {
          label = "lifetime extended"
        }
      } catch {
        /* entity may already be gone */
      }
      feedItem(`<span class="ft">${esc(label)}</span> <a class="mono small" href="${esc(explorerTxUrl(ev.transactionHash))}" target="_blank" rel="noopener noreferrer">${esc(short(ev.transactionHash, 4))}</a> <span class="muted small">block ${ev.blockNumber}</span>`)
      scheduleRefresh()
    },
    onError: (err) => {
      dot.className = "dot err"
      dot.title = "error"
      statusEl.textContent = `WebSocket error: ${err.message.split("\n")[0]}`
    },
  })
  statusEl.textContent = "Subscribed over WebSocket. Waiting for events…"
  dot.className = "dot live"
}

// ---------------------------------------------------------------------------------------------

async function main() {
  renderTrust()
  if (FIXTURE) {
    banner(
      `<strong>Fixture mode.</strong> Synthetic data built in your browser with the real entity builders. Nothing here is on Arkiv. <a href="${esc(location.pathname)}">Back to live data</a>.`,
      "warn",
    )
  }
  const h = new URLSearchParams(location.hash.slice(1))
  if (h.get("p")) state.selected = h.get("p")!
  if (h.get("v")) state.version = Number(h.get("v"))
  await loadTiming()
  await loadPages()
  startLive()
}

void main()
