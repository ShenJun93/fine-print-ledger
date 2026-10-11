# Friction report: building Fine Print Ledger on Arkiv

Only things we hit or tested ourselves. Each entry has the surface, expected vs actual, versions and a
repro. Entries marked **worked** document tested paths that behaved as expected.

Environment for every entry unless noted: `@arkiv-network/sdk` 0.8.1, `viem` 2.57.4, Node 24.20.0,
Windows 11, Tiramisu testnet (chain 7738577), 2026-10-11.

---

## 1. Uppercase letters in attribute names pass the SDK but revert on chain (and the error says they are allowed)

- **Surface:** TypeScript SDK (`createEntity` / `executeBatch`, attribute-name validation, revert decoding) and the
  Tiramisu engine. This one blocked every write we had.
- **Versions:** `@arkiv-network/sdk` 0.8.1, `viem` 2.57.4, Node 24.20.0, Tiramisu (chain 7738577), block ~416,093,
  2026-10-11, from the funded snapshotter `0x517bf78c3000991FFbCdf06305F3881382437e98`.
- **Expected:** a camelCase attribute name such as `checkedAt` is either written, or rejected before sending with a message
  that says names must be lowercase. The SDK says it is valid: `isValidAttributeName("checkedAt") === true`; the grammar in
  `src/attr/names.ts` is `/^[A-Za-z][A-Za-z0-9._-]*$/`.
- **Actual:** the engine reverts. The SDK decodes the engine's `Ident32InvalidByte(position, value)` and words it with its
  own charset string (`src/utils/revert.ts`, `CHARSET`), which lists `"A"-"Z"` as allowed, so the message contradicts itself:
  `Transaction failed: an attribute name holds "A" (0x41) at byte 7, which is outside the name charset ("A"-"Z", "a"-"z",
  "0"-"9", ".", "-" and "_", with a letter first) <- execution reverted`.
  Our first real `seed` failed this way for all 5 pages (`"C" (0x43) at byte 4`, i.e. `lastCheckedAt`).
- **Minimal repro** ([`scripts/repro-uppercase-attr.ts`](../scripts/repro-uppercase-attr.ts), `npx tsx scripts/repro-uppercase-attr.ts`):
  one `createEntity` with `{ repro: "fpl-attr-case", checkedAt: u64(1) }`, then the same with `checked_at`.
  ```
  attribute "checkedAt": SDK isValidAttributeName -> true
    FAIL Transaction failed: an attribute name holds "A" (0x41) at byte 7, which is outside the name charset (...) <- execution reverted
  attribute "checked_at": SDK isValidAttributeName -> true
    OK   tx 0x14cc44dc68519f55461d2ce64776edf3f7488e6bfb5844bbeb92d29ad045c508  entity 0x96a79f3821fbd0b380d673bd34c56e628f4b2de87601562f0406d078301567ec
  ```
  The failing call returned no transaction hash (it reverted during gas estimation), so it cost nothing.
- **Fix (either):** make the engine accept `A`-`Z` as the SDK grammar and the message say; or make the SDK grammar
  `/^[a-z][a-z0-9._-]*$/`, so `createEntity` throws `InvalidAttributeNameError` before sending, fix `CHARSET` in
  `revert.ts`, and say "lowercase only" in the docs. The README example names (`category`, `version`, `score`) are all
  lowercase, which hides the problem.
- **What we did:** renamed every attribute to lowercase snake_case (`url_hash`, `fetched_at`, `content_hash`, …) and added a
  unit test that fails if any attribute the app writes or queries contains a non-lowercase character
  ([`test/entities-plan-queries.test.ts`](../test/entities-plan-queries.test.ts), "attribute names").

## 2. `$createdAt` cannot be range-filtered through the SDK, but the node accepts it

- **Surface:** TypeScript SDK (query builder) vs Direct JSON-RPC; challenge docs.
- **Expected:** the challenge `AGENTS.md` says "There is no server-side ordering (no `orderBy`); sort on the client,
  or range-filter on `$createdAt`." So `gte("$createdAt", u64(n))` should work.
- **Actual:** the SDK throws before sending anything:
  `InvalidPredicateError: "$createdAt" is returned in query results but carries no index, so it cannot be filtered on.`
  (`src/query/expression.ts`, `RESULT_ONLY_SYSTEM_ATTRIBUTES`). The node, however, accepts the same predicate over
  raw JSON-RPC and appears to filter by it: `$createdAt >= u64(1)` returned 5 rows (limit 5),
  `$createdAt >= u64(99999999)` returned 0, `$createdAt <= u64(10)` returned 0.
