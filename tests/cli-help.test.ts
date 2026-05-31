import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

test("CLI help advertises only bounded reads and unified diff edits", () => {
  const result = spawnSync(process.execPath, ["cli/documine.mjs", "--help"], { encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /read <id> --range=A:B/);
  assert.match(result.stdout, /read <id> --around=L/);
  assert.match(result.stdout, /apply <id> --patch file/);
  assert.match(result.stdout, /read --range=A:B/);
  assert.match(result.stdout, /grep <query>/);
  assert.doesNotMatch(result.stdout, /--full --force/);
  assert.doesNotMatch(result.stdout, /Legacy JSON edits/);
  assert.doesNotMatch(result.stdout, /edit <id> '<edits>'/);
});

test("CLI source contains no legacy edit command or full-output fallback", () => {
  const source = fs.readFileSync("cli/documine.mjs", "utf8");

  assert.doesNotMatch(source, /case \"edit\"/);
  assert.doesNotMatch(source, /--full --force/);
  assert.doesNotMatch(source, /console\.log\(note\.markdown\)/);
});
