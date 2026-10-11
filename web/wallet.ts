/**
 * Citing a snapshot from the browser with the visitor's own wallet (EIP-1193, e.g. MetaMask).
 *
 * Snapshots and diffs are created with the permissionlessExtension flag, so any wallet can extend
 * them. A citation is one atomic batch: create the citation entity, and extend the cited snapshot
 * (and the diffs that touch it) to CITED_DAYS from now. The citation's $creator is the visitor,
 * which the UI shows; it never makes the visitor's wallet "trusted".
 */
import { createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { custom, type EIP1193Provider } from "viem"
import type { DiffRecord, SnapshotRecord } from "../src/core/entities"
import { buildCitationCreate, buildCitedExtension } from "../src/core/entities"

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

export const hasWallet = () => typeof window !== "undefined" && !!window.ethereum

export async function citeWithWallet(snapshot: SnapshotRecord, diffs: DiffRecord[], note: string) {
  const provider = window.ethereum
  if (!provider) throw new Error("No browser wallet found (window.ethereum).")
  const [account] = (await provider.request({ method: "eth_requestAccounts" })) as `0x${string}`[]
  if (!account) throw new Error("The wallet returned no account.")
  const client = createWalletClient({ chain: tiramisu, transport: custom(provider), account })
  const chainId = await provider.request({ method: "eth_chainId" })
  if (Number(chainId) !== tiramisu.id) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${tiramisu.id.toString(16)}` }],
      })
    } catch {
      await client.addChain({ chain: tiramisu })
    }
  }
  const touching = diffs.filter((d) =>
    [d.fromSnapshot, d.toSnapshot].some((k) => k.toLowerCase() === snapshot.key.toLowerCase()),
  )
  return client.executeBatch({
    creates: [
      buildCitationCreate({
        urlHash: snapshot.urlHash,
        snapshotKey: snapshot.key,
        version: snapshot.version,
        contentHash: snapshot.contentHash,
        citedAt: Math.floor(Date.now() / 1000),
        note,
      }),
    ],
    extensions: [buildCitedExtension(snapshot.key), ...touching.map((d) => buildCitedExtension(d.key))],
  })
}