- **Repro:**
  ```ts
  import { u64 } from "@arkiv-network/sdk"; import { gte } from "@arkiv-network/sdk/query"
  gte("$createdAt", u64(1)) // throws InvalidPredicateError
  ```
  ```sh
  curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["$createdAt >= u64(1)",{"select":{"key":true},"limit":"0x5"}]}'
  ```
- **Fix:** decide which is true. If the node indexes `$createdAt`, add it to `QUERYABLE_SYSTEM_ATTRIBUTES` (typed `u64`,
  a block number). If it does not (and the result above is a scan or an accident), reject it on the node and fix the
  challenge docs.
- **What we did:** store our own `fetched_at` (u64 unix seconds) and range-filter on that. We would have done this anyway,
  because "when the page was fetched" is the fact we need, not "when the block landed".

## 3. An unfunded wallet surfaces as "Execution error without revert data"

- **Surface:** TypeScript SDK (`createEntity` / `executeBatch`), error reporting.
- **Expected:** an error that says the account has no GLM for gas.
- **Actual:** `EntityMutationError: Transaction failed: Execution error without revert data`. The real reason is five
  `cause`s deep: `ContractFunctionExecutionError → TransactionExecutionError → EstimateGasExecutionError →
  TransactionRejectedRpcError → RpcRequestError`, each with `details: "out of gas: gas required exceeds: 0"`
  (which is itself the node's way of saying "balance 0").
- **Repro:**
  ```ts
  import { createWalletClient, ExpirationTime } from "@arkiv-network/sdk"
  import { tiramisu } from "@arkiv-network/sdk/chains"
  import { http } from "viem"; import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
  const w = createWalletClient({ chain: tiramisu, transport: http(), account: privateKeyToAccount(generatePrivateKey()) })
  await w.createEntity({ payload: new Uint8Array([104]), contentType: "text/plain", expires: ExpirationTime.fromDays(1) })
  ```
- **Fix:** in `sendArkivTransaction`, append the innermost `details` to the message (the `ContractFunctionExecutionError`
  branch currently replaces it with "Execution error without revert data"), or check the balance when gas estimation
  fails and say "account has 0 GLM, use the faucet".
- **What we did:** the CLI checks the balance before any write and prints the full cause chain
  ([`rootCause`, `requireFunds` in `src/cli/snapshotter.ts`](../src/cli/snapshotter.ts)).

## 4. Query syntax errors come back as JSON-RPC code -32003, which viem calls "Transaction creation failed"

- **Surface:** Direct JSON-RPC (`arkiv_query`) through viem's `client.request`.
- **Expected:** a query parse error reported as invalid params (-32602) or a dedicated query error code.
- **Actual:** the node answers
  `{"error":{"code":-32003,"message":"i32 expects decimal digits","data":{"message":"i32 expects decimal digits","position":14}}}`.
  -32003 is EIP-1474 "transaction rejected", so viem wraps it as `TransactionRejectedRpcError` with
  `shortMessage: "Transaction creation failed."` for what is a read-only query. The useful text is only in `details`.
- **Repro:**
  ```sh
  curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["version = i32(0xcab003fe282d)",{"select":{"key":true}}]}'
  ```
  then the same params through `httpClient().request({ method: "arkiv_query", params: [...] })` and print `e.shortMessage`.
- **Fix:** use a non-transaction error code for query errors on the node. The SDK builder cannot produce this query (its
  `i32()` validates), so this only bites people who paste queries, which is exactly what our "verify it yourself" panel
  invites them to do.

## 5. `contentType` with a charset parameter is rejected

- **Surface:** TypeScript SDK (`createEntity`).
- **Expected:** `text/plain; charset=utf-8` accepted. The error message itself cites RFC 2045, whose grammar allows parameters.
- **Actual:** `InvalidContentTypeError: Invalid content type "text/plain; charset=utf-8". Must follow RFC 2045 MIME grammar
  and be lowercase only (e.g. "text/plain").` The check is `MIME_REGEX` in `src/utils/arkivTransactions.ts`
  (`type/subtype` only). It fires before any network write, so it costs nothing, but it means a reader cannot learn the
  payload's encoding from the entity.
- **Repro:** the snippet from entry 3 with `contentType: "text/plain; charset=utf-8"` (fails before gas estimation).
- **Fix:** allow `; key=value` parameters, or say in the error that parameters are not supported.
- **What we did:** document "payloads are UTF-8" in `arkiv/schema.md`.

## 6. Payload compression exists in the SDK but is not reachable

- **Surface:** TypeScript SDK (payloads, 128 KiB limit).
- **Expected:** with a 128 KiB payload cap (`MAX_PAYLOAD_BYTES`), a public helper to compress and decompress payloads.
- **Actual:** `src/utils/compression.ts` implements brotli `compress`/`decompress` (zlib in Node, `brotli-wasm` in browsers)
  and `brotli-wasm` is a runtime dependency, but nothing exports these functions (`@arkiv-network/sdk/utils` exports
  only expiration and payload helpers) and no write path calls them. `grep -rn compress src --include=*.ts` in the
  package finds only the file itself and its test.
- **Fix:** export `compress`/`decompress` from `@arkiv-network/sdk/utils` (and pick a content type for it), or drop the
  dependency.
- **What we did:** gzip via the standard `CompressionStream` above 96 KiB, stored as `application/gzip`
  ([`src/core/payload.ts`](../src/core/payload.ts)), so the browser can decode it without a library. None of our five
  seed pages needed it (largest normalized text: 9.4 KB).

## 7. A bare number in a query is `i32`, so it must match how you wrote the attribute

- **Surface:** TypeScript SDK (attributes and query builder).
- **Expected:** this is documented (`toValue`: number → `i32`), but it is easy to miss when the attribute was written as
  `u64` (needed for unix timestamps past 2038 and for consistency).
- **Actual:** `eq("version", 3).toString()` is `version = i32(3)`, while `eq("version", u64(3)).toString()` is
  `version = u64(3)`. Not yet verified on chain whether an `i32` literal matches a `u64` value; we will add the result
  here once the snapshotter has written entities.
- **What we did:** every numeric attribute and every numeric literal in queries goes through `u64()`
  ([`rangeFilter` in `src/core/queries.ts`](../src/core/queries.ts)), and a unit test pins the rendered strings.

## 8. `ExpiryExtended` does not say who extended

- **Surface:** WebSocket entity events (`watchEntityEvents`), creation flags.
- **Expected:** for entities created with `permissionlessExtension`, the event identifies the extender, since that is the
  whole point of the flag (the community keeps evidence alive).
- **Actual:** the event carries `owner`, documented in `src/types/events.ts` as "**not** whoever extended it … read the
  transaction's sender if you need that". Not a bug, but it means one extra `getTransaction` per event to credit the person
  who kept evidence alive.
- **What we did:** the live feed shows "lifetime extended" with the transaction link; the citation entity (created in the same
  batch as the extension) carries the citer as its `$creator`, which is what we display.

## 9. Explorer link formats are not documented

- **Surface:** Block Explorer (`tiramisu.explorer.arkiv.network`).
- **Expected:** documented deep-link formats for an entity, a transaction and an address.
- **Actual:** not found in the docs we read; we read the routes `/entity/`, `/tx/`, `/address/` out of the explorer's JS bundle.
- **Fix:** list them in the Tiramisu network page of the docs.

---

## Tested paths that worked

| Surface | What we tested | Expected | Result |
|---|---|---|---|
| Direct JSON-RPC from the browser | `arkiv_query` via `fetch` from `http://localhost` (Vite preview) | CORS allowed | Worked; the app has no backend. |
| WebSocket events | `watchEntityEvents` with `webSocket(wss://…)`, no `fromBlock`, in Chrome | a real subscription, no HTTP polling | Over 8 s, 21 entity events arrived (other apps' traffic) while the page made 0 additional HTTP requests (checked with `performance.getEntriesByType("resource")`). |
| `predictEntityKeys` | called with an unfunded owner, `count: 2` | works read-only (it reads `entityNonce` via `eth_call`) | Worked, so `--dry-run` shows the exact keys the batch would create. |
| `getBlockTiming` | used to turn `expiresAt` (a block) into a date | `currentBlock`, `currentBlockTime`, `blockDuration` | Worked; `blockDuration` 2 s. |
| `ExpirationTime` | `fromSeconds(3)` | rejected with a clear message | "a lifetime must be a multiple of the 2s block time, got 3 … Try 2 or 4". Clear. |
| Typed `select()` | `client.select({...} as const)` with TypeScript 7.0.2 | result narrowed to the selected fields | Worked, including `toText`/`toJson` only when `payload` is selected. |
| Query builder `toString()` | compared with what we display | identical to what is sent | Worked; a unit test asserts `builder.toString() === queryText(spec)`. |

Still to test once the snapshotter wallet is funded (results will be added here, not assumed): batch writes with
predicted keys landing as predicted, `readonly` + `permissionlessExtension` flags read back, Lifetime Extension by a second
wallet, cursor pagination over more than 50 rows, and the `i32` vs `u64` match from entry 7.
