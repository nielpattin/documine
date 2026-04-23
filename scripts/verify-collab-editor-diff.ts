import assert from 'node:assert/strict';
import { diffTextChange } from '../apps/web/src/lib/collab-editor';

function expectDiff(previousText: string, nextText: string, expected: { prefix: number; previousEnd: number; nextEnd: number; insertedText: string }) {
  assert.deepEqual(diffTextChange(previousText, nextText), expected);
}

expectDiff('alpha\nbeta\ngamma', 'alpha\nbetX\ngamma', {
  prefix: 9,
  previousEnd: 10,
  nextEnd: 10,
  insertedText: 'X',
});

expectDiff('first line\nsecond line\nthird line', 'first line\nsecond Xline\nthird line', {
  prefix: 18,
  previousEnd: 18,
  nextEnd: 19,
  insertedText: 'X',
});

expectDiff('hello world', 'hello worl', {
  prefix: 10,
  previousEnd: 11,
  nextEnd: 10,
  insertedText: '',
});

expectDiff('one\ntwo\nthree', 'one\nTWO\nthree', {
  prefix: 4,
  previousEnd: 7,
  nextEnd: 7,
  insertedText: 'TWO',
});

console.log('verify-collab-editor-diff: ok');
