/**
 * Sets up a second, independent testnet wallet for citing snapshots, so a citation's $creator is
 * visibly not the snapshotter. Creates `.env.citer` (git-ignored) with a fresh key if it is missing,
 * then sends it a small amount of Tiramisu GLM from the snapshotter wallet in `.env.local`.
 * Testnet only. Neither key is ever printed.
 *
 *   npx tsx scripts/second-wallet.ts [amountGlm=0.2]
 *
 * Then cite from it:
 *   FPL_ENV_FILE=.env.citer npm run snap -- cite <snapshotKey> --note "<text>"
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { formatEther, type Hex, http, parseEther } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { httpClient } from "../src/core/client"
import { explorerAddressUrl, explorerTxUrl, TIRAMISU } from "../src/core/config"

const CITER_FILE = ".env.citer"
const amount = parseEther(process.argv[2] ?? "0.2")

const readKey = (file: string): Hex => {
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith("ARKIV_PRIVATE_KEY="))
  const pk = line?.slice("ARKIV_PRIVATE_KEY=".length).trim().replace(/^["']|["']$/g, "")
  if (!pk) throw new Error(`ARKIV_PRIVATE_KEY missing in ${file}`)
  return (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex
}

if (!existsSync(CITER_FILE)) {
  writeFileSync(CITER_FILE, `ARKIV_PRIVATE_KEY=${generatePrivateKey()}\n`, { mode: 0o600 })
  console.log(`created ${CITER_FILE} (git-ignored)`)
}
const citer = privateKeyToAccount(readKey(CITER_FILE))
const funder = privateKeyToAccount(readKey(".env.local"))
if (citer.address.toLowerCase() === funder.address.toLowerCase()) throw new Error("citer key equals snapshotter key")

process.loadEnvFile(".env.local") // ARKIV_ACCESS_KEY for reads
delete process.env.ARKIV_PRIVATE_KEY
const client = httpClient()
const before = await client.getBalance({ address: citer.address })
console.log(`citer   ${citer.address}  balance ${formatEther(before)} GLM  ${explorerAddressUrl(citer.address)}`)
console.log(`funder  ${funder.address}`)
if (before >= amount) {
  console.log("citer already funded; nothing sent")
} else {
  const key = process.env.ARKIV_ACCESS_KEY?.trim()
  const transport = key ? http(TIRAMISU.http, { fetchOptions: { headers: { "X-API-KEY": key } } }) : http(TIRAMISU.http)
  const w = createWalletClient({ chain: tiramisu, transport, account: funder })
  const hash = await w.sendTransaction({ to: citer.address, value: amount - before })
  const receipt = await client.waitForTransactionReceipt({ hash })
  console.log(`funded  tx ${hash} ${receipt.status}  ${explorerTxUrl(hash)}`)
}
