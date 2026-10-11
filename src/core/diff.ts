import { createTwoFilesPatch, diffLines, parsePatch } from "diff"

export type DiffStats = { addedLines: number; removedLines: number }

export type TextDiff = DiffStats & {
  /** Unified diff text (the diff entity's payload). */
  unified: string
}

function lineCount(value: string): number {
  if (value.length === 0) return 0
  const n = value.split("\n").length
  return value.endsWith("\n") ? n - 1 : n
}

function withNewline(text: string): string {
  return text.length === 0 || text.endsWith("\n") ? text : `${text}\n`
}

/** Counts added/removed lines between two normalized texts. */
export function diffStats(oldText: string, newText: string): DiffStats {
  let addedLines = 0
  let removedLines = 0
  for (const part of diffLines(withNewline(oldText), withNewline(newText))) {
    if (part.added) addedLines += lineCount(part.value)
    else if (part.removed) removedLines += lineCount(part.value)
  }
  return { addedLines, removedLines }
}

/**
 * The unified diff between two snapshot versions, with 2 lines of context.
 * Headers name the versions and their fetch times so the diff is readable on its own.
 */
export function makeDiff(
  oldText: string,
  newText: string,
  meta: { fromVersion: number; toVersion: number; fromFetchedAt: number; toFetchedAt: number },
): TextDiff {
  const unified = createTwoFilesPatch(
    `v${meta.fromVersion}`,
    `v${meta.toVersion}`,
    withNewline(oldText),
    withNewline(newText),
    new Date(meta.fromFetchedAt * 1000).toISOString(),
    new Date(meta.toFetchedAt * 1000).toISOString(),
    { context: 2 },
  )
  return { unified, ...diffStats(oldText, newText) }
}

export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string }

/** Parses a unified diff payload into display lines (used by the web diff viewer). */
export function parseUnified(unified: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const file of parsePatch(unified)) {
    for (const hunk of file.hunks) {
      out.push({
        kind: "hunk",
        text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      })
      for (const line of hunk.lines) {
        if (line.startsWith("\\")) continue
        const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx"
        out.push({ kind, text: line.slice(1) })
      }
    }
  }
  return out
}
