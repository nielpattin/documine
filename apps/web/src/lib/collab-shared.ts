export type ElementId = {
  bunchId: string;
  counter: number;
};

export type SavedIdListItem = {
  bunchId: string;
  startCounter: number;
  count: number;
  isDeleted?: boolean;
};

type SimpleIdListEntry = {
  id: ElementId;
  isDeleted: boolean;
};

export type IdListUpdate =
  | { type: 'insertAfter'; before: ElementId | null; id: ElementId; count: number }
  | { type: 'deleteRange'; startIndex: number; endIndex: number };

export type TextState = {
  text: string;
  idList: SimpleIdList;
};

export type ClientInsertMutation = {
  name: 'insert';
  clientCounter: number;
  args: {
    before: ElementId | null;
    id: ElementId;
    content: string;
    isInWord: boolean;
  };
};

export type ClientDeleteMutation = {
  name: 'delete';
  clientCounter: number;
  args: {
    startId: ElementId;
    endId?: ElementId;
    contentLength?: number;
  };
};

export type ClientMutation = ClientInsertMutation | ClientDeleteMutation;

export type SelectionIds =
  | { type: 'cursor'; cursor: ElementId | null }
  | { type: 'range'; start: ElementId | null; end: ElementId | null; direction: 'forward' | 'backward' };

export type TextSelection = {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
};

type IndexBias = 'left' | 'right' | 'none';
type CursorBind = 'left' | 'right';

function cloneId(id: ElementId | null): ElementId | null {
  return id ? { bunchId: id.bunchId, counter: id.counter } : null;
}

function idsEqual(a: ElementId | null, b: ElementId | null): boolean {
  return !!a && !!b && a.bunchId === b.bunchId && a.counter === b.counter;
}

export class SimpleIdList {
  entries: SimpleIdListEntry[];
  length: number;

  constructor(entries: SimpleIdListEntry[] = []) {
    this.entries = entries;
    this.length = 0;
    for (const entry of entries) {
      if (!entry.isDeleted) {
        this.length++;
      }
    }
  }

  static load(savedState: SavedIdListItem[]): SimpleIdList {
    const entries: SimpleIdListEntry[] = [];
    for (const item of savedState || []) {
      for (let offset = 0; offset < item.count; offset++) {
        entries.push({
          id: { bunchId: item.bunchId, counter: item.startCounter + offset },
          isDeleted: Boolean(item.isDeleted),
        });
      }
    }
    return new SimpleIdList(entries);
  }

  clone(): SimpleIdList {
    return new SimpleIdList(this.entries.map((entry) => ({ id: cloneId(entry.id)!, isDeleted: entry.isDeleted })));
  }

