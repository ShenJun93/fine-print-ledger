import { describe, expect, it } from "vitest"
import { diffStats, makeDiff, parseUnified } from "../src/core/diff"
import { byteLength, canonicalUrl, domainOf, sha256Hex, urlHash } from "../src/core/hash"
import { decodeText, encodeText } from "../src/core/payload"

describe("hashing", () => {
  it("sha256Hex matches the known vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })
  it("canonicalUrl removes fragments, tracking params and trailing slashes", () => {
    expect(canonicalUrl("https://Example.org/rules/?utm_source=x&b=2&a=1#top")).toBe(
      "https://example.org/rules?a=1&b=2",
    )
    expect(canonicalUrl("https://example.org/")).toBe("https://example.org/")
    expect(() => canonicalUrl("ftp://example.org/x")).toThrow()
  })
  it("urlHash is equal for every spelling of the same page", async () => {
    expect(await urlHash("https://EXAMPLE.org/rules/#x")).toBe(await urlHash("https://example.org/rules"))
  })
  it("domainOf strips www", () => {
    expect(domainOf("https://www.example.org/a")).toBe("example.org")
  })
  it("byteLength counts UTF-8 bytes", () => {
    expect(byteLength("é€")).toBe(5)
  })
})

describe("diffing", () => {
  const v1 = "Rules\nPrize: $10,000\nTeam size: 5\nDeadline: 31 Oct"
  const v2 = "Rules\nPrize: $5,000\nTeam size: 5\nDeadline: 31 Oct\nNew: organisers may change prizes"

  it("counts added and removed lines", () => {
    expect(diffStats(v1, v2)).toEqual({ addedLines: 2, removedLines: 1 })
    expect(diffStats(v1, v1)).toEqual({ addedLines: 0, removedLines: 0 })
  })

  it("produces a unified diff that parses back into highlighted lines", () => {
    const d = makeDiff(v1, v2, { fromVersion: 1, toVersion: 2, fromFetchedAt: 1760000000, toFetchedAt: 1760086400 })
    expect(d.unified).toContain("--- v1")
    expect(d.unified).toContain("+++ v2")
    expect(d.unified).toContain("-Prize: $10,000")
    expect(d.unified).toContain("+Prize: $5,000")
    const lines = parseUnified(d.unified)
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual([
      "Prize: $5,000",
      "New: organisers may change prizes",
    ])
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["Prize: $10,000"])
    expect(lines[0]?.kind).toBe("hunk")
  })
})

describe("payload encoding", () => {
  it("stores small text as text/plain and round-trips", async () => {
    const e = await encodeText("hello rules")
    expect(e.contentType).toBe("text/plain")
    expect(await decodeText(e.payload, e.contentType)).toBe("hello rules")
  })
  it("gzips text above the threshold and round-trips", async () => {
    const big = "Clause 1. The organiser may amend these rules.\n".repeat(400)
    const e = await encodeText(big, 1024)
    expect(e.contentType).toBe("application/gzip")
    expect(e.payload.length).toBeLessThan(byteLength(big))
    expect(await decodeText(e.payload, e.contentType)).toBe(big)
  })
})
