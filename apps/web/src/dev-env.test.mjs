import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const viteConfigSource = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

test('vite derives browser API origins from the API PORT override', () => {
  assert.match(viteConfigSource, /process\.env\.VITE_DOCUMINE_API_HTTP_ORIGIN \|\| process\.env\.DOCUMINE_API_HTTP_ORIGIN \|\| \(apiPort \? `http:\/\/localhost:\$\{apiPort\}` : ''\)/);
  assert.match(viteConfigSource, /process\.env\.VITE_DOCUMINE_API_WS_ORIGIN \|\| process\.env\.DOCUMINE_API_WS_ORIGIN \|\| \(apiPort \? `ws:\/\/localhost:\$\{apiPort\}` : ''\)/);
});
