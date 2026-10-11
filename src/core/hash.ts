/**
 * SHA-256 over UTF-8 text using WebCrypto, which both Node (>= 20) and browsers provide, so the
 * browser can recompute a snapshot's contentHash from its payload without trusting anyone.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid)$/i

/**
 * The canonical form of a watched URL: http(s) only, no fragment, no tracking parameters, sorted
 * query, lower-case host (URL does that), no trailing slash on a non-root path.
 */
export function canonicalUrl(input: string): string {
  const url = new URL(input.trim())
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Only http(s) URLs can be watched, got ${url.protocol}`)
  }
  url.hash = ""
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(name)) url.searchParams.delete(name)
  }
  url.searchParams.sort()
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "")
  }
  return url.toString()
}

/** urlHash = sha256(canonicalUrl). Equal for every spelling of the same page. */
export async function urlHash(input: string): Promise<string> {
  return sha256Hex(canonicalUrl(input))
}

export function domainOf(input: string): string {
  return new URL(input).hostname.replace(/^www\./, "")
}

/** UTF-8 byte length. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
