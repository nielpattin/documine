import {
  SimpleIdList,
  applyClientMutation,
  applyIdListUpdates,
  selectionFromIds,
  selectionToIds,
  type ClientMutation,
  type ElementId,
  type IdListUpdate,
  type SavedIdListItem,
  type SelectionIds,
  type TextSelection,
  type TextState,
} from './collab-shared';

const PRESENCE_THROTTLE_MS = 80;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PRESENCE_STALE_MS = 60000;

type UploadImageResult = { ok: true; asset: { url: string; markdown: string } };

export type ShareParticipant = {
  clientId: string;
  name: string;
  permissionLabel: string;
};

type CreateCollabEditorOptions = {
  noteId?: string;
  shareId?: string;
  onReady?: (payload: { noteId: string; title: string; shareId: string; markdown: string }) => void;
  onTextChange?: (markdown: string) => void;
  onConnectionChange?: (connected: boolean) => void;
  onThreadsUpdated?: () => void;
  onParticipantsChange?: (participants: ShareParticipant[]) => void;
  onUploadImage?: (file: File) => Promise<UploadImageResult>;
};

export type CollabEditorHandle = {
  destroy: () => void;
  getText: () => string;
  getScrollAnchor: () => { quote: string; prefix: string; suffix: string; start: number; end: number; heading: { text: string; level: number } | null } | null;
  insertText: (text: string) => void;
};

type PresenceCursor = {
  name: string;
  color: string;
  selection: SelectionIds;
  lastUpdate: number;
};

type CaretPosition = {
  top: number;
  left: number;
};

type ScrollAnchor = {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  heading: { text: string; level: number } | null;
};

type HeadingAnchor = {
  start: number;
  level: number;
  text: string;
};

type BoxPosition = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ServerHelloMessage = {
  type: 'hello';
  clientId?: string;
  noteId: string;
  title: string;
  shareId: string;
  markdown?: string;
  idListState?: SavedIdListItem[];
};

type ServerMutationMessage = {
  type: 'mutation';
  senderId?: string;
  senderCounter?: number;
  markdown?: string;
  idListUpdates?: IdListUpdate[];
};

type ServerPresenceMessage = {
  type: 'presence';
  clientId: string;
  name: string;
  color: string;
  selection: SelectionIds;
};

type ServerPresenceLeaveMessage = {
  type: 'presence-leave';
  clientId: string;
};

type ServerThreadsUpdatedMessage = {
  type: 'threads-updated';
};

type ServerParticipantsMessage = {
  type: 'participants';
  participants: ShareParticipant[];
};

type ServerMessage =
  | ServerHelloMessage
  | ServerMutationMessage
  | ServerPresenceMessage
  | ServerPresenceLeaveMessage
  | ServerThreadsUpdatedMessage
  | ServerParticipantsMessage;

type ClientMutationEnvelope = {
  type: 'mutation';
  clientId: string;
  mutations: ClientMutation[];
};

type ClientPresenceEnvelope = {
  type: 'presence';
  clientId: string;
  selection: SelectionIds;
};

type EditorState = TextState;

type PendingUpload = {
  file: File;
  placeholder: string;
};

function escapeMarkdownAlt(text: string): string {
  return String(text || 'image').replace(/[\[\]\\]/g, '').trim() || 'image';
}

function fileLabel(file?: File): string {
  const name = String(file?.name || '').trim();
  if (!name) return 'image';
  return name.replace(/\.[A-Za-z0-9]+$/, '') || 'image';
}

function imageFilesFromPasteEvent(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData?.files || []).filter((file) => file && String(file.type || '').startsWith('image/'));
}

function imageFilesFromDropEvent(event: DragEvent): File[] {
  return Array.from(event.dataTransfer?.files || []).filter((file) => file && String(file.type || '').startsWith('image/'));
}

function isWordChar(ch: string): boolean {
  return /[0-9A-Za-z_]/.test(ch || '');
}

function normalizeInsertedText(text: string): string {
  return String(text || '').replace(/\r\n?/g, '\n');
}

