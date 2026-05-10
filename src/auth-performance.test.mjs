import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

test('owner token verification uses cached auth data and reverse scan', () => {
  assert.match(serverSource, /const authDataCache = \{ value: null as AuthData \| null, mtimeMs: -1 \};/);
  assert.match(serverSource, /for \(let index = auth\.tokens\.length - 1; index >= 0; index--\)/);
  assert.match(serverSource, /verifiedOwnerTokenCache\.set\(token, Date\.now\(\) \+ authTokenVerificationCacheMs\);/);
});

test('note serialization reuses one viewer context per request', () => {
  assert.match(serverSource, /function getViewerContext\(/);
  assert.match(serverSource, /const viewerContext = getViewerContext\(c\);/);
  assert.match(serverSource, /threads: serializeThreads\(note, c, viewerContext\),/);
});

test('api key verification scans newest first', () => {
  assert.match(serverSource, /for \(let index = auth\.apiKeys\.length - 1; index >= 0; index--\)/);
});
