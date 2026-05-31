export type NotePatchChangedLine = {
  start: number;
  end: number;
};

export type NotePatchConflict = {
  reason: "parse" | "stale" | "ambiguous";
  message: string;
  context?: string;
};

export type NotePatchResult =
  | {
      ok: true;
      markdown: string;
      changedLines: NotePatchChangedLine[];
      preview: string;
    }
  | {
      ok: false;
      error: NotePatchConflict;
    };

type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  oldLines: string[];
  newLines: string[];
};

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function applyUnifiedDiffToMarkdown(markdown: string, patch: string): NotePatchResult {
  const parseResult = parseUnifiedDiff(patch);
  if (!parseResult.ok) {
    return { ok: false, error: { reason: "parse", message: parseResult.message } };
  }

  let nextMarkdown = markdown;
  const changedLines: NotePatchChangedLine[] = [];

  for (const hunk of parseResult.hunks) {
    const lines = splitMarkdownLines(nextMarkdown);
    const matchIndexes = findHunkMatches(lines, hunk.oldLines);
    if (matchIndexes.length === 0) {
      return {
        ok: false,
        error: {
          reason: "stale",
          message: `Patch hunk starting at old line ${hunk.oldStart} does not match current note.`,
          context: formatNearbyLines(lines, hunk.oldStart),
        },
      };
    }
    if (matchIndexes.length > 1) {
      return {
        ok: false,
        error: {
          reason: "ambiguous",
          message: `Patch hunk starting at old line ${hunk.oldStart} matches multiple locations.`,
        },
      };
    }

    const startIndex = matchIndexes[0];
    const changedLine = summarizeChangedLines(startIndex, hunk.oldLines, hunk.newLines);
    lines.splice(startIndex, hunk.oldLines.length, ...hunk.newLines);
    nextMarkdown = lines.join("\n");
    changedLines.push(changedLine);
  }

  return { ok: true, markdown: nextMarkdown, changedLines, preview: formatChangedPreview(nextMarkdown, changedLines) };
}

function parseUnifiedDiff(patch: string): { ok: true; hunks: ParsedHunk[] } | { ok: false; message: string } {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunks: ParsedHunk[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (
      !line ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      index++;
      continue;
    }

    const headerMatch = line.match(hunkHeaderPattern);
    if (!headerMatch) {
      return { ok: false, message: `Unexpected patch line: ${line}` };
    }

    const oldStart = Number(headerMatch[1]);
    const oldCount = headerMatch[2] ? Number(headerMatch[2]) : 1;
    index++;

    const oldLines: string[] = [];
    const newLines: string[] = [];

    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const hunkLine = lines[index];
      if (hunkLine === "") {
        break;
      }
      const marker = hunkLine[0];
      const content = hunkLine.slice(1);
      if (marker === " ") {
        oldLines.push(content);
        newLines.push(content);
      } else if (marker === "-") {
        oldLines.push(content);
      } else if (marker === "+") {
        newLines.push(content);
      } else if (hunkLine === "\\ No newline at end of file") {
        // Ignore marker for this text-only implementation.
      } else {
        return { ok: false, message: `Invalid hunk line: ${hunkLine}` };
      }
      index++;
    }

    if (oldLines.length !== oldCount) {
      return {
        ok: false,
        message: `Hunk starting at old line ${oldStart} expected ${oldCount} old lines but contained ${oldLines.length}.`,
      };
    }

    hunks.push({ oldStart, oldCount, oldLines, newLines });
  }

  if (hunks.length === 0) {
    return { ok: false, message: "Patch contains no hunks." };
  }
  return { ok: true, hunks };
}

function splitMarkdownLines(markdown: string) {
  return markdown.split("\n");
}

function findHunkMatches(lines: string[], oldLines: string[]) {
  const matches: number[] = [];
  const maxStart = lines.length - oldLines.length;
  for (let start = 0; start <= maxStart; start++) {
    let matched = true;
    for (let offset = 0; offset < oldLines.length; offset++) {
      if (lines[start + offset] !== oldLines[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push(start);
    }
  }
  return matches;
}

function summarizeChangedLines(startIndex: number, oldLines: string[], newLines: string[]): NotePatchChangedLine {
  let prefixLength = 0;
  while (
    prefixLength < oldLines.length &&
    prefixLength < newLines.length &&
    oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength++;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldLines.length - prefixLength &&
    suffixLength < newLines.length - prefixLength &&
    oldLines[oldLines.length - 1 - suffixLength] === newLines[newLines.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }

  const changedNewLineCount = Math.max(1, newLines.length - prefixLength - suffixLength);
  const start = startIndex + prefixLength + 1;
  return { start, end: start + changedNewLineCount - 1 };
}

function formatChangedPreview(markdown: string, changedLines: NotePatchChangedLine[]) {
  const lines = splitMarkdownLines(markdown);
  const output: string[] = [];
  for (const changedLine of changedLines) {
    if (changedLines.length > 1) {
      output.push(`@@ ${changedLine.start}-${changedLine.end} @@`);
    }
    const start = Math.max(1, changedLine.start - 2);
    const end = Math.min(lines.length, changedLine.end + 2);
    for (let line = start; line <= end; line++) {
      output.push(`${line}: ${lines[line - 1]}`);
    }
  }
  return output.join("\n");
}

function formatNearbyLines(lines: string[], oneBasedLine: number) {
  const start = Math.max(1, oneBasedLine - 3);
  const end = Math.min(lines.length, oneBasedLine + 3);
  const output: string[] = [];
  for (let line = start; line <= end; line++) {
    output.push(`${line}: ${lines[line - 1]}`);
  }
  return output.join("\n");
}
