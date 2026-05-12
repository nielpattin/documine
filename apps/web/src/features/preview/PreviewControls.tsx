import { formatDurationMs } from '../../lib/format';
import type { PreviewMode } from '../../hooks/usePreviewScrollSyncController';
import { RENDERED_PDF_ZOOM_MAX, RENDERED_PDF_ZOOM_MIN } from '../../pages/page-utils';

export function PreviewControls({
  previewMode,
  onPreviewModeChange,
  renderedPdfLoading,
  renderedPdfDirty,
  renderedPdfElapsedMs,
  renderedPdfLastDurationMs,
  renderedPdfZoom,
  onRenderedPdfZoomOut,
  onRenderedPdfZoomReset,
  onRenderedPdfZoomIn,
  showCopyButton = false,
  copyPreviewStatus = 'Copy',
  onCopyRenderedPreview,
  onClosePreview,
}: {
  previewMode: PreviewMode;
  onPreviewModeChange: (mode: PreviewMode) => void;
  renderedPdfLoading: boolean;
  renderedPdfDirty: boolean;
  renderedPdfElapsedMs: number;
  renderedPdfLastDurationMs: number | null;
  renderedPdfZoom: number;
  onRenderedPdfZoomOut: () => void;
  onRenderedPdfZoomReset: () => void;
  onRenderedPdfZoomIn: () => void;
  showCopyButton?: boolean;
  copyPreviewStatus?: string;
  onCopyRenderedPreview?: () => void;
  onClosePreview: () => void;
}) {
  return (
    <div className="preview-controls">
      <div className="preview-mode-toggle">
        <button type="button" className={`documine-btn documine-btn--sm ${previewMode === 'markdown' ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => onPreviewModeChange('markdown')}>
          Markdown
        </button>
        <button type="button" className={`documine-btn documine-btn--sm ${previewMode === 'rendered-pdf' ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => onPreviewModeChange('rendered-pdf')}>
          Print preview
        </button>
      </div>
      {previewMode === 'rendered-pdf' ? (
        <>
          <span className="pdf-preview-note pdf-preview-note--inline">
            {renderedPdfLoading
              ? `Refreshing preview... ${formatDurationMs(renderedPdfElapsedMs)}`
              : renderedPdfDirty
                ? 'Waiting for typing to pause before refreshing.'
                : renderedPdfLastDurationMs !== null
                  ? `Last refresh: ${formatDurationMs(renderedPdfLastDurationMs)}`
                  : 'Auto-refreshes after a short idle delay.'}
          </span>
          {showCopyButton && onCopyRenderedPreview ? (
            <button type="button" className="documine-btn documine-btn--sm documine-btn--primary" onClick={onCopyRenderedPreview} disabled={renderedPdfLoading}>
              {copyPreviewStatus}
            </button>
          ) : null}
          <div className="pdf-preview-zoom-controls" aria-label="Preview zoom controls">
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onRenderedPdfZoomOut} disabled={renderedPdfZoom <= RENDERED_PDF_ZOOM_MIN} aria-label="Zoom out preview">
              -
            </button>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost pdf-preview-zoom-value" onClick={onRenderedPdfZoomReset} aria-label="Reset preview zoom">
              {renderedPdfZoom}%
            </button>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onRenderedPdfZoomIn} disabled={renderedPdfZoom >= RENDERED_PDF_ZOOM_MAX} aria-label="Zoom in preview">
              +
            </button>
          </div>
        </>
      ) : null}
      <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost preview-close-btn" onClick={onClosePreview}>
        Close
      </button>
    </div>
  );
}
