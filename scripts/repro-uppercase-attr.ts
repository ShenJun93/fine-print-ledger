/**
 * Minimal repro for arkiv/friction.md #1: the SDK accepts an attribute name with an uppercase
 * letter, the Tiramisu engine reverts it.
 *
 *   npx tsx scripts/repro-uppercase-attr.ts
 *
 * Needs ARKIV_PRIVATE_KEY (read from .env.local, never printed) for a funded Tiramisu wallet.
 * Writes at most two tiny entities that expire after one hour.
 */
import { existsSync } from "node:fs"
import { createWalletClient, ExpirationTime, isValidAttributeName, u64 } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"

if (existsSync(".env.local")) process.loadEnvFile(".env.local")
const pk = process.env.ARKIV_PRIVATE_KEY?.trim()
if (!pk) throw new Error("ARKIV_PRIVATE_KEY not set")
const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex)
const client = createWalletClient({ chain: tiramisu, transport: http(), account })

function causes(e: unknown): string {
  const out: string[] = []
  let c: unknown = e
  for (let i = 0; c && i < 8; i++) {
    const x = c as { message?: string; details?: string; cause?: unknown }
    if (i === 0 && x.message) out.push(x.message.split("\n")[0]!)
    if (x.details && !out.includes(x.details)) out.push(x.details)
    c = x.cause
  }
  return out.join(" <- ")
}

console.log(`sdk 0.8.1, chain ${await client.getChainId()}, block ${await client.getBlockNumber()}, from ${account.address}`)
for (const name of ["checkedAt", "checked_at"]) {
  console.log(`\nattribute "${name}": SDK isValidAttributeName -> ${isValidAttributeName(name)}`)
  try {
    const r = await client.createEntity({
      attributes: { repro: "fpl-attr-case", [name]: u64(1) },
      payload: new TextEncoder().encode("attribute-name case repro"),
      contentType: "text/plain",
      expires: ExpirationTime.fromHours(1),
    })
    console.log(`  OK   tx ${r.txHash}  entity ${r.entityKey}`)
  } catch (e) {
    const err = e as { txHash?: string }
    console.log(`  FAIL ${causes(e)}${err.txHash ? `  tx ${err.txHash}` : ""}`)
  }
}
