import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const viteConfigSource = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

test('vite dev and preview proxy API asset routes to the API server', () => {
  assert.match(viteConfigSource, /const apiProxy = \{/);
  assert.match(viteConfigSource, /'\/assets': apiOrigin/);
  assert.match(viteConfigSource, /server: \{[\s\S]*proxy: apiProxy/);
  assert.match(viteConfigSource, /preview: \{[\s\S]*proxy: apiProxy/);
});
