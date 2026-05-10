import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('rendered PDF refresh effects do not restart when the preview URL changes', () => {
  assert.match(appSource, /\}, \[markdown, noteId, previewMode, renderedPdfDirty, showPreview\]\);/);
  assert.match(appSource, /\}, \[markdown, previewMode, renderedPdfDirty, shareId, showPreview\]\);/);
  assert.doesNotMatch(appSource, /\}, \[markdown, noteId, previewMode, renderedPdfDirty, renderedPdfUrl\]\);/);
  assert.doesNotMatch(appSource, /\}, \[markdown, previewMode, renderedPdfDirty, renderedPdfUrl, shareId\]\);/);
});