function readInsertText(event: InputEvent): string {
  if (typeof event.data === 'string') return normalizeInsertedText(event.data);
  if (event.dataTransfer) return normalizeInsertedText(event.dataTransfer.getData('text/plain') || '');
  return '';
}

function clampSel(text: string, sel: TextSelection): TextSelection {
  return {
    start: Math.max(0, Math.min(sel.start, text.length)),
    end: Math.max(0, Math.min(sel.end, text.length)),
    direction: sel.direction || 'none',
  };
}

function wordBackward(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

function wordForward(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}

function lineBackward(text: string, cursor: number): number {
  let i = cursor - 1;
  while (i > 0 && text[i - 1] !== '\n') i--;
  return Math.max(0, i);
}

function buildDeleteMutation(state: EditorState, start: number, endExcl: number, counter: number): ClientMutation | null {
  if (start < 0 || endExcl <= start || endExcl > state.text.length) return null;
  return {
    name: 'delete',
    clientCounter: counter,
    args: { startId: state.idList.at(start), endId: state.idList.at(endExcl - 1), contentLength: endExcl - start },
  };
}

function buildInsertMutation(
  state: EditorState,
  index: number,
  content: string,
  counter: number,
  newId: (before: ElementId | null, idList: SimpleIdList, _count?: number) => ElementId,
): ClientMutation | null {
  if (!content) return null;
  const before = index === 0 ? null : state.idList.at(index - 1);
  const id = newId(before, state.idList, content.length);
  const prev = index > 0 ? state.text[index - 1] : '';
  const next = index < state.text.length ? state.text[index] : '';
  return {
    name: 'insert',
    clientCounter: counter,
    args: { before, id, content, isInWord: isWordChar(content[0]) && (isWordChar(prev) || isWordChar(next)) },
  };
}

function replayPending(serverState: EditorState, pending: ClientMutation[]): EditorState {
  let state: EditorState = { text: serverState.text, idList: serverState.idList.clone() };
  for (const mutation of pending) state = applyClientMutation(state, mutation);
  return state;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function isLocalBrowserHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function buildApiWsOrigin(): string {
  const envOrigin = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_DOCUMINE_API_WS_ORIGIN
    ? String(import.meta.env.VITE_DOCUMINE_API_WS_ORIGIN).trim()
    : '';
  if (envOrigin) {
    return trimTrailingSlash(envOrigin);
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (isLocalBrowserHost(location.hostname) && location.port && location.port !== '3120') {
    return `${protocol}//${location.hostname}:3120`;
  }

  return `${protocol}//${location.host}`;
}

function getBoxPosition(element: HTMLElement, relativeTo: HTMLElement): BoxPosition {
  const elementRect = element.getBoundingClientRect();
  const relativeRect = relativeTo.getBoundingClientRect();
  return {
    left: elementRect.left - relativeRect.left,
    top: elementRect.top - relativeRect.top,
    width: elementRect.width,
    height: elementRect.height,
  };
}

function syncMirrorStyles(mirror: HTMLDivElement, textarea: HTMLTextAreaElement, relativeTo: HTMLElement): BoxPosition {
  const cs = getComputedStyle(textarea);
  const props = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform',
    'wordSpacing', 'textIndent', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'wordWrap', 'overflowWrap', 'whiteSpace', 'lineHeight', 'tabSize', 'boxSizing',
  ] as const;
  for (const prop of props) mirror.style[prop] = cs[prop];
  const box = getBoxPosition(textarea, relativeTo);
  mirror.style.left = `${box.left}px`;
  mirror.style.top = `${box.top}px`;
  mirror.style.width = `${box.width}px`;
  mirror.style.height = `${box.height}px`;
  return box;
}

function measureCaretPositions(textarea: HTMLTextAreaElement, mirror: HTMLDivElement, relativeTo: HTMLElement, indices: number[]): { positions: Map<number, CaretPosition>; box: BoxPosition } {
  const box = syncMirrorStyles(mirror, textarea, relativeTo);
  const text = textarea.value;
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  mirror.textContent = '';
  const markers = new Map<number, HTMLSpanElement>();
  let last = 0;
  for (const idx of sorted) {
    const clampedIdx = Math.max(0, Math.min(idx, text.length));
    if (clampedIdx > last) mirror.appendChild(document.createTextNode(text.substring(last, clampedIdx)));
    const span = document.createElement('span');
    span.textContent = '\u200b';
    mirror.appendChild(span);
    markers.set(idx, span);
    last = clampedIdx;
  }
  if (last < text.length) mirror.appendChild(document.createTextNode(text.substring(last)));
  if (!mirror.childNodes.length) mirror.appendChild(document.createTextNode('\u200b'));

  const positions = new Map<number, CaretPosition>();
  for (const [idx, span] of markers) {
    positions.set(idx, { top: span.offsetTop - textarea.scrollTop, left: span.offsetLeft - textarea.scrollLeft });
  }
  return { positions, box };
}

function trimLeftToBoundary(text: string, start: number, lowerBound: number) {
  let index = start;
  while (index > lowerBound && isWordChar(text[index - 1] || '')) {
    index--;
  }
  return index;
}

function trimRightToBoundary(text: string, end: number, upperBound: number) {
  let index = end;
  while (index < upperBound && isWordChar(text[index] || '')) {
    index++;
  }
  return index;
}

function buildHeadingAnchors(text: string): HeadingAnchor[] {
  if (!text) {
    return [];
  }

  const headings: HeadingAnchor[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let inFence = false;

  for (const line of lines) {
    const fenceMatch = line.trimStart().match(/^(```+|~~~+)/);
    if (fenceMatch) {
      inFence = !inFence;
    } else if (!inFence) {
      const match = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (match) {
        const headingText = match[2].replace(/\s+#+$/, '').trim();
        if (headingText) {
          headings.push({
            start: offset,
            level: match[1].length,
            text: headingText,
          });
        }
      }
    }
    offset += line.length + 1;
  }

  return headings;
}

function buildScrollAnchor(text: string, index: number, headings: HeadingAnchor[]): ScrollAnchor | null {
  if (!text) {
    return null;
  }
  const safeIndex = Math.max(0, Math.min(index, text.length - 1));
  const windowStart = Math.max(0, safeIndex - 48);
  const windowEnd = Math.min(text.length, safeIndex + 120);
  const start = trimLeftToBoundary(text, windowStart, Math.max(0, safeIndex - 120));
  const end = trimRightToBoundary(text, windowEnd, Math.min(text.length, safeIndex + 240));
  const quote = text.slice(start, end).trim();
  if (!quote) {
    return null;
  }

  let heading: HeadingAnchor | null = null;
  let low = 0;
  let high = headings.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (headings[mid].start <= safeIndex) {
      heading = headings[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return {
    quote,
    prefix: text.slice(Math.max(0, start - 40), start),
    suffix: text.slice(end, Math.min(text.length, end + 40)),
    start,
    end,
    heading: heading ? { text: heading.text, level: heading.level } : null,
  };
}

function getVisibleScrollAnchor(textarea: HTMLTextAreaElement, mirror: HTMLDivElement, relativeTo: HTMLElement): ScrollAnchor | null {
  const text = textarea.value;
  if (!text) {
    return null;
  }

  const measureIndexTop = (index: number) => {
    const { positions } = measureCaretPositions(textarea, mirror, relativeTo, [index]);
    return positions.get(index)?.top ?? 0;
  };

  let low = 0;
  let high = text.length - 1;
  let candidate = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const top = measureIndexTop(mid);
    if (top < 0) {
      low = mid + 1;
    } else {
      candidate = mid;
      high = mid - 1;
    }
  }

  return buildScrollAnchor(text, candidate, buildHeadingAnchors(text));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === 'object' && value !== null && 'type' in value;
}

export function createCollabEditor(textarea: HTMLTextAreaElement, opts: CreateCollabEditorOptions): CollabEditorHandle {
  const { noteId, shareId, onReady, onTextChange, onConnectionChange, onThreadsUpdated, onParticipantsChange, onUploadImage } = opts;
  let nextBunchIdCounter = 0;

  let ws: WebSocket | null = null;
  let destroyed = false;
  let programmatic = false;
  let initialized = false;
  let connected = false;
  let reconnectDelay = RECONNECT_BASE_MS;
  let nextClientCounter = 1;
  let clientId: string | null = null;

  let serverState: EditorState = { text: '', idList: new SimpleIdList() };
  let currentState: EditorState = { text: '', idList: new SimpleIdList() };
  let pendingMutations: ClientMutation[] = [];

  const remoteCursors = new Map<string, PresenceCursor>();

  const container = textarea.parentElement;
  if (!container) {
    throw new Error('Collab editor textarea must have a parent element.');
  }
  const host = container;
  host.style.position = 'relative';

  const overlay = document.createElement('div');
  overlay.className = 'cursor-overlay';
  host.appendChild(overlay);

  const mirror = document.createElement('div');
  mirror.className = 'textarea-mirror';
  mirror.style.cssText = 'position:absolute;visibility:hidden;overflow:hidden;white-space:pre-wrap;word-wrap:break-word;pointer-events:none;';
  host.appendChild(mirror);

  let resizeObserver: ResizeObserver | null = null;
  try {
    resizeObserver = new ResizeObserver(() => renderRemoteCursors());
    resizeObserver.observe(textarea);
  } catch {
    resizeObserver = null;
  }

  function newId(before: ElementId | null, idList: SimpleIdList, _count = 1): ElementId {
    if (clientId && before !== null && before.bunchId.startsWith(`${clientId}:`)) {
      const maxCounter = idList.maxCounter(before.bunchId);
      if (maxCounter === before.counter) {
        return { bunchId: before.bunchId, counter: before.counter + 1 };
      }
    }
    return {
      bunchId: `${clientId}:${nextBunchIdCounter++}:${crypto.randomUUID()}`,
      counter: 0,
    };
  }

  function currentDomSelection(): TextSelection {
    return {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      direction: textarea.selectionDirection || 'none',
    };
  }

  function setConnected(nextConnected: boolean): void {
    if (connected === nextConnected) return;
    connected = nextConnected;
    textarea.readOnly = !nextConnected;
    onConnectionChange?.(nextConnected);
  }

  function render(sel?: TextSelection): void {
    const nextSelection = clampSel(currentState.text, sel || currentDomSelection());
    programmatic = true;
    textarea.value = currentState.text;
    textarea.setSelectionRange(nextSelection.start, nextSelection.end, nextSelection.direction);
    queueMicrotask(() => { programmatic = false; });
    onTextChange?.(currentState.text);
    renderRemoteCursors();
  }

  function renderRemoteCursors(): void {
    overlay.innerHTML = '';
    if (!initialized) return;
    const indices: number[] = [];
    const cursorData: Array<{ idx: number; name: string; color: string }> = [];

    for (const [cid, info] of remoteCursors) {
      if (Date.now() - info.lastUpdate > PRESENCE_STALE_MS) {
        remoteCursors.delete(cid);
        continue;
      }
      try {
        const sel = selectionFromIds(info.selection, currentState.idList);
        const idx = sel.start;
        indices.push(idx);
        cursorData.push({ idx, name: info.name, color: info.color });
      } catch {
        // ignore stale cursor data
      }
    }

    if (!cursorData.length) return;

    const { positions, box } = measureCaretPositions(textarea, mirror, host, indices);
    overlay.style.left = `${box.left}px`;
    overlay.style.top = `${box.top}px`;
    overlay.style.width = `${box.width}px`;
    overlay.style.height = `${box.height}px`;
    const cs = getComputedStyle(textarea);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;

    for (const cursor of cursorData) {
      const pos = positions.get(cursor.idx);
      if (!pos) continue;
      const borderTopWidth = parseFloat(cs.borderTopWidth) || 0;
      const borderBottomWidth = parseFloat(cs.borderBottomWidth) || 0;
      const visibleHeight = textarea.clientHeight;
      if (pos.top < 0 - lineHeight || pos.top > visibleHeight + borderTopWidth + borderBottomWidth) continue;

      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.style.left = `${pos.left}px`;
      el.style.top = `${pos.top}px`;
      el.innerHTML = `<div class="remote-cursor-caret" style="background:${cursor.color};height:${lineHeight}px"></div><div class="remote-cursor-label" style="background:${cursor.color}">${escapeHtml(cursor.name)}</div>`;
      overlay.appendChild(el);
    }
  }

  let lastPresenceSent = 0;
  let presenceTimer: ReturnType<typeof window.setTimeout> | null = null;
  let lastSentSelection: string | null = null;

  function sendJson(payload: ClientMutationEnvelope | ClientPresenceEnvelope): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function sendPresence(): void {
    if (!initialized || !connected || !clientId || !ws || ws.readyState !== WebSocket.OPEN) return;
    const sel = selectionToIds(currentState.idList, textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection || 'none');
    const key = JSON.stringify(sel);
    if (key === lastSentSelection) return;
    lastSentSelection = key;
    sendJson({ type: 'presence', clientId, selection: sel });
  }

  function throttledPresence(): void {
    const now = Date.now();
    if (now - lastPresenceSent >= PRESENCE_THROTTLE_MS) {
      lastPresenceSent = now;
      sendPresence();
    } else {
      if (presenceTimer !== null) {
        clearTimeout(presenceTimer);
      }
      presenceTimer = window.setTimeout(() => {
        lastPresenceSent = Date.now();
        sendPresence();
      }, PRESENCE_THROTTLE_MS - (now - lastPresenceSent));
    }
  }

  function applyLocalMutations(mutations: ClientMutation[], sel: TextSelection): void {
    if (!mutations.length) return;
    for (const mutation of mutations) {
      currentState = applyClientMutation(currentState, mutation);
      pendingMutations.push(mutation);
    }
    render(sel);
    if (clientId) {
      sendJson({ type: 'mutation', clientId, mutations });
    }
    throttledPresence();
  }

  function replaceRangeWithText(start: number, end: number, nextContent: string): void {
    const normalizedContent = normalizeInsertedText(nextContent);
    const nextText = `${currentState.text.slice(0, start)}${normalizedContent}${currentState.text.slice(end)}`;
    applyDiffFallback(nextText);
  }

  function replaceFirstOccurrence(oldText: string, newText: string): boolean {
    const start = currentState.text.indexOf(oldText);
    if (start === -1) {
      return false;
    }
    replaceRangeWithText(start, start + oldText.length, newText);
    return true;
  }

  function formatPastedMarkdown(markdown: string, start: number, end: number): string {
    const before = currentState.text.slice(0, start);
    const after = currentState.text.slice(end);
    const prefix = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const suffix = after.length === 0 ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    return `${prefix}${markdown}${suffix}`;
  }

  async function insertUploadedImages(files: File[], start: number, end: number): Promise<void> {
    if (!initialized || !connected || typeof onUploadImage !== 'function' || !files.length) {
      return;
    }

    const pending: PendingUpload[] = files.map((file) => {
      const token = crypto.randomUUID();
      return {
        file,
        placeholder: `![Uploading ${escapeMarkdownAlt(fileLabel(file))}...](uploading://${token})`,
      };
    });

    replaceRangeWithText(start, end, formatPastedMarkdown(pending.map((item) => item.placeholder).join('\n\n'), start, end));

    for (const item of pending) {
      try {
        const payload = await onUploadImage(item.file);
        replaceFirstOccurrence(item.placeholder, payload.asset.markdown);
      } catch (error) {
        replaceFirstOccurrence(item.placeholder, '');
        window.alert(error instanceof Error ? error.message : 'Image upload failed.');
      }
    }
  }

  async function handleImagePaste(event: ClipboardEvent): Promise<void> {
    const files = imageFilesFromPasteEvent(event);
    if (!files.length) {
      return;
    }

    event.preventDefault();
    await insertUploadedImages(files, textarea.selectionStart, textarea.selectionEnd);
  }

  async function handleImageDrop(event: DragEvent): Promise<void> {
    const files = imageFilesFromDropEvent(event);
    if (!files.length) {
      return;
    }

    event.preventDefault();
    textarea.focus();

    const textLength = textarea.value.length;
    const position = Math.max(0, Math.min(textarea.selectionStart, textLength));
    await insertUploadedImages(files, position, position);
  }

  function receiveHello(msg: ServerHelloMessage): void {
    const selIds = initialized
      ? selectionToIds(currentState.idList, textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection || 'none')
      : null;

    if (msg.clientId) clientId = msg.clientId;
    serverState = { text: msg.markdown || '', idList: SimpleIdList.load(msg.idListState || []) };
    currentState = replayPending(serverState, pendingMutations);
    initialized = true;
    setConnected(true);
    reconnectDelay = RECONNECT_BASE_MS;
    render(selIds ? selectionFromIds(selIds, currentState.idList) : { start: 0, end: 0, direction: 'none' });
    onReady?.({ noteId: msg.noteId, title: msg.title, shareId: msg.shareId, markdown: currentState.text });

    if (pendingMutations.length > 0 && clientId) {
      sendJson({ type: 'mutation', clientId, mutations: pendingMutations });
    }
    throttledPresence();
  }

  function receiveMutation(msg: ServerMutationMessage): void {
    if (!initialized) return;
    const selIds = selectionToIds(currentState.idList, textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection || 'none');
    serverState = { text: msg.markdown || '', idList: applyIdListUpdates(serverState.idList, msg.idListUpdates || []) };
    if (msg.senderId === clientId && msg.senderCounter !== undefined) {
      const idx = pendingMutations.findIndex((mutation) => mutation.clientCounter === msg.senderCounter);
      if (idx !== -1) pendingMutations = pendingMutations.slice(idx + 1);
    }
    currentState = replayPending(serverState, pendingMutations);
    render(selectionFromIds(selIds, currentState.idList));
    throttledPresence();
  }

  function receivePresence(msg: ServerPresenceMessage): void {
    remoteCursors.set(msg.clientId, { name: msg.name, color: msg.color, selection: msg.selection, lastUpdate: Date.now() });
    renderRemoteCursors();
  }

  function receivePresenceLeave(msg: ServerPresenceLeaveMessage): void {
    remoteCursors.delete(msg.clientId);
    renderRemoteCursors();
  }

  function handleBeforeInput(event: InputEvent): void {
    if (!initialized || !connected) {
      event.preventDefault();
      return;
    }
    if (event.isComposing || event.inputType.includes('Composition')) return;

    const inputType = event.inputType;
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const hasSelection = selectionStart !== selectionEnd;
    const mutations: ClientMutation[] = [];
    let workingState: EditorState = { text: currentState.text, idList: currentState.idList.clone() };

    function pushDel(start: number, end: number): boolean {
      const mutation = buildDeleteMutation(workingState, start, end, nextClientCounter++);
      if (!mutation) return false;
      mutations.push(mutation);
      workingState = applyClientMutation(workingState, mutation);
      return true;
    }

    function pushIns(index: number, content: string): boolean {
      const mutation = buildInsertMutation(workingState, index, content, nextClientCounter++, newId);
      if (!mutation) return false;
      mutations.push(mutation);
      workingState = applyClientMutation(workingState, mutation);
      return true;
    }

    let sel: TextSelection = { start: selectionStart, end: selectionEnd, direction: 'none' };

    if (hasSelection && inputType !== 'historyUndo' && inputType !== 'historyRedo') {
      pushDel(selectionStart, selectionEnd);
      sel = { start: selectionStart, end: selectionStart, direction: 'none' };
    }

    if (inputType === 'insertText' || inputType === 'insertReplacementText' || inputType === 'insertFromPaste' || inputType === 'insertFromDrop') {
      const content = readInsertText(event);
      if (!content) return;
      event.preventDefault();
      pushIns(sel.start, content);
      sel = { start: sel.start + content.length, end: sel.start + content.length, direction: 'none' };
      applyLocalMutations(mutations, sel);
      return;
    }
    if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
      event.preventDefault();
      pushIns(sel.start, '\n');
      sel = { start: sel.start + 1, end: sel.start + 1, direction: 'none' };
      applyLocalMutations(mutations, sel);
      return;
    }
    if (inputType === 'deleteContentBackward') {
      event.preventDefault();
      if (!hasSelection && selectionStart > 0) {
        pushDel(selectionStart - 1, selectionStart);
        sel = { start: selectionStart - 1, end: selectionStart - 1, direction: 'none' };
      }
      applyLocalMutations(mutations, sel);
      return;
    }
    if (inputType === 'deleteContentForward') {
      event.preventDefault();
      if (!hasSelection && selectionStart < currentState.text.length) {
        pushDel(selectionStart, selectionStart + 1);
        sel = { start: selectionStart, end: selectionStart, direction: 'none' };
      }
      applyLocalMutations(mutations, sel);
      return;
    }
    if (inputType === 'deleteWordBackward') {
      event.preventDefault();
      if (!hasSelection && selectionStart > 0) {
        const start = wordBackward(currentState.text, selectionStart);
        pushDel(start, selectionStart);
        sel = { start, end: start, direction: 'none' };
      }
      applyLocalMutations(mutations, sel);
      return;
    }
    if (inputType === 'deleteWordForward') {
      event.preventDefault();
      if (!hasSelection && selectionStart < currentState.text.length) {
        const end = wordForward(currentState.text, selectionStart);
        pushDel(selectionStart, end);
        sel = { start: selectionStart, end: selectionStart, direction: 'none' };
      }
      applyLocalMutations(mutations, sel);
      return;
    }
    if (inputType === 'deleteSoftLineBackward' || inputType === 'deleteHardLineBackward') {
      event.preventDefault();
      if (!hasSelection && selectionStart > 0) {
        const start = lineBackward(currentState.text, selectionStart);
        pushDel(start, selectionStart);
        sel = { start, end: start, direction: 'none' };
      }
      applyLocalMutations(mutations, sel);
    }
  }

  function handleInput(): void {
    if (programmatic || !initialized) return;
    applyDiffFallback(textarea.value);
  }

  function applyDiffFallback(nextText: string): void {
    const normalizedNextText = normalizeInsertedText(nextText);
    if (!initialized || normalizedNextText === currentState.text) return;

    const prev = currentState.text;
    let prefix = 0;
    while (prefix < prev.length && prefix < normalizedNextText.length && prev[prefix] === normalizedNextText[prefix]) prefix++;

    let prevSuffix = prev.length;
    let nextSuffix = normalizedNextText.length;
    while (prevSuffix > prefix && nextSuffix > prefix && prev[prevSuffix - 1] === normalizedNextText[nextSuffix - 1]) {
      prevSuffix--;
      nextSuffix--;
    }

    const mutations: ClientMutation[] = [];
    let workingState: EditorState = { text: currentState.text, idList: currentState.idList.clone() };
    const deleteMutation = buildDeleteMutation(workingState, prefix, prevSuffix, nextClientCounter);
    if (deleteMutation) {
      nextClientCounter++;
      mutations.push(deleteMutation);
      workingState = applyClientMutation(workingState, deleteMutation);
    }

    const insertText = normalizedNextText.slice(prefix, nextSuffix);
    if (insertText) {
      const insertMutation = buildInsertMutation(workingState, prefix, insertText, nextClientCounter, newId);
      if (insertMutation) {
        nextClientCounter++;
        mutations.push(insertMutation);
      }
    }

    if (!mutations.length) {
      render({ start: prefix, end: prefix, direction: 'none' });
      return;
    }

    const cursor = prefix + insertText.length;
    applyLocalMutations(mutations, { start: cursor, end: cursor, direction: 'none' });
  }

  function connect(): void {
    const param = noteId ? `noteId=${encodeURIComponent(noteId)}` : `shareId=${encodeURIComponent(shareId || '')}`;
    const socket = new WebSocket(`${buildApiWsOrigin()}/ws?${param}`);
    ws = socket;

    socket.addEventListener('open', () => {
      if (destroyed || ws !== socket) {
        socket.close();
      }
    });
    socket.addEventListener('message', (event) => {
      if (destroyed || ws !== socket) {
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isServerMessage(msg)) {
        return;
      }
      if (msg.type === 'hello') receiveHello(msg);
      else if (msg.type === 'mutation') receiveMutation(msg);
      else if (msg.type === 'presence') receivePresence(msg);
      else if (msg.type === 'presence-leave') receivePresenceLeave(msg);
      else if (msg.type === 'threads-updated') onThreadsUpdated?.();
      else if (msg.type === 'participants') onParticipantsChange?.(msg.participants);
    });
    socket.addEventListener('close', () => {
      if (ws === socket) {
        ws = null;
      }
      if (destroyed || ws !== null && ws !== socket) return;
      setConnected(false);
      remoteCursors.clear();
      renderRemoteCursors();
      window.setTimeout(() => {
        if (!destroyed) {
          reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
          connect();
        }
      }, reconnectDelay);
    });
    socket.addEventListener('error', () => {
      if (destroyed || ws !== socket) {
        return;
      }
      setConnected(false);
    });
  }

  function handlePaste(event: ClipboardEvent): void {
    void handleImagePaste(event);
  }

  function handleDragOver(event: DragEvent): void {
    if (imageFilesFromDropEvent(event).length) {
      event.preventDefault();
    }
  }

  function handleDrop(event: DragEvent): void {
    void handleImageDrop(event);
  }

  const handleCompositionEnd = (): void => {
    if (textarea.value !== currentState.text) applyDiffFallback(textarea.value);
  };
  const handleSelectionChange = (): void => {
    if (document.activeElement === textarea) throttledPresence();
  };

  textarea.addEventListener('beforeinput', handleBeforeInput);
  textarea.addEventListener('input', handleInput);
  textarea.addEventListener('paste', handlePaste);
  textarea.addEventListener('dragover', handleDragOver);
  textarea.addEventListener('drop', handleDrop);
  textarea.addEventListener('compositionend', handleCompositionEnd);
  document.addEventListener('selectionchange', handleSelectionChange);
  textarea.addEventListener('focus', throttledPresence);
  textarea.addEventListener('blur', throttledPresence);
  textarea.addEventListener('scroll', renderRemoteCursors);

  connect();

  return {
    destroy() {
      destroyed = true;
      textarea.removeEventListener('beforeinput', handleBeforeInput);
      textarea.removeEventListener('input', handleInput);
      textarea.removeEventListener('paste', handlePaste);
      textarea.removeEventListener('dragover', handleDragOver);
      textarea.removeEventListener('drop', handleDrop);
      textarea.removeEventListener('compositionend', handleCompositionEnd);
      document.removeEventListener('selectionchange', handleSelectionChange);
      textarea.removeEventListener('focus', throttledPresence);
      textarea.removeEventListener('blur', throttledPresence);
      textarea.removeEventListener('scroll', renderRemoteCursors);
      if (presenceTimer !== null) {
        clearTimeout(presenceTimer);
      }
      if (resizeObserver) resizeObserver.disconnect();
      const socket = ws;
      ws = null;
      onParticipantsChange?.([]);
      if (socket) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.addEventListener('open', () => socket.close(), { once: true });
        }
      }
      overlay.remove();
      mirror.remove();
    },
    getText() {
      return currentState.text;
    },
    getScrollAnchor() {
      return getVisibleScrollAnchor(textarea, mirror, host);
    },
    insertText(text: string) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      replaceRangeWithText(start, end, text);
      textarea.focus();
    },
  };
}
