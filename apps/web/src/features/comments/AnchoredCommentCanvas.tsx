import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefCallback, type RefObject } from 'react';
import { formatDate, type Thread, type ThreadAnchor, type ThreadMessage } from '../../lib/api';
import { handleCommentTextareaKeyDown } from '../../components/shared-ui';
import { handlePreviewCodeCopy } from '../clipboard';

type AnchorWithOptionalHeading = ThreadAnchor & {
  heading?: { text: string; level: number } | null;
};

function normalizePreviewText(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function findTextOccurrences(text: string, pattern: string) {
  const indices: number[] = [];
  if (!text || !pattern) {
    return indices;
  }

  let index = text.indexOf(pattern);
  while (index !== -1) {
    indices.push(index);
    index = text.indexOf(pattern, index + Math.max(1, pattern.length));
  }
  return indices;
}

function usePreviewCommentSelection({
  rootRef,
  bubbleRef,
  fabRef,
  enabled,
}: {
  rootRef: RefObject<HTMLElement | null>;
  bubbleRef: RefObject<HTMLButtonElement | null>;
  fabRef: RefObject<HTMLButtonElement | null>;
  enabled: boolean;
}) {
  const anchorRef = useRef<ThreadAnchor | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const pointerDownRef = useRef(false);

  useEffect(() => {
    function hideControls() {
      anchorRef.current = null;
      if (bubbleRef.current) {
        bubbleRef.current.style.display = 'none';
      }
      if (fabRef.current) {
        fabRef.current.style.display = 'none';
      }
    }

    if (!enabled) {
      hideControls();
      return;
    }

    function updateSelection() {
      pendingRef.current = false;
      if (pointerDownRef.current) {
        return;
      }

      const root = rootRef.current;
      const currentSelection = window.getSelection();
      if (!root || !currentSelection || currentSelection.rangeCount === 0 || currentSelection.isCollapsed) {
        hideControls();
        return;
      }

      const range = currentSelection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        hideControls();
        return;
      }

      const anchor = buildAnchorFromSelection(root, range);
      if (!anchor) {
        hideControls();
        return;
      }

      const rect = range.getBoundingClientRect();
      const useFab = window.matchMedia('(hover: none), (pointer: coarse)').matches;
      anchorRef.current = anchor;

      if (bubbleRef.current) {
        if (useFab) {
          bubbleRef.current.style.display = 'none';
        } else {
          bubbleRef.current.style.left = `${Math.max(16, rect.left)}px`;
          bubbleRef.current.style.top = `${rect.bottom + 6}px`;
          bubbleRef.current.style.display = 'inline-flex';
        }
      }

      if (fabRef.current) {
        fabRef.current.style.display = useFab ? 'inline-flex' : 'none';
      }
    }

    function scheduleUpdate() {
      if (pendingRef.current) {
        return;
      }
      pendingRef.current = true;
      rafIdRef.current = requestAnimationFrame(updateSelection);
    }

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (!root || !root.contains(event.target as Node)) {
        return;
      }
      pointerDownRef.current = true;
      hideControls();
    }

    function handlePointerUp() {
      if (!pointerDownRef.current) {
        return;
      }
      pointerDownRef.current = false;
      scheduleUpdate();
    }

    document.addEventListener('selectionchange', scheduleUpdate);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('keyup', scheduleUpdate);

    return () => {
      hideControls();
      document.removeEventListener('selectionchange', scheduleUpdate);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('keyup', scheduleUpdate);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [enabled, rootRef, bubbleRef, fabRef]);

  function getAnchor() {
    return anchorRef.current;
  }

  function clearSelection() {
    anchorRef.current = null;
    if (bubbleRef.current) {
      bubbleRef.current.style.display = 'none';
    }
    if (fabRef.current) {
      fabRef.current.style.display = 'none';
    }
    window.getSelection()?.removeAllRanges();
  }

  return { getAnchor, clearSelection };
}

function buildAnchorFromSelection(root: HTMLElement, range: Range): ThreadAnchor | null {
  const mapping = collectTextNodes(root);
  const start = resolveOffset(root, mapping, range.startContainer, range.startOffset);
  const end = resolveOffset(root, mapping, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) {
    return null;
  }

  const quote = mapping.fullText.slice(start, end);
  if (!quote.trim()) {
    return null;
  }

  return {
    quote,
    prefix: mapping.fullText.slice(Math.max(0, start - 40), start),
    suffix: mapping.fullText.slice(end, Math.min(mapping.fullText.length, end + 40)),
    start,
    end,
  };
}

function collectTextNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: Array<{ node: Text; start: number; end: number }> = [];
  let fullText = '';
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const value = textNode.nodeValue || '';
    segments.push({ node: textNode, start: offset, end: offset + value.length });
    fullText += value;
    offset += value.length;
    node = walker.nextNode();
  }

  return { fullText, segments };
}

