import { useCallback, useEffect, useRef, useState } from 'react';

export type PreviewMode = 'markdown' | 'rendered-pdf';

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export type PreviewScrollAnchor = {
  quote: string;
  start: number;
  end: number;
  heading: { text: string; level: number } | null;
};

export type ScrollSyncContext = {
  metrics: ScrollMetrics;
  anchor: PreviewScrollAnchor | null;
};

function getStoredPreviewScrollSyncEnabled() {
  const value = window.localStorage.getItem('documine_preview_scroll_sync');
  return value == null ? true : value !== 'off';
}

function setStoredPreviewScrollSyncEnabled(enabled: boolean) {
  window.localStorage.setItem('documine_preview_scroll_sync', enabled ? 'on' : 'off');
}

function getSyncedScrollTop(metrics: ScrollMetrics, targetScrollHeight: number, targetClientHeight: number) {
  const sourceScrollable = Math.max(1, metrics.scrollHeight - metrics.clientHeight);
  const targetScrollable = Math.max(0, targetScrollHeight - targetClientHeight);
  if (targetScrollable === 0) {
    return 0;
  }
  const ratio = Math.min(1, Math.max(0, metrics.scrollTop / sourceScrollable));
  return Math.round(ratio * targetScrollable);
}

export function usePreviewScrollSyncController(previewMode: PreviewMode) {
  const [scrollWithMarkdownEnabled, setScrollWithMarkdownEnabled] = useState(() => getStoredPreviewScrollSyncEnabled());
  const scrollWithMarkdownEnabledRef = useRef(scrollWithMarkdownEnabled);
  const previewModeRef = useRef(previewMode);
  const markdownPreviewNodeRef = useRef<HTMLDivElement | null>(null);
  const pdfFrameNodeRef = useRef<HTMLIFrameElement | null>(null);
  const pdfFrameLoadCleanupRef = useRef<(() => void) | null>(null);
  const pdfFrameScrollCleanupRef = useRef<(() => void) | null>(null);
  const currentScrollContextRef = useRef<ScrollSyncContext | null>(null);
  const markdownPreviewLockedRef = useRef(false);
  const pdfPreviewLockedRef = useRef(false);
  const previewProgrammaticScrollRef = useRef(false);
  const manualMarkdownScrollTopRef = useRef(0);
  const manualPdfScrollTopRef = useRef(0);

  scrollWithMarkdownEnabledRef.current = scrollWithMarkdownEnabled;
  previewModeRef.current = previewMode;

  const detachPdfFrameScrollTracking = useCallback(() => {
    pdfFrameScrollCleanupRef.current?.();
    pdfFrameScrollCleanupRef.current = null;
  }, []);

  const attachPdfFrameScrollTracking = useCallback((frame: HTMLIFrameElement) => {
    const contentWindow = frame.contentWindow;
    const contentDocument = frame.contentDocument;
    const scroller = contentDocument?.scrollingElement || contentDocument?.documentElement || contentDocument?.body || null;
    if (!contentWindow || !contentDocument || !scroller) {
      return;
    }

    const handleScroll = () => {
      if (previewProgrammaticScrollRef.current) {
        return;
      }
      pdfPreviewLockedRef.current = true;
      manualPdfScrollTopRef.current = scroller.scrollTop;
    };

    contentWindow.addEventListener('scroll', handleScroll, { passive: true });
    contentDocument.addEventListener('scroll', handleScroll, { passive: true });
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    pdfFrameScrollCleanupRef.current = () => {
      contentWindow.removeEventListener('scroll', handleScroll);
      contentDocument.removeEventListener('scroll', handleScroll);
      scroller.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const handleMarkdownPreviewScroll = useCallback(() => {
    if (previewProgrammaticScrollRef.current) {
      return;
    }
    const preview = markdownPreviewNodeRef.current;
    if (preview) {
      markdownPreviewLockedRef.current = true;
      manualMarkdownScrollTopRef.current = preview.scrollTop;
    }
  }, []);

  const syncMarkdownPreviewScroll = useCallback((context?: ScrollSyncContext | null) => {
    const preview = markdownPreviewNodeRef.current;
    if (!preview) {
      return;
    }

    const nextContext = context ?? currentScrollContextRef.current;
    previewProgrammaticScrollRef.current = true;

    if (nextContext?.metrics.scrollTop === 0) {
      manualMarkdownScrollTopRef.current = 0;
      preview.scrollTop = 0;
      requestAnimationFrame(() => {
        previewProgrammaticScrollRef.current = false;
      });
      return;
    }

    if (scrollWithMarkdownEnabledRef.current && !markdownPreviewLockedRef.current && nextContext) {
      const targetScrollTop = getSyncedScrollTop(nextContext.metrics, preview.scrollHeight, preview.clientHeight);
      manualMarkdownScrollTopRef.current = targetScrollTop;
      preview.scrollTop = targetScrollTop;
      requestAnimationFrame(() => {
        previewProgrammaticScrollRef.current = false;
      });
      return;
    }

    preview.scrollTop = manualMarkdownScrollTopRef.current;
    requestAnimationFrame(() => {
      previewProgrammaticScrollRef.current = false;
    });
  }, []);

  const syncPdfPreviewScroll = useCallback((context?: ScrollSyncContext | null) => {
    const frame = pdfFrameNodeRef.current;
    if (!frame) {
      return;
    }

    const contentDocument = frame.contentDocument;
    const contentWindow = frame.contentWindow;
    const scroller = contentDocument?.scrollingElement || contentDocument?.documentElement || contentDocument?.body || null;
    if (!contentDocument || !contentWindow || !scroller) {
      return;
    }

    const nextContext = context ?? currentScrollContextRef.current;
    previewProgrammaticScrollRef.current = true;

    if (nextContext?.metrics.scrollTop === 0) {
      manualPdfScrollTopRef.current = 0;
      scroller.scrollTop = 0;
      contentWindow.scrollTo(0, 0);
      requestAnimationFrame(() => {
        previewProgrammaticScrollRef.current = false;
      });
      return;
    }

    if (scrollWithMarkdownEnabledRef.current && !pdfPreviewLockedRef.current && nextContext) {
      const targetScrollTop = getSyncedScrollTop(nextContext.metrics, scroller.scrollHeight, scroller.clientHeight);
      manualPdfScrollTopRef.current = targetScrollTop;
      scroller.scrollTop = targetScrollTop;
      contentWindow.scrollTo(0, targetScrollTop);
      requestAnimationFrame(() => {
        previewProgrammaticScrollRef.current = false;
      });
      return;
    }

    scroller.scrollTop = manualPdfScrollTopRef.current;
    contentWindow.scrollTo(0, manualPdfScrollTopRef.current);
    requestAnimationFrame(() => {
      previewProgrammaticScrollRef.current = false;
    });
  }, []);

  const syncPreviewScroll = useCallback((context?: ScrollSyncContext | null, targetMode: PreviewMode = previewModeRef.current) => {
    if (targetMode === 'rendered-pdf') {
      syncPdfPreviewScroll(context);
      return;
    }
    syncMarkdownPreviewScroll(context);
  }, [syncMarkdownPreviewScroll, syncPdfPreviewScroll]);

  const previewScrollRef = useCallback((node: HTMLDivElement | null) => {
    const current = markdownPreviewNodeRef.current;
    if (current) {
      current.removeEventListener('scroll', handleMarkdownPreviewScroll);
    }
    markdownPreviewNodeRef.current = node;
    if (node) {
      manualMarkdownScrollTopRef.current = node.scrollTop;
      node.addEventListener('scroll', handleMarkdownPreviewScroll, { passive: true });
      syncMarkdownPreviewScroll();
    }
  }, [handleMarkdownPreviewScroll, syncMarkdownPreviewScroll]);

  const pdfPreviewFrameRef = useCallback((node: HTMLIFrameElement | null) => {
    pdfFrameLoadCleanupRef.current?.();
    pdfFrameLoadCleanupRef.current = null;
    detachPdfFrameScrollTracking();
    pdfFrameNodeRef.current = node;
    if (!node) {
      return;
    }

    const handleLoad = () => {
      detachPdfFrameScrollTracking();
      attachPdfFrameScrollTracking(node);
      syncPdfPreviewScroll(currentScrollContextRef.current);
    };

    node.addEventListener('load', handleLoad);
    pdfFrameLoadCleanupRef.current = () => node.removeEventListener('load', handleLoad);

    if (node.contentDocument?.readyState === 'complete') {
      handleLoad();
    }
  }, [attachPdfFrameScrollTracking, detachPdfFrameScrollTracking, syncPdfPreviewScroll]);

  const handleEditorScrollChange = useCallback((context: ScrollSyncContext) => {
    currentScrollContextRef.current = context;
    if (scrollWithMarkdownEnabledRef.current) {
      if (previewModeRef.current === 'rendered-pdf') {
        pdfPreviewLockedRef.current = false;
      } else {
        markdownPreviewLockedRef.current = false;
      }
      syncPreviewScroll(context);
    }
  }, [syncPreviewScroll]);

  const toggleScrollWithMarkdown = useCallback(() => {
    const nextEnabled = !scrollWithMarkdownEnabledRef.current;
    scrollWithMarkdownEnabledRef.current = nextEnabled;
    setScrollWithMarkdownEnabled(nextEnabled);
    setStoredPreviewScrollSyncEnabled(nextEnabled);
    if (nextEnabled) {
      if (previewModeRef.current === 'rendered-pdf') {
        pdfPreviewLockedRef.current = false;
      } else {
        markdownPreviewLockedRef.current = false;
      }
      requestAnimationFrame(() => syncPreviewScroll());
    }
  }, [syncPreviewScroll]);

  useEffect(() => {
    syncPreviewScroll(currentScrollContextRef.current);
  }, [previewMode, syncPreviewScroll]);

  return {
    scrollWithMarkdownEnabled,
    previewScrollRef,
    pdfPreviewFrameRef,
    pdfPreviewFrameNodeRef: pdfFrameNodeRef,
    handleEditorScrollChange,
    toggleScrollWithMarkdown,
    syncPreviewScroll,
  };
}

