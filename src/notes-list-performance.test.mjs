import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

test('note list snippets avoid normalizing entire large notes for default list load', () => {
  assert.match(serverSource, /const NOTE_LIST_SNIPPET_SOURCE_LIMIT = \d+;/);
  assert.match(serverSource, /note\.markdown\.slice\(0, NOTE_LIST_SNIPPET_SOURCE_LIMIT\)/);
  assert.doesNotMatch(serverSource, /const source = note\.markdown\.replace\(\/\\s\+\/g, ' '\)\.trim\(\);/);
});
