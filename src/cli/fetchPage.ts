import { canonicalUrl } from "../core/hash"
import { applyIgnore, extractTitle, normalizeHtml, normalizeText } from "../core/normalize"

// "Mozilla/5.0 (compatible; ...)" is the conventional crawler form; some hosts (Devpost's WAF)
// answer 403 to a user agent without it.
export const USER_AGENT = "Mozilla/5.0 (compatible; FinePrintLedger/0.1; public contest-rules snapshotter)"

const MAX_BYTES = 5 * 1024 * 1024

export type FetchedPage = {
  url: string
  status: number
  title: string
  text: string
  /** Unix seconds when the response arrived. */
  fetchedAt: number
}

/** Fetches a public page and returns its normalized text. Only public, unauthenticated GETs. */
export async function fetchPage(input: string, ignore: readonly string[] = []): Promise<FetchedPage> {
  const url = canonicalUrl(input)
  const res = await fetch(url, {
    // No custom Accept header: Devpost's WAF answers 403 to "text/html,...;q=0.9" from non-browsers.
    headers: { "user-agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  })
  const fetchedAt = Math.floor(Date.now() / 1000)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error(`GET ${url} -> ${buf.length} bytes, over the 5 MB cap`)
  const body = new TextDecoder("utf-8").decode(buf)
  const type = res.headers.get("content-type") ?? ""
  const isHtml = type.includes("html") || /<html[\s>]/i.test(body.slice(0, 2000))
  return {
    url,
    status: res.status,
    title: isHtml ? extractTitle(body) : "",
    text: applyIgnore(isHtml ? normalizeHtml(body) : normalizeText(body), ignore),
    fetchedAt,
  }
}
