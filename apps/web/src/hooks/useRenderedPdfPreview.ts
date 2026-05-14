import { useCallback, useEffect, useRef, useState } from "react";
import {
  RENDERED_PDF_ZOOM_DEFAULT,
  RENDERED_PDF_ZOOM_MAX,
  RENDERED_PDF_ZOOM_MIN,
  RENDERED_PDF_ZOOM_STEP,
} from "../pages/page-utils";
import type { PreviewMode } from "./usePreviewScrollSyncController";

type UseRenderedPdfPreviewArgs = {
  markdown: string;
  noteKey: string;
  previewMode: PreviewMode;
  showPreview: boolean;
  renderPreview: () => Promise<Blob>;
};

export function useRenderedPdfPreview({
  markdown,
  noteKey,
  previewMode,
  showPreview,
  renderPreview,
}: UseRenderedPdfPreviewArgs) {
  const [renderedPdfUrl, setRenderedPdfUrl] = useState("");
  const [renderedPdfZoom, setRenderedPdfZoom] = useState(RENDERED_PDF_ZOOM_DEFAULT);
  const [renderedPdfLoading, setRenderedPdfLoading] = useState(false);
  const [renderedPdfError, setRenderedPdfError] = useState("");
  const [renderedPdfDirty, setRenderedPdfDirty] = useState(false);
  const [renderedPdfElapsedMs, setRenderedPdfElapsedMs] = useState(0);
  const [renderedPdfLastDurationMs, setRenderedPdfLastDurationMs] = useState<number | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    setRenderedPdfDirty(true);
  }, [markdown, noteKey]);

  useEffect(() => {
    if (!showPreview || previewMode !== "rendered-pdf") {
      setRenderedPdfLoading(false);
      setRenderedPdfError("");
      return;
    }

    const shouldRefresh = !renderedPdfUrl || renderedPdfDirty;
    if (!shouldRefresh) {
      setRenderedPdfError("");
      return;
    }

    const delayMs = !renderedPdfUrl ? 0 : 600;
    const requestId = ++requestIdRef.current;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled) {
        return;
      }
      const startedAt = performance.now();
      setRenderedPdfLoading(true);
      setRenderedPdfElapsedMs(0);
      setRenderedPdfError("");
      try {
        const blob = await renderPreview();
        if (cancelled || requestIdRef.current !== requestId) {
          return;
        }
        const nextUrl = URL.createObjectURL(blob);
        setRenderedPdfUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return nextUrl;
        });
        setRenderedPdfDirty(false);
        setRenderedPdfLastDurationMs(Math.round(performance.now() - startedAt));
      } catch (cause) {
        if (!cancelled && requestIdRef.current === requestId) {
          setRenderedPdfError(cause instanceof Error ? cause.message : "Failed to render preview.");
          setRenderedPdfLastDurationMs(Math.round(performance.now() - startedAt));
        }
      } finally {
        if (!cancelled && requestIdRef.current === requestId) {
          setRenderedPdfLoading(false);
        }
      }
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [previewMode, renderPreview, renderedPdfDirty, renderedPdfUrl, showPreview]);

  useEffect(() => {
    if (!renderedPdfLoading) {
      return;
    }

    const startedAt = performance.now();
    const interval = window.setInterval(() => {
      setRenderedPdfElapsedMs(Math.round(performance.now() - startedAt));
    }, 100);

    return () => window.clearInterval(interval);
  }, [renderedPdfLoading]);

  useEffect(() => {
    return () => {
      if (renderedPdfUrl) {
        URL.revokeObjectURL(renderedPdfUrl);
      }
    };
  }, [renderedPdfUrl]);

  const renderedPdfZoomOut = useCallback(() => {
    setRenderedPdfZoom((current) => Math.max(RENDERED_PDF_ZOOM_MIN, current - RENDERED_PDF_ZOOM_STEP));
  }, []);

  const renderedPdfZoomIn = useCallback(() => {
    setRenderedPdfZoom((current) => Math.min(RENDERED_PDF_ZOOM_MAX, current + RENDERED_PDF_ZOOM_STEP));
  }, []);

  const renderedPdfZoomReset = useCallback(() => {
    setRenderedPdfZoom(RENDERED_PDF_ZOOM_DEFAULT);
  }, []);

  const markRenderedPdfDirty = useCallback(() => {
    setRenderedPdfDirty(true);
  }, []);

  return {
    renderedPdfUrl,
    renderedPdfZoom,
    renderedPdfLoading,
    renderedPdfError,
    renderedPdfDirty,
    renderedPdfElapsedMs,
    renderedPdfLastDurationMs,
    renderedPdfZoomOut,
    renderedPdfZoomIn,
    renderedPdfZoomReset,
    markRenderedPdfDirty,
  };
}
