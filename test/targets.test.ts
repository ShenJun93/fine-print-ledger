import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { applyIgnore } from "../src/core/normalize"

type Target = { url: string; ignore?: string[] }
const targets = JSON.parse(readFileSync(new URL("../targets.json", import.meta.url), "utf8")) as Target[]

describe("Devpost announcement stability", () => {
  const pages = targets.filter((target) => target.url.includes("devpost.com") && target.url.endsWith("/updates"))

  it("ignores rolling relative timestamps, but never ignores deadline or prize content", () => {
    expect(pages).toHaveLength(4)
    for (const page of pages) {
      const input = ["5 days ago", "1 day ago", "24 hours ago", "a day ago", "Deadline: Oct 26, 2026", "Prize: $1,000"].join("\n")
      expect(applyIgnore(input, page.ignore)).toBe("Deadline: Oct 26, 2026\nPrize: $1,000")
    }
  })

  it("does not suppress actual organiser announcements", () => {
    for (const page of pages) {
      expect(applyIgnore("2 days ago\nNew judging deadline: 31 Oct\nUpdated eligibility for Vietnam", page.ignore)).toBe(
        "New judging deadline: 31 Oct\nUpdated eligibility for Vietnam",
      )
    }
  })
})
