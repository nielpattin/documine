import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const viteConfigSource = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

test('vite dev and preview proxy uploaded note assets without intercepting bundles', () => {
  assert.match(viteConfigSource, /function isUploadedAssetPath\(/);
  assert.match(viteConfigSource, /function installUploadedAssetProxyMiddleware\(/);
  assert.match(viteConfigSource, /configureServer\(server\) \{[\s\S]*installUploadedAssetProxyMiddleware\(server\)/);
  assert.match(viteConfigSource, /configurePreviewServer\(server\) \{[\s\S]*installUploadedAssetProxyMiddleware\(server\)/);
  assert.doesNotMatch(viteConfigSource, /'\/assets': apiOrigin/);
});
