import assert from "node:assert/strict";
import test from "node:test";

import { applyUnifiedDiffToMarkdown } from "../src/lib/note-patch.js";

test("applies a unified diff hunk when context matches one location", () => {
  const markdown = ["alpha", "beta", "gamma", "delta"].join("\n");
  const patch = [
    "--- note.md",
    "+++ note.md",
    "@@ -1,4 +1,4 @@",
    " alpha",
    "-beta",
    "+BETTER",
    " gamma",
    " delta",
    "",
  ].join("\n");

  const result = applyUnifiedDiffToMarkdown(markdown, patch);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.markdown, ["alpha", "BETTER", "gamma", "delta"].join("\n"));
  assert.deepEqual(result.changedLines, [{ start: 2, end: 2 }]);
});

test("returns a bounded changed preview after applying a unified diff", () => {
  const markdown = ["one", "two", "three", "four", "five"].join("\n");
  const patch = [
    "--- note.md",
    "+++ note.md",
    "@@ -1,5 +1,5 @@",
    " one",
    " two",
    "-three",
    "+THREE",
    " four",
    " five",
    "",
  ].join("\n");

  const result = applyUnifiedDiffToMarkdown(markdown, patch);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.preview, ["1: one", "2: two", "3: THREE", "4: four", "5: five"].join("\n"));
});

test("rejects a stale unified diff without changing markdown", () => {
  const markdown = ["alpha", "changed", "gamma"].join("\n");
  const patch = [
    "--- note.md",
    "+++ note.md",
    "@@ -1,3 +1,3 @@",
    " alpha",
    "-beta",
    "+BETTER",
    " gamma",
    "",
  ].join("\n");

  const result = applyUnifiedDiffToMarkdown(markdown, patch);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.reason, "stale");
  assert.match(result.error.context || "", /2: changed/);
});

test("rejects an ambiguous unified diff without changing markdown", () => {
  const markdown = ["alpha", "beta", "gamma", "alpha", "beta", "gamma"].join("\n");
  const patch = [
    "--- note.md",
    "+++ note.md",
    "@@ -1,3 +1,3 @@",
    " alpha",
    "-beta",
    "+BETTER",
    " gamma",
    "",
  ].join("\n");

  const result = applyUnifiedDiffToMarkdown(markdown, patch);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.reason, "ambiguous");
});

test("rejects malformed unified diff content", () => {
  const result = applyUnifiedDiffToMarkdown("alpha\nbeta", "not a patch");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.reason, "parse");
  assert.match(result.error.message, /Unexpected patch line/);
});
