/**
 * HTML -> normalized plain text. Pure string processing, so the same code runs in Node (the
 * snapshotter), in the browser and in unit tests.
 *
 * Normalization is what makes contentHash meaningful: two fetches of an unchanged page must produce
 * byte-identical text even if the page's scripts, tracking pixels or whitespace differ.
 */

/** Elements whose whole subtree is dropped: code, chrome and navigation, not terms. */
const DROP_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "canvas",
  "nav",
  "header",
  "footer",
  "head",
  "button",
  "select",
  "form",
] as const

/** Elements that start a new line in the text output. */
const BLOCK_ELEMENTS = [
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  times: "×",
  rarr: "→",
  larr: "←",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** The <title> text, decoded and collapsed, or "" if the page has none. */
export function extractTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  return m?.[1] ? collapse(decodeEntities(m[1])) : ""
}

function collapse(line: string): string {
  return line.replace(/[\s ​-‍﻿]+/g, " ").trim()
}

function dropElement(html: string, tag: string): string {
  // Non-greedy match of a whole element. Repeated so that a nested element of the same tag
  // (nav inside nav) is also removed once its inner match has been taken out.
  // Innermost first: the body may not contain another opening tag of the same name.
  const re = new RegExp(`<${tag}\\b[^>]*>(?:(?!<${tag}\\b)[\\s\\S])*?<\\/${tag}\\s*>`, "gi")
  let prev: string
  let out = html
  do {
    prev = out
    out = out.replace(re, " ")
  } while (out !== prev)
  // Unclosed or self-closing leftovers (e.g. <iframe ... />).
  return out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), " ")
}

/**
 * Converts an HTML document to normalized text:
 * scripts, styles, navigation and page chrome removed; block elements become line breaks;
 * entities decoded; whitespace collapsed per line; empty lines removed; Unicode NFC.
 */
export function normalizeHtml(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ")
  for (const tag of DROP_ELEMENTS) s = dropElement(s, tag)
  // List items keep a bullet so the structure of a rules list survives.
  s = s.replace(/<li\b[^>]*>/gi, "\n- ")
  const blocks = BLOCK_ELEMENTS.join("|")
  s = s.replace(new RegExp(`<\\/?(?:${blocks})\\b[^>]*>`, "gi"), "\n")
  s = s.replace(/<[^>]*>/g, " ")
  s = decodeEntities(s)
  return normalizeText(s)
}

/** Whitespace/Unicode normalization for text that is already plain. Idempotent. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .split(/\r\n|\r|\n/)
    .map(collapse)
    .filter((line) => line.length > 0 && line !== "-")
    .join("\n")
}
