import { describe, expect, it } from "vitest"
import { rateLimitedFor } from "../src/core/client"

describe("rateLimitedFor", () => {
  it("finds a 429 deep in the cause chain and reads Retry-After", () => {
    const http = { status: 429, headers: new Headers({ "retry-after": "2336" }) }
    const e = { message: "outer", cause: { message: "mid", cause: http } }
    expect(rateLimitedFor(e)).toBe(2336)
  })

  it("recognises ANON_COST_LIMITED in details without a status", () => {
    expect(rateLimitedFor({ details: '{"error":"ANON_COST_LIMITED"}' })).toBe(0)
  })

  it("returns undefined for other errors", () => {
    expect(rateLimitedFor(new Error("boom"))).toBeUndefined()
    expect(rateLimitedFor({ status: 500 })).toBeUndefined()
  })
})
