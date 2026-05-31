export type MarkdownRange = {
  offset: number;
  limit: number;
  totalLines: number;
  remaining: number;
  content: string;
};

export type MarkdownGrepMatch = {
  startLine: number;
  endLine: number;
  content: string;
};

export function formatMarkdownRange(markdown: string, startLine: number, endLine: number): MarkdownRange {
  const lines = markdown.split("\n");
  const totalLines = lines.length;
  const safeStartLine = Math.max(1, Math.floor(startLine || 1));
  const safeEndLine = Math.max(safeStartLine, Math.floor(endLine || safeStartLine));
  const start = Math.min(totalLines, safeStartLine) - 1;
  const end = Math.min(totalLines, safeEndLine);
  const slice = lines.slice(start, end);

  return {
    offset: start + 1,
    limit: slice.length,
    totalLines,
    remaining: totalLines - end,
    content: formatNumberedLines(slice, start + 1),
  };
}

export function formatMarkdownAround(markdown: string, line: number, context: number): MarkdownRange {
  const safeLine = Math.max(1, Math.floor(line || 1));
  const safeContext = Math.max(0, Math.floor(context || 0));
  return formatMarkdownRange(markdown, safeLine - safeContext, safeLine + safeContext);
}

export function grepMarkdown(
  markdown: string,
  query: string,
  context = 2,
  maxMatches = 20,
): { matches: MarkdownGrepMatch[]; totalLines: number; truncated: boolean } {
  const lines = markdown.split("\n");
  const needle = query.toLowerCase();
  const safeContext = Math.max(0, Math.floor(context || 0));
  const safeMaxMatches = Math.max(1, Math.floor(maxMatches || 20));
  const matches: MarkdownGrepMatch[] = [];
  let truncated = false;

  if (!needle) {
    return { matches, totalLines: lines.length, truncated };
  }

  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].toLowerCase().includes(needle)) {
      continue;
    }
    const startLine = Math.max(1, index + 1 - safeContext);
    const endLine = Math.min(lines.length, index + 1 + safeContext);
    const slice = lines.slice(startLine - 1, endLine);
    matches.push({
      startLine,
      endLine,
      content: formatNumberedLines(slice, startLine),
    });
    if (matches.length >= safeMaxMatches) {
      truncated = lines.slice(index + 1).some((line) => line.toLowerCase().includes(needle));
      break;
    }
  }

  return { matches, totalLines: lines.length, truncated };
}

function formatNumberedLines(lines: string[], startLine: number) {
  return lines.map((line, index) => `${startLine + index}: ${line}`).join("\n");
}