function resolveOffset(
  root: HTMLElement,
  mapping: ReturnType<typeof collectTextNodes>,
  container: Node,
  localOffset: number,
) {
  if (container.nodeType === Node.TEXT_NODE) {
    const segment = mapping.segments.find((item) => item.node === container);
    return segment ? segment.start + localOffset : null;
  }

  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, localOffset);
  return range.toString().length;
}

type HighlightRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PositionedThread = {
  thread: Thread;
  highlightRects: HighlightRect[];
};

function offsetsToRange(mapping: ReturnType<typeof collectTextNodes>, start: number, end: number) {
  const startSegment = mapping.segments.find((segment) => start >= segment.start && start <= segment.end);
  const endSegment = mapping.segments.find((segment) => end >= segment.start && end <= segment.end);
  if (!startSegment || !endSegment) {
    return null;
  }

  const range = document.createRange();
  range.setStart(startSegment.node, start - startSegment.start);
  range.setEnd(endSegment.node, end - endSegment.start);
  return range;
}

function locateAnchor(anchor: AnchorWithOptionalHeading, root: HTMLElement, existingMapping?: ReturnType<typeof collectTextNodes>) {
  const mapping = existingMapping ?? collectTextNodes(root);
  if (!mapping.fullText || !anchor.quote) {
    return null;
  }

  const candidates: number[] = [];
  let index = mapping.fullText.indexOf(anchor.quote);
  while (index !== -1) {
    if (!candidates.includes(index)) {
      candidates.push(index);
    }
    index = mapping.fullText.indexOf(anchor.quote, index + Math.max(1, anchor.quote.length));
  }

  if (!candidates.length) {
    return null;
  }

  const headingText = normalizePreviewText(anchor.heading?.text || '');
  const headingOccurrences = headingText ? findTextOccurrences(normalizePreviewText(mapping.fullText), headingText) : [];

  let best: number | null = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    let score = 0;
    if (mapping.fullText.slice(Math.max(0, candidate - anchor.prefix.length), candidate) === anchor.prefix) {
      score += 12;
    }
    const suffix = mapping.fullText.slice(candidate + anchor.quote.length, candidate + anchor.quote.length + anchor.suffix.length);
    if (suffix === anchor.suffix) {
      score += 12;
    }

    if (headingOccurrences.length) {
      let nearestHeadingDistance = Infinity;
      for (const headingIndex of headingOccurrences) {
        if (headingIndex <= candidate) {
          nearestHeadingDistance = Math.min(nearestHeadingDistance, candidate - headingIndex);
        }
      }
      if (nearestHeadingDistance !== Infinity) {
        score += 10;
        score -= Math.min(nearestHeadingDistance / 10, 10);
      } else {
        score -= 10;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (best === null) {
    return null;
  }

  const range = offsetsToRange(mapping, best, best + anchor.quote.length);
  if (!range) {
    return null;
  }

  return { range, start: best, end: best + anchor.quote.length };
}

function mergeRects(rects: DOMRect[], canvasRect: DOMRect): HighlightRect[] {
  const items = rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      left: rect.left - canvasRect.left,
      top: rect.top - canvasRect.top,
      width: rect.width,
      height: rect.height,
    }))
    .sort((a, b) => a.top - b.top || a.left - b.left);

  if (!items.length) {
    return [];
  }

  const merged = [items[0]];
  for (let index = 1; index < items.length; index += 1) {
    const previous = merged[merged.length - 1];
    const current = items[index];
    const verticalOverlap = Math.abs(previous.top - current.top) < previous.height * 0.5;
    if (verticalOverlap) {
      const newLeft = Math.min(previous.left, current.left);
      const newRight = Math.max(previous.left + previous.width, current.left + current.width);
      const newTop = Math.min(previous.top, current.top);
      const newBottom = Math.max(previous.top + previous.height, current.top + current.height);
      previous.left = newLeft;
      previous.top = newTop;
      previous.width = newRight - newLeft;
      previous.height = newBottom - newTop;
    } else {
      merged.push(current);
    }
  }

  return merged;
}