  findKnownIndex(id: ElementId): number {
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (idsEqual(entry.id, id)) {
        return index;
      }
    }
    return -1;
  }

  has(id: ElementId): boolean {
    const knownIndex = this.findKnownIndex(id);
    return knownIndex !== -1 && !this.entries[knownIndex].isDeleted;
  }

  isKnown(id: ElementId): boolean {
    return this.findKnownIndex(id) !== -1;
  }

  at(index: number): ElementId {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`Index out of bounds: ${index}`);
    }
    let visibleIndex = 0;
    for (const entry of this.entries) {
      if (entry.isDeleted) {
        continue;
      }
      if (visibleIndex === index) {
        return cloneId(entry.id)!;
      }
      visibleIndex++;
    }
    throw new Error(`Index out of bounds: ${index}`);
  }

  indexOf(id: ElementId, bias: IndexBias = 'none'): number {
    const knownIndex = this.findKnownIndex(id);
    if (knownIndex === -1) {
      throw new Error('id is not known');
    }

    let visibleBefore = 0;
    for (let index = 0; index < knownIndex; index++) {
      if (!this.entries[index].isDeleted) {
        visibleBefore++;
      }
    }

    if (!this.entries[knownIndex].isDeleted) {
      return visibleBefore;
    }

    if (bias === 'left') {
      return visibleBefore - 1;
    }
    if (bias === 'right') {
      return visibleBefore;
    }
    return -1;
  }

  cursorAt(index: number, bind: CursorBind = 'left'): ElementId | null {
    if (!Number.isInteger(index) || index < 0 || index > this.length) {
      throw new Error(`Cursor index out of bounds: ${index}`);
    }
    if (bind === 'left') {
      return index === 0 ? null : this.at(index - 1);
    }
    return index === this.length ? null : this.at(index);
  }

  cursorIndex(cursor: ElementId | null, bind: CursorBind = 'left'): number {
    if (bind === 'left') {
      return cursor === null ? 0 : this.indexOf(cursor, 'left') + 1;
    }
    return cursor === null ? this.length : this.indexOf(cursor, 'right');
  }

  maxCounter(bunchId: string): number | undefined {
    let max: number | undefined;
    for (const entry of this.entries) {
      if (entry.id.bunchId === bunchId) {
        if (max === undefined || entry.id.counter > max) {
          max = entry.id.counter;
        }
      }
    }
    return max;
  }

  insertAfter(before: ElementId | null, startId: ElementId, count = 1): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid count: ${count}`);
    }
    if (count === 0) {
      return;
    }

    let insertAt = 0;
    if (before !== null) {
      const knownIndex = this.findKnownIndex(before);
      if (knownIndex === -1) {
        throw new Error('before is not known');
      }
      insertAt = knownIndex + 1;
    }

    const inserted: SimpleIdListEntry[] = [];
    for (let offset = 0; offset < count; offset++) {
      inserted.push({
        id: { bunchId: startId.bunchId, counter: startId.counter + offset },
        isDeleted: false,
      });
    }
    this.entries.splice(insertAt, 0, ...inserted);
    this.length += count;
  }

  deleteRange(startIndex: number, endIndex: number): void {
    if (endIndex < startIndex) {
      return;
    }
    const knownIndexes: number[] = [];
    let visibleIndex = 0;
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (entry.isDeleted) {
        continue;
      }
      if (visibleIndex >= startIndex && visibleIndex <= endIndex) {
        knownIndexes.push(index);
      }
      visibleIndex++;
      if (visibleIndex > endIndex) {
        break;
      }
    }

    for (const knownIndex of knownIndexes) {
      if (!this.entries[knownIndex].isDeleted) {
        this.entries[knownIndex] = { ...this.entries[knownIndex], isDeleted: true };
        this.length--;
      }
    }
  }
}

export class TrackedIdList {
  private _idList: SimpleIdList;
  private readonly trackChanges: boolean;
  private updates: IdListUpdate[];

  constructor(idList: SimpleIdList, trackChanges: boolean) {
    this._idList = idList;
    this.trackChanges = trackChanges;
    this.updates = [];
  }

  get idList(): SimpleIdList {
    return this._idList;
  }

  getAndResetUpdates(): IdListUpdate[] {
    if (!this.trackChanges) {
      throw new Error('trackChanges not enabled');
    }
    const updates = this.updates;
    this.updates = [];
    return updates;
  }

  insertAfter(before: ElementId | null, id: ElementId, count = 1): void {
    this._idList.insertAfter(before, id, count);
    if (this.trackChanges) {
      this.updates.push({ type: 'insertAfter', before: cloneId(before), id: cloneId(id)!, count });
    }
  }

  deleteRange(startIndex: number, endIndex: number): void {
    this._idList.deleteRange(startIndex, endIndex);
    if (this.trackChanges) {
      this.updates.push({ type: 'deleteRange', startIndex, endIndex });
    }
  }

  apply(update: IdListUpdate): void {
    switch (update.type) {
      case 'insertAfter':
        this._idList.insertAfter(update.before, update.id, update.count);
        return;
      case 'deleteRange':
        this._idList.deleteRange(update.startIndex, update.endIndex);
        return;
    }
  }
}

export class ElementIdGenerator {
  private readonly newBunchId: () => string;
  private readonly nextCounterMap: Map<string, number>;

  constructor(newBunchId: () => string) {
    this.newBunchId = newBunchId;
    this.nextCounterMap = new Map();
  }

  generateAfter(beforeId: ElementId | null, count = 1): ElementId {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Invalid count: ${count}`);
    }

    if (beforeId) {
      const nextCounter = this.nextCounterMap.get(beforeId.bunchId) || 0;
      if (beforeId.counter + 1 >= nextCounter) {
        const counter = beforeId.counter + 1;
        this.nextCounterMap.set(beforeId.bunchId, counter + count);
        return { bunchId: beforeId.bunchId, counter };
      }
    }

    const bunchId = this.newBunchId();
    this.nextCounterMap.set(bunchId, count);
    return { bunchId, counter: 0 };
  }
}

