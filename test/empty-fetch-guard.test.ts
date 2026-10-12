import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchPage } from "../src/cli/fetchPage"
import { planCheck } from "../src/core/plan"

afterEach(() => vi.unstubAllGlobals())

describe("empty extracted page safety", () => {
  it("rejects an HTTP 200 HTML shell with no public text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html><head><title>Zindi</title></head><body><script>renderApp()</script></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    )))
    await expect(fetchPage("https://example.org/rules")).rejects.toThrow(/normalized page text is empty/)
  })

  it("rejects a page whose only visible line is excluded by an ignore rule", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html><body><main><p>1106 joined</p></main></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    )))
    await expect(fetchPage("https://example.org/rules", ["^1106 joined$"])).rejects.toThrow(/normalized page text is empty/)
  })

  it("continues to accept a normal public rules page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html><body><main><h1>Rules</h1><p>Prize: $100</p></main></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    )))
    const page = await fetchPage("https://example.org/rules")
    expect(page.text).toBe(["Rules", "Prize: $100"].join("\n"))
  })

  it("rejects an empty direct write plan even when fetch is bypassed", async () => {
    await expect(planCheck({
      url: "https://example.org/rules", event: "demo", title: "Rules", text: "", fetchedAt: 1760086400,
    })).rejects.toThrow(/empty normalized page snapshot/)
  })
})
