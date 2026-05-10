import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('markdown preview rendering is gated by visible preview panel', () => {
  assert.match(appSource, /if \(!payload \|\| !showPreview \|\| previewMode !== 'markdown'\) \{/);
  assert.match(appSource, /\}, \[markdown, payload, previewMode, showPreview\]\);/);
  assert.match(appSource, /\}, \[markdown, payload, previewMode, shareId, showPreview\]\);/);
});

test('rendered PDF refresh is gated by visible preview panel', () => {
  assert.match(appSource, /if \(!showPreview \|\| previewMode !== 'rendered-pdf'\) \{/);
  assert.match(appSource, /\}, \[markdown, noteId, previewMode, renderedPdfDirty, showPreview\]\);/);
  assert.match(appSource, /\}, \[markdown, previewMode, renderedPdfDirty, shareId, showPreview\]\);/);
});
