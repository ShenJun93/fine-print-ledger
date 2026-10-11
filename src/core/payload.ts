/**
 * Snapshot payload encoding. Normalized text is stored as `text/plain` UTF-8. Text larger than
 * GZIP_THRESHOLD_BYTES is gzip-compressed and stored as `application/gzip`, because the engine caps
 * a payload at 128 KiB (MAX_PAYLOAD_BYTES).
 *
 * The SDK 0.8.1 has brotli helpers internally (src/utils/compression.ts) but does not export them
 * or apply them on write, so we use the standard CompressionStream API, which Node >= 18 and every
 * current browser implement. That keeps decoding possible in the browser with no extra library.
 */
import { GZIP_THRESHOLD_BYTES } from "./config"

export type EncodedPayload = {
  payload: Uint8Array
  contentType: "text/plain" | "application/gzip"
}

async function pipe(bytes: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as TransformStream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream("gzip"))
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream("gzip"))
}

export async function encodeText(
  text: string,
  threshold: number = GZIP_THRESHOLD_BYTES,
): Promise<EncodedPayload> {
  const raw = new TextEncoder().encode(text)
  if (raw.length <= threshold) return { payload: raw, contentType: "text/plain" }
  return { payload: await gzip(raw), contentType: "application/gzip" }
}

export async function decodeText(payload: Uint8Array, contentType: string | undefined): Promise<string> {
  const bytes = contentType === "application/gzip" ? await gunzip(payload) : payload
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}