function findAnchorAtPoint(x: number, y: number, layer: HTMLElement | null) {
  if (!layer) {
    return null;
  }

  const anchors = layer.querySelectorAll<HTMLElement>('[data-thread-id]');
  for (const anchor of anchors) {
    const rect = anchor.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return anchor.dataset.threadId || null;
    }
  }

  return null;
}

function usePreviewScrollHtmlSync(renderedHtml: string, syncPreviewScroll: () => void) {
  useEffect(() => {
    syncPreviewScroll();
  }, [renderedHtml, syncPreviewScroll]);
}


export function AnchoredCommentCanvas({
  renderedHtml,
  previewScrollRef,
  syncPreviewScroll,
  threads,
  canCreateThread,
  commentsVisible,
  showResolved,
  emptyMessage,
  onRequestCreateThread,
  onReply,
  onResolve,
  onDeleteThread,
  onEditMessage,
  onDeleteMessage,
}: {
  renderedHtml: string;
  previewScrollRef: RefCallback<HTMLDivElement>;
  syncPreviewScroll: () => void;
  threads: Thread[];
  canCreateThread: boolean;
  commentsVisible: boolean;
  showResolved: boolean;
  emptyMessage: string;
  onRequestCreateThread: (anchor: ThreadAnchor) => void;
  onReply: (threadId: string, parentMessageId: string, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onEditMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
}) {
  const previewCanvasRef = useRef<HTMLDivElement | null>(null);
  const previewMarkdownRef = useRef<HTMLDivElement | null>(null);
  const selectionBubbleRef = useRef<HTMLButtonElement | null>(null);
  const commentFabRef = useRef<HTMLButtonElement | null>(null);
  const highlightLayerRef = useRef<HTMLDivElement | null>(null);
  const [positionedThreads, setPositionedThreads] = useState<PositionedThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [dialogThreadId, setDialogThreadId] = useState<string | null>(null);

  const { getAnchor, clearSelection } = usePreviewCommentSelection({
    rootRef: previewMarkdownRef,
    bubbleRef: selectionBubbleRef,
    fabRef: commentFabRef,
    enabled: commentsVisible && canCreateThread,
  });

  usePreviewScrollHtmlSync(renderedHtml, syncPreviewScroll);

  const computeLayout = useCallback(() => {
    if (!commentsVisible) {
      setPositionedThreads([]);
      return;
    }

    const root = previewMarkdownRef.current;
    const canvas = previewCanvasRef.current;
    if (!root || !canvas) {
      setPositionedThreads([]);
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const textMapping = collectTextNodes(root);
    const visibleThreads = [...threads]
      .filter((thread) => showResolved || !thread.resolved)
      .sort((a, b) => {
        const startDelta = a.anchor.start - b.anchor.start;
        if (startDelta !== 0) {
          return startDelta;
        }
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map((thread) => {
        const match = locateAnchor(thread.anchor, root, textMapping);
        if (!match) {
          return null;
        }
        const rects = mergeRects(Array.from(match.range.getClientRects()), canvasRect);
        if (!rects.length) {
          return null;
        }
        return {
          thread,
          highlightRects: rects,
        } satisfies PositionedThread;
      })
      .filter((item): item is PositionedThread => Boolean(item));

    setPositionedThreads(visibleThreads);
  }, [commentsVisible, showResolved, threads]);

  useEffect(() => {
    let frame = requestAnimationFrame(computeLayout);
    const handleResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(computeLayout);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleResize);
    };
  }, [computeLayout, renderedHtml]);

  useEffect(() => {
    if (!commentsVisible) {
      setActiveThreadId(null);
      setDialogThreadId(null);
      clearSelection();
    }
  }, [clearSelection, commentsVisible]);

  useEffect(() => {
    if (activeThreadId && !threads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(null);
    }
    if (dialogThreadId && !threads.some((thread) => thread.id === dialogThreadId)) {
      setDialogThreadId(null);
    }
  }, [activeThreadId, dialogThreadId, threads]);

  const visibleThreads = useMemo(
    () => positionedThreads.map((item) => item.thread),
    [positionedThreads],
  );

  function openThread(threadId: string) {
    setActiveThreadId(threadId);
    setDialogThreadId(threadId);
  }

  function handleCanvasClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!commentsVisible) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest('.selection-bubble, .comment-fab')) {
      return;
    }

    const threadId = findAnchorAtPoint(event.clientX, event.clientY, highlightLayerRef.current);
    if (!threadId) {
      setActiveThreadId(null);
      setDialogThreadId(null);
      return;
    }

    openThread(threadId);
  }

  function handleStartThread() {
    const anchor = getAnchor();
    if (!anchor) {
      return;
    }

    onRequestCreateThread(anchor);
    clearSelection();
  }

  const dialogThread = dialogThreadId ? visibleThreads.find((thread) => thread.id === dialogThreadId) ?? null : null;

  return (
    <>
      <div ref={previewScrollRef} className="preview-scroll">
        <div className="preview-canvas" ref={previewCanvasRef} onClick={handleCanvasClick}>
          <button
            ref={selectionBubbleRef}
            type="button"
            className="selection-bubble"
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleStartThread}
          >
            Add comment
          </button>
          <button
            ref={commentFabRef}
            type="button"
            className="comment-fab"
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleStartThread}
          >
            Add comment
          </button>
          <div ref={highlightLayerRef} className="highlight-layer">
            {commentsVisible ? positionedThreads.flatMap((item) => item.highlightRects.map((rect, index) => (
              <div
                key={`${item.thread.id}-${index}`}
                className={`anchor-highlight ${item.thread.id === activeThreadId ? 'active' : ''}`}
                data-thread-id={item.thread.id}
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                }}
              />
            ))) : null}
          </div>
          <div className="preview-content">
            <div ref={previewMarkdownRef} className="markdown-body" onCopy={handlePreviewCodeCopy} dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            {commentsVisible && visibleThreads.length === 0 ? <p className="empty-state">{emptyMessage}</p> : null}
          </div>
        </div>
      </div>
      {dialogThread ? (
        <div className="modal-backdrop" onClick={() => setDialogThreadId(null)}>
          <div className="modal thread-modal" onClick={(event) => event.stopPropagation()}>
            <div className="thread-modal-close-wrap">
              <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => setDialogThreadId(null)}>
                Close
              </button>
            </div>
            <ThreadCard
              thread={dialogThread}
              active
              className="thread-card--stack"
              onReply={onReply}
              onResolve={onResolve}
              onDeleteThread={onDeleteThread}
              onEditMessage={onEditMessage}
              onDeleteMessage={onDeleteMessage}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ThreadCard({
  thread,
  active = false,
  className = '',
  style,
  onReply,
  onResolve,
  onDeleteThread,
  onEditMessage,
  onDeleteMessage,
}: {
  thread: Thread;
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  onReply: (threadId: string, parentMessageId: string, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onEditMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
}) {
  const messageTree = useMemo(() => buildMessageTree(thread.messages), [thread.messages]);
  const [replyBody, setReplyBody] = useState('');
  const [replyParentId, setReplyParentId] = useState(thread.messages[0]?.id || '');
  const [replying, setReplying] = useState(false);

  async function handleReply() {
    if (!replyBody.trim() || !replyParentId) {
      return;
    }

    setReplying(true);
    try {
      await onReply(thread.id, replyParentId, replyBody);
      setReplyBody('');
    } finally {
      setReplying(false);
    }
  }

  return (
    <div className={`thread-card ${active ? 'active' : ''} ${thread.resolved ? 'resolved' : ''} ${className}`.trim()} style={style}>
      <div className="thread-message-head">
        <strong className="thread-author">“{thread.anchor.quote}”</strong>
        <span className="thread-meta">{formatDate(thread.updatedAt)}</span>
      </div>
      <div className="thread-state">{thread.resolved ? 'Resolved' : 'Open'}</div>
      <div className="thread-tree" style={{ marginTop: '0.75rem' }}>
        {messageTree.map((node) => (
          <ThreadMessageNode
            key={node.message.id}
            node={node}
            canReply={thread.canReply}
            activeReplyTargetId={replyParentId}
            onReplyTarget={(messageId) => setReplyParentId(messageId)}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
          />
        ))}
      </div>
      <div className="thread-footer">
        {thread.canResolve ? (
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => void onResolve(thread.id, !thread.resolved)}>
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </button>
        ) : null}
        {thread.canDeleteThread ? (
          <button type="button" className="documine-btn documine-btn--sm documine-btn--danger" onClick={() => void onDeleteThread(thread.id)}>
            Delete thread
          </button>
        ) : null}
      </div>
      {thread.canReply ? (
        <div className="compact" style={{ marginTop: '0.75rem' }}>
          {replyParentId ? <div className="reply-target-note">Replying to selected comment</div> : null}
          <div className="field">
            <textarea
              value={replyBody}
              onChange={(event) => setReplyBody(event.target.value)}
              onKeyDown={(event) => handleCommentTextareaKeyDown(event, !replying && !!replyBody.trim(), () => void handleReply())}
              placeholder="Reply"
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="primary" onClick={() => void handleReply()} disabled={replying || !replyBody.trim()}>
              {replying ? 'Saving...' : 'Reply'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type MessageTreeNode = {
  message: ThreadMessage;
  children: MessageTreeNode[];
};

function buildMessageTree(messages: ThreadMessage[]) {
  const nodeMap = new Map<string, MessageTreeNode>();
  const roots: MessageTreeNode[] = [];

  for (const message of messages) {
    nodeMap.set(message.id, { message, children: [] });
  }

  for (const message of messages) {
    const node = nodeMap.get(message.id);
    if (!node) {
      continue;
    }

    if (message.parentId && nodeMap.has(message.parentId)) {
      nodeMap.get(message.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function ThreadMessageNode({
  node,
  canReply,
  activeReplyTargetId,
  onReplyTarget,
  onEditMessage,
  onDeleteMessage,
  depth = 0,
}: {
  node: MessageTreeNode;
  canReply: boolean;
  activeReplyTargetId: string;
  onReplyTarget: (messageId: string) => void;
  onEditMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  depth?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.message.body);

  async function handleSaveEdit() {
    await onEditMessage(node.message.id, draft);
    setEditing(false);
  }

  return (
    <div className="thread-node" style={{ ['--depth' as string]: depth }}>
      <div className={`thread-message ${depth === 0 ? 'thread-message-root' : 'thread-message-reply'} ${activeReplyTargetId === node.message.id ? 'thread-message-targeted' : ''}`}>
        <div className="thread-message-head">
          <strong className="thread-author thread-author-small">{node.message.authorName}</strong>
          <span className="thread-meta">{formatDate(node.message.updatedAt)}</span>
        </div>
        {editing ? (
          <div className="compact">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => void handleSaveEdit()} disabled={!draft.trim()}>
                Save
              </button>
              <button type="button" className="ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="thread-body thread-body-small">{node.message.body}</div>
        )}
        <div className="thread-message-actions">
          {canReply ? (
            <button type="button" className="documine-btn documine-btn--link" onClick={() => onReplyTarget(node.message.id)}>
              {activeReplyTargetId === node.message.id ? 'Replying here' : 'Reply here'}
            </button>
          ) : null}
          {node.message.canEdit ? (
            <button type="button" className="documine-btn documine-btn--link" onClick={() => setEditing((current) => !current)}>
              Edit
            </button>
          ) : null}
          {node.message.canDelete ? (
            <button type="button" className="documine-btn documine-btn--link" onClick={() => void onDeleteMessage(node.message.id)}>
              Delete
            </button>
          ) : null}
        </div>
      </div>
      {node.children.length > 0 ? (
        <div className="thread-children">
          {node.children.map((child) => (
            <ThreadMessageNode
              key={child.message.id}
              node={child}
              canReply={canReply}
              activeReplyTargetId={activeReplyTargetId}
              depth={depth + 1}
              onReplyTarget={onReplyTarget}
              onEditMessage={onEditMessage}
              onDeleteMessage={onDeleteMessage}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}


