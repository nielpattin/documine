import assert from "node:assert/strict";
import test from "node:test";

import { formatMarkdownAround, formatMarkdownRange, grepMarkdown } from "../src/lib/note-ranges.js";

test("formats a bounded markdown line range with total line count", () => {
  const result = formatMarkdownRange(["one", "two", "three", "four"].join("\n"), 2, 3);

  assert.equal(result.offset, 2);
  assert.equal(result.limit, 2);
  assert.equal(result.totalLines, 4);
  assert.equal(result.remaining, 1);
  assert.equal(result.content, ["2: two", "3: three"].join("\n"));
});

test("formats a bounded markdown line window around a line", () => {
  const result = formatMarkdownAround(["one", "two", "three", "four", "five"].join("\n"), 3, 1);

  assert.equal(result.offset, 2);
  assert.equal(result.limit, 3);
  assert.equal(result.totalLines, 5);
  assert.equal(result.content, ["2: two", "3: three", "4: four"].join("\n"));
});

test("grep returns bounded matching regions with context", () => {
  const result = grepMarkdown(["alpha", "beta", "gamma", "delta", "beta again"].join("\n"), "beta", 1);

  assert.deepEqual(result.matches, [
    {
      startLine: 1,
      endLine: 3,
      content: ["1: alpha", "2: beta", "3: gamma"].join("\n"),
    },
    {
      startLine: 4,
      endLine: 5,
      content: ["4: delta", "5: beta again"].join("\n"),
    },
  ]);
});

test("grep limits the number of returned matches", () => {
  const result = grepMarkdown(["beta one", "x", "beta two", "x", "beta three"].join("\n"), "beta", 0, 2);

  assert.equal(result.matches.length, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.matches.map((match) => match.startLine),
    [1, 3],
  );
});
