import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteNotePdf, getApiHttpOrigin, listNotePdfExports, saveNotePdf, createExportShareToken, revokeExportShareToken, apiRequest, formatDate, type NotePdfExport, type PdfExportSettings, type PdfExportSettingsPayload, type PdfExportCodeWrapMode, type PdfExportHeaderMode, type PdfExportImageAlignment } from '../../lib/api';

export function PdfExportModal({ noteId, markdown, onClose }: { noteId: string; markdown: string; onClose: () => void }) {
  const [payload, setPayload] = useState<PdfExportSettingsPayload | null>(null);
  const [settings, setSettings] = useState<PdfExportSettings | null>(null);
  const [exportsList, setExportsList] = useState<NotePdfExport[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [confirmDeleteExport, setConfirmDeleteExport] = useState<string | null>(null);
  const [deletingExport, setDeletingExport] = useState<string | null>(null);
  const [generatingShareToken, setGeneratingShareToken] = useState<string | null>(null);
  const [revokingShareToken, setRevokingShareToken] = useState<string | null>(null);
  const [copiedShareToken, setCopiedShareToken] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiOrigin = getApiHttpOrigin();

  const loadExports = useCallback(async () => {
    const response = await listNotePdfExports(noteId);
    setExportsList(response.exports);
  }, [noteId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const [nextPayload, nextExports] = await Promise.all([
          apiRequest<PdfExportSettingsPayload>('/api/export/settings'),
          listNotePdfExports(noteId),
        ]);
        if (cancelled) {
          return;
        }
        setPayload(nextPayload);
        setSettings(nextPayload.settings);
        setExportsList(nextExports.exports);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Failed to load PDF export settings.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  function updateSettings(patch: Partial<PdfExportSettings>) {
    setSettings((current) => current ? { ...current, ...patch } : current);
  }

  function updateMargins(side: 'top' | 'right' | 'bottom' | 'left', value: number) {
    setSettings((current) => current ? {
      ...current,
      marginsCm: { ...current.marginsCm, [side]: value },
    } : current);
  }

  async function handleSaveDefaults() {
    if (!settings) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      const nextPayload = await apiRequest<PdfExportSettingsPayload>('/api/export/settings', {
        method: 'PUT',
        body: { settings },
      });
      setPayload(nextPayload);
      setSettings(nextPayload.settings);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save defaults.');
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    if (!settings) {
      return;
    }
    setExporting(true);
    setError('');
    try {
      const response = await saveNotePdf(noteId, markdown, settings);
      setExportsList(response.exports);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to export PDF.');
    } finally {
      setExporting(false);
    }
  }

  function openExport(item: NotePdfExport) {
    window.open(`${apiOrigin}${item.url}`, '_blank', 'noopener,noreferrer');
  }

  function downloadExport(item: NotePdfExport) {
    const anchor = document.createElement('a');
    anchor.href = `${apiOrigin}${item.downloadUrl}`;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function openDebug(item: NotePdfExport) {
    window.open(`${apiOrigin}${item.debugHtmlUrl}`, '_blank', 'noopener,noreferrer');
  }

  async function handleDeleteExport(item: NotePdfExport) {
    setDeletingExport(item.fileName);
    setError('');
    try {
      const response = await deleteNotePdf(noteId, item.fileName);
      setExportsList(response.exports);
      setConfirmDeleteExport((current) => (current === item.fileName ? null : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to delete export PDF.');
    } finally {
      setDeletingExport((current) => (current === item.fileName ? null : current));
    }
  }

  async function handleGenerateShareToken(item: NotePdfExport) {
    setGeneratingShareToken(item.fileName);
    setError('');
    try {
      await createExportShareToken(noteId, item.fileName);
      const response = await listNotePdfExports(noteId);
      setExportsList(response.exports);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to generate share link.');
    } finally {
      setGeneratingShareToken((current) => (current === item.fileName ? null : current));
    }
  }

  async function handleRevokeShareToken(item: NotePdfExport) {
    setRevokingShareToken(item.fileName);
    setError('');
    try {
      await revokeExportShareToken(noteId, item.fileName);
      const response = await listNotePdfExports(noteId);
      setExportsList(response.exports);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to revoke share link.');
    } finally {
      setRevokingShareToken((current) => (current === item.fileName ? null : current));
    }
  }

  async function handleCopyShareUrl(item: NotePdfExport) {
    if (!item.shareUrl) {
      return;
    }
    const fullUrl = `${apiOrigin}${item.shareUrl}`;
    await navigator.clipboard.writeText(fullUrl).catch(() => undefined);
    setCopiedShareToken(item.fileName);
    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = setTimeout(() => setCopiedShareToken(null), 2000);
  }

  function formatFileSize(bytes: number) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (loading) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal pdf-export-modal" onClick={(event) => event.stopPropagation()}>
          <div className="pdf-export-header">
            <div className="pdf-export-header-left">
              <h2 className="pdf-export-title">Print to PDF</h2>
            </div>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>Close</button>
          </div>
          <div className="pdf-export-content">
            <p className="pdf-export-loading">Loading export settings...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!payload || !settings) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal pdf-export-modal" onClick={(event) => event.stopPropagation()}>
          <div className="pdf-export-header">
            <div className="pdf-export-header-left">
              <h2 className="pdf-export-title">Print to PDF</h2>
            </div>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>Close</button>
          </div>
          <div className="pdf-export-content">
            <div className="inline-error">{error || 'Export settings unavailable.'}</div>
          </div>
        </div>
      </div>
    );
  }

  const engineUnavailable = !payload.capabilities.pandoc;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal pdf-export-modal" onClick={(event) => event.stopPropagation()}>
        <div className="pdf-export-header">
          <div className="pdf-export-header-left">
            <h2 className="pdf-export-title">Print to PDF</h2>
          </div>
          <div className="pdf-export-actions">
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => setSettings(payload.settings)} disabled={saving || exporting}>
              Reset
            </button>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => void handleSaveDefaults()} disabled={saving || exporting}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--primary" onClick={() => void handleExport()} disabled={engineUnavailable || exporting || saving}>
              {exporting ? 'Saving PDF...' : 'Save PDF'}
            </button>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="pdf-export-content">
          {!payload.capabilities.pandoc ? (
            <div className="inline-error">Pandoc is not available on this server. Install it locally or in Docker to enable PDF export.</div>
          ) : null}
          {error ? <div className="inline-error">{error}</div> : null}

          <section className="pdf-export-section">
            <div className="pdf-export-section-header-row">
              <h3 className="pdf-export-section-title">Recent exports</h3>
              <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => void loadExports()} disabled={exporting || saving}>
                Refresh
              </button>
            </div>
            {exportsList.length === 0 ? (
              <p className="pdf-export-loading">No PDFs saved yet.</p>
            ) : (
              <div className="pdf-export-history-list">
                {exportsList.map((item) => (
                  <div key={item.fileName} className="pdf-export-history-row">
                    <div className="pdf-export-history-info">
                      <div className="pdf-export-history-title">{item.fileName}</div>
                      <div className="pdf-export-history-meta">{formatDate(item.createdAt)} · {formatFileSize(item.size)}</div>
                    </div>
                    <div className="pdf-export-history-actions">
                      <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => openExport(item)}>Open</button>
                      <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => downloadExport(item)}>Download</button>
                      <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => openDebug(item)}>Debug</button>
                      {item.shareUrl ? (
                        <>
                          <button type="button" className="documine-btn documine-btn--sm documine-btn--primary" onClick={() => void handleCopyShareUrl(item)}>
                            {copiedShareToken === item.fileName ? 'Copied!' : 'Copy link'}
                          </button>
                          <button type="button" className="documine-btn documine-btn--sm documine-btn--danger" disabled={revokingShareToken === item.fileName} onClick={() => void handleRevokeShareToken(item)}>
                            {revokingShareToken === item.fileName ? 'Revoking...' : 'Revoke'}
                          </button>
                        </>
                      ) : (
                        <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" disabled={generatingShareToken === item.fileName} onClick={() => void handleGenerateShareToken(item)}>
                          {generatingShareToken === item.fileName ? 'Generating...' : 'Share'}
                        </button>
                      )}
                      {confirmDeleteExport === item.fileName ? (
                        <div className="image-asset-confirm-delete">
                          <button
                            type="button"
                            className="documine-btn documine-btn--sm documine-btn--ghost"
                            onClick={() => setConfirmDeleteExport(null)}
                            disabled={deletingExport === item.fileName}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="documine-btn documine-btn--sm documine-btn--danger"
                            onClick={() => void handleDeleteExport(item)}
                            disabled={deletingExport === item.fileName}
                          >
                            {deletingExport === item.fileName ? 'Deleting...' : 'Delete'}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="documine-btn documine-btn--sm documine-btn--danger"
                          onClick={() => setConfirmDeleteExport(item.fileName)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Page setup</h3>
            <div className="pdf-export-grid">
              <label className="pdf-export-field">
                <span>Paper size</span>
                <select value={settings.pageSize} onChange={(event) => updateSettings({ pageSize: event.target.value as PdfExportSettings['pageSize'] })}>
                  {payload.capabilities.pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
              <label className="pdf-export-field">
                <span>Orientation</span>
                <select value={settings.orientation} onChange={(event) => updateSettings({ orientation: event.target.value as PdfExportSettings['orientation'] })}>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </label>
            </div>
            <div className="pdf-export-margins">
              <span className="pdf-export-field-label">Margins (cm)</span>
              <div className="pdf-export-margins-grid">
                <label><span>Top</span><input type="number" min={0.5} max={5} step={0.1} value={settings.marginsCm.top} onChange={(event) => updateMargins('top', Number(event.target.value) || settings.marginsCm.top)} /></label>
                <label><span>Right</span><input type="number" min={0.5} max={5} step={0.1} value={settings.marginsCm.right} onChange={(event) => updateMargins('right', Number(event.target.value) || settings.marginsCm.right)} /></label>
                <label><span>Bottom</span><input type="number" min={0.5} max={5} step={0.1} value={settings.marginsCm.bottom} onChange={(event) => updateMargins('bottom', Number(event.target.value) || settings.marginsCm.bottom)} /></label>
                <label><span>Left</span><input type="number" min={0.5} max={5} step={0.1} value={settings.marginsCm.left} onChange={(event) => updateMargins('left', Number(event.target.value) || settings.marginsCm.left)} /></label>
              </div>
            </div>
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Typography</h3>
            <div className="pdf-export-grid">
              <label className="pdf-export-field">
                <span>Font family</span>
                <select value={settings.fontFamily} onChange={(event) => updateSettings({ fontFamily: event.target.value as PdfExportSettings['fontFamily'] })}>
                  {payload.capabilities.fontFamilies.map((family) => <option key={family} value={family}>{family}</option>)}
                </select>
              </label>
              <label className="pdf-export-field">
                <span>Style preset</span>
                <select value={settings.stylePreset} onChange={(event) => updateSettings({ stylePreset: event.target.value as PdfExportSettings['stylePreset'] })}>
                  {payload.capabilities.styles.map((style) => <option key={style} value={style}>{style}</option>)}
                </select>
              </label>
              <label className="pdf-export-field">
                <span>Font size (pt)</span>
                <input type="number" min={9} max={18} step={0.5} value={settings.fontSizePt} onChange={(event) => updateSettings({ fontSizePt: Number(event.target.value) || settings.fontSizePt })} />
              </label>
              <label className="pdf-export-field">
                <span>Line height</span>
                <input type="number" min={1.1} max={2} step={0.05} value={settings.lineHeight} onChange={(event) => updateSettings({ lineHeight: Number(event.target.value) || settings.lineHeight })} />
              </label>
            </div>
            <div className="pdf-export-toggles">
              <label className="pdf-export-checkbox"><input type="checkbox" checked={settings.justifyText} onChange={(event) => updateSettings({ justifyText: event.target.checked })} /> Justify paragraphs</label>
            </div>
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Content</h3>
            <div className="pdf-export-grid">
              <label className="pdf-export-field">
                <span>Header</span>
                <select value={settings.headerMode} onChange={(event) => updateSettings({ headerMode: event.target.value as PdfExportHeaderMode })}>
                  {payload.capabilities.headerModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              </label>
            </div>
            <div className="pdf-export-toggles">
              <label className="pdf-export-checkbox"><input type="checkbox" checked={settings.toc} onChange={(event) => updateSettings({ toc: event.target.checked })} /> Include table of contents</label>
              <label className="pdf-export-checkbox"><input type="checkbox" checked={settings.includeTitle} onChange={(event) => updateSettings({ includeTitle: event.target.checked })} /> Include note title</label>
              <label className="pdf-export-checkbox"><input type="checkbox" checked={settings.includeDate} onChange={(event) => updateSettings({ includeDate: event.target.checked })} /> Include export date</label>
            </div>
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Images</h3>
            <div className="pdf-export-grid">
              <label className="pdf-export-field">
                <span>Max width %</span>
                <input type="number" min={30} max={100} step={5} value={settings.imageMaxWidthPercent} onChange={(event) => updateSettings({ imageMaxWidthPercent: Number(event.target.value) || settings.imageMaxWidthPercent })} />
              </label>
              <label className="pdf-export-field">
                <span>Alignment</span>
                <select value={settings.imageAlign} onChange={(event) => updateSettings({ imageAlign: event.target.value as PdfExportImageAlignment })}>
                  {payload.capabilities.imageAlignments.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
                </select>
              </label>
            </div>
            <p className="pdf-export-hint-text">
              Per-image overrides: <code>{'![alt](image.png){width="4in" height="3in"}'}</code>
            </p>
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Code blocks</h3>
            <label className="pdf-export-field">
              <span>Line wrapping</span>
              <select value={settings.codeWrap} onChange={(event) => updateSettings({ codeWrap: event.target.value as PdfExportCodeWrapMode })}>
                {payload.capabilities.codeWrapModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </select>
            </label>
          </section>

          <div className="pdf-export-footer">
            Engine: Browser PDF · Defaults saved to instance data
          </div>
        </div>
      </div>
    </div>
  );
}

