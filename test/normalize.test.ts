import { describe, expect, it } from "vitest"
import { applyIgnore, decodeEntities, extractTitle, normalizeHtml, normalizeText } from "../src/core/normalize"

describe("applyIgnore", () => {
  it("drops whole lines matching public ignore patterns (live counters), keeps the rest", () => {
    const text = "Prize: $10,000\n1106 joined\n162 active\n21 days left\nTeam size: 5"
    expect(applyIgnore(text, ["^[\\d,]+ (joined|active)$", "^\\d+ (days?|hours?) left$"])).toBe(
      "Prize: $10,000\nTeam size: 5",
    )
    expect(applyIgnore(text, [])).toBe(text)
  })
})

const PAGE = `<!doctype html>
<html><head><title>Demo Cup &amp; Prize — Rules</title>
<script>var tracking = "ignore me";</script><style>.x{color:red}</style></head>
<body>
  <header><nav><a href="/">Home</a><a href="/rules">Rules</a></nav></header>
  <main>
    <h1>Official   Rules</h1>
    <!-- internal note: change prize later -->
    <p>Prize pool:&nbsp;<b>$10&#x2C;000</b> USD</p>
    <ul><li>Open to 18+</li><li>Max team size: 5</li></ul>
    <table><tr><td>Deadline</td><td>31 Oct 2026</td></tr></table>
    <noscript>Enable JS</noscript>
    <button>Join</button>
  </main>
  <footer>© Synthetic Org</footer>
</body></html>`

describe("normalizeHtml", () => {
  it("keeps the terms and drops scripts, styles, nav, header, footer, comments and buttons", () => {
    expect(normalizeHtml(PAGE)).toBe(
      [
        "Official Rules",
        "Prize pool: $10,000 USD",
        "- Open to 18+",
        "- Max team size: 5",
        "Deadline",
        "31 Oct 2026",
      ].join("\n"),
    )
  })

  it("is stable under whitespace, attribute and script changes (same hash for the same terms)", () => {
    const noisy = PAGE.replace("<p>", '<p class="x"   data-ts="1728000000">')
      .replace('var tracking = "ignore me";', "var tracking = Math.random();")
      .replace(/\n/g, "\r\n   ")
    expect(normalizeHtml(noisy)).toBe(normalizeHtml(PAGE))
  })

  it("changes when a term changes", () => {
    expect(normalizeHtml(PAGE.replace("Max team size: 5", "Max team size: 4"))).not.toBe(
      normalizeHtml(PAGE),
    )
  })

  it("removes nested elements of a dropped type", () => {
    expect(normalizeHtml("<nav><nav>a</nav>b</nav><p>kept</p>")).toBe("kept")
  })
})

describe("helpers", () => {
  it("extracts and decodes the title", () => {
    expect(extractTitle(PAGE)).toBe("Demo Cup & Prize — Rules")
  })
  it("decodes named and numeric entities and leaves unknown ones", () => {
    expect(decodeEntities("&lt;a&gt; &#169; &#x20AC; &rsquo; &bogus;")).toBe("<a> © € ’ &bogus;")
  })
  it("normalizeText is idempotent and NFC-normalizes", () => {
    const t = "  Café \t rules \n\n\n second line  "
    const once = normalizeText(t)
    expect(once).toBe("Café rules\nsecond line")
    expect(normalizeText(once)).toBe(once)
  })
})