export function applyClientMutation(state: TextState, mutation: ClientMutation): TextState {
  const trackedIds = new TrackedIdList(state.idList.clone(), false);

  if (mutation.name === 'insert') {
    const { before, id, content, isInWord } = mutation.args;
    if (!content) {
      return state;
    }
    if (before !== null && !trackedIds.idList.isKnown(before)) {
      return state;
    }
    if (trackedIds.idList.isKnown(id)) {
      return state;
    }
    if (isInWord && before !== null && !trackedIds.idList.has(before)) {
      return state;
    }

    trackedIds.insertAfter(before, id, content.length);
    const insertIndex = before === null ? 0 : trackedIds.idList.indexOf(id);
    return {
      text: state.text.slice(0, insertIndex) + content + state.text.slice(insertIndex),
      idList: trackedIds.idList,
    };
  }

  const { startId, endId, contentLength } = mutation.args;
  if (!trackedIds.idList.isKnown(startId)) {
    return state;
  }

  const startIndex = trackedIds.idList.indexOf(startId, 'right');
  const endIndex = endId === undefined
    ? startIndex
    : trackedIds.idList.isKnown(endId)
      ? trackedIds.idList.indexOf(endId, 'left')
      : startIndex - 1;

  if (endIndex < startIndex) {
    return state;
  }

  const currentLength = endIndex - startIndex + 1;
  if (contentLength !== undefined && currentLength > contentLength + 10) {
    return state;
  }

  trackedIds.deleteRange(startIndex, endIndex);
  return {
    text: state.text.slice(0, startIndex) + state.text.slice(endIndex + 1),
    idList: trackedIds.idList,
  };
}

export function applyIdListUpdates(idList: SimpleIdList, updates: IdListUpdate[]): SimpleIdList {
  const trackedIds = new TrackedIdList(idList.clone(), false);
  for (const update of updates) {
    trackedIds.apply(update);
  }
  return trackedIds.idList;
}

export function selectionToIds(
  idList: SimpleIdList,
  start: number,
  end: number,
  direction: 'forward' | 'backward' | 'none' = 'forward',
): SelectionIds {
  if (start === end) {
    return {
      type: 'cursor',
      cursor: idList.cursorAt(start, 'left'),
    };
  }

  return {
    type: 'range',
    start: idList.cursorAt(start, 'right'),
    end: idList.cursorAt(end, 'left'),
    direction: direction === 'backward' ? 'backward' : 'forward',
  };
}

export function selectionFromIds(selection: SelectionIds, idList: SimpleIdList): TextSelection {
  try {
    if (selection.type === 'cursor') {
      const index = idList.cursorIndex(selection.cursor, 'left');
      return { start: index, end: index, direction: 'none' };
    }

    const start = idList.cursorIndex(selection.start, 'right');
    const end = idList.cursorIndex(selection.end, 'left');
    if (selection.direction === 'backward') {
      return { start, end, direction: 'backward' };
    }
    return { start, end, direction: 'forward' };
  } catch {
    return { start: 0, end: 0, direction: 'none' };
  }
}
