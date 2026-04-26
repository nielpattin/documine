import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('owner note page updates browser tab title from editable note title', () => {
  assert.match(appSource, /useDocumentTitle\(title\s*\|\|\s*'Untitled'\)/);
});

test('shared note page updates browser tab title from shared note title', () => {
  assert.match(appSource, /useDocumentTitle\(payload\?\.note\.title\s*\|\|\s*'Untitled'\)/);
});
