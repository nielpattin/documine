import { useState, type FormEvent, type KeyboardEvent, type RefCallback } from 'react';
import { apiRequest, formatDate, type NoteAsset, type ThreadAnchor } from '../lib/api';

export type AgentModalConfig = {
  title: string;
  hint: string;
  requiresApiKey?: boolean;
  buildInstructions: (apiKey: string | null) => string;
};

export function AgentSetupModal({
  config,
  onClose,
  initialApiKey = null,
  onApiKeyGenerated,
}: {
  config: AgentModalConfig;
  onClose: () => void;
  initialApiKey?: string | null;
  onApiKeyGenerated?: (apiKey: string) => void;
}) {
  const [apiKey, setApiKey] = useState<string | null>(initialApiKey);
  const [isGenerating, setIsGenerating] = useState(false);
  const instructions = config.buildInstructions(apiKey);

  async function generateApiKey() {
    setIsGenerating(true);
    try {
      const payload = await apiRequest<{ ok: true; id: string; key: string }>(`/api/keys`, {
        method: 'POST',
        body: { label: 'agent-cli' },
      });
      setApiKey(payload.key);
      onApiKeyGenerated?.(payload.key);
    } finally {
      setIsGenerating(false);
    }
  }

  async function copyInstructions() {
    await navigator.clipboard.writeText(instructions);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal agent-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-title">{config.title}</h2>
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="agent-hint">{config.hint}</p>
        {config.requiresApiKey ? (
          <>
            <div className="modal-actions" style={{ marginBottom: '0.75rem' }}>
              <button type="button" className="documine-btn documine-btn--md documine-btn--primary" onClick={() => void generateApiKey()} disabled={isGenerating}>
                {isGenerating ? 'Generating...' : apiKey ? 'Generate another API key' : 'Generate API key'}
              </button>
            </div>
            {apiKey ? <pre className="agent-instructions"><code>{apiKey}</code></pre> : null}
          </>
        ) : null}
        <pre className="agent-instructions"><code>{instructions}</code></pre>
        <button type="button" className="documine-btn documine-btn--md documine-btn--primary" onClick={() => void copyInstructions()} disabled={Boolean(config.requiresApiKey && !apiKey)}>
          Copy to clipboard
        </button>
      </div>
    </div>
  );
}

export function LoadingPage({ message }: { message: string }) {
  return (
    <div className="page-shell simple-page">
      <div className="simple-page-content">
        <p>{message}...</p>
      </div>
    </div>
  );
}

export function OwnerAuthGuardToast({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) {
    return null;
  }

  return (
    <div className="auth-guard-toast" role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

export function ImageAssetsModal({
  assets,
  loading,
  onInsert,
  onDelete,
  onRefresh,
  onClose,
}: {
  assets: NoteAsset[];
  loading: boolean;
  onInsert: (markdown: string) => void;
  onDelete: (fileName: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);

  async function handleConfirmDelete(fileName: string) {
    setDeletingFile(fileName);
    try {
      await onDelete(fileName);
      setConfirmDeleteFile((current) => (current === fileName ? null : current));
    } finally {
      setDeletingFile((current) => (current === fileName ? null : current));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal image-assets-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-title">Images</h2>
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="settings-section-header">
          <h3 className="settings-section-title">Current note assets</h3>
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => void onRefresh()}>
            Refresh
          </button>
        </div>
        <p className="api-keys-empty">Used images are currently referenced in the note. Remove them from the markdown before deleting them.</p>
        {loading ? <p className="api-keys-empty">Loading...</p> : null}
        {!loading && assets.length === 0 ? <p className="api-keys-empty">No uploaded images yet.</p> : null}
        <div className="image-asset-list">
          {assets.map((asset) => (
            <div key={asset.fileName} className="image-asset-row">
              <img src={asset.url} alt={asset.fileName} className="image-asset-preview" />
              <div className="image-asset-info">
                <div className="image-asset-title-row">
                  <strong className="api-key-label">{asset.fileName}</strong>
                  <span className={`image-asset-badge ${asset.inUse ? 'used' : 'unused'}`}>{asset.inUse ? 'In use' : 'Unused'}</span>
                </div>
                <div className="api-key-meta">{Math.max(1, Math.round(asset.size / 1024))} KB • {formatDate(asset.updatedAt)}</div>
                <code className="image-asset-markdown">{asset.markdown}</code>
                <div className="modal-actions">
                  <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => onInsert(asset.markdown)}>
                    Insert into note
                  </button>
                  {confirmDeleteFile === asset.fileName ? (
                    <div className="image-asset-confirm-delete">
                      <button
                        type="button"
                        className="documine-btn documine-btn--sm documine-btn--ghost"
                        onClick={() => setConfirmDeleteFile(null)}
                        disabled={deletingFile === asset.fileName}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="documine-btn documine-btn--sm documine-btn--danger"
                        onClick={() => void handleConfirmDelete(asset.fileName)}
                        disabled={deletingFile === asset.fileName}
                      >
                        {deletingFile === asset.fileName ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="documine-btn documine-btn--sm documine-btn--danger"
                      onClick={() => setConfirmDeleteFile(asset.fileName)}
                      disabled={asset.inUse}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function handleCommentTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, canSubmit: boolean, submit: () => void) {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) {
    return;
  }
  event.preventDefault();
  if (canSubmit) {
    submit();
  }
}

export function RenderedPreview({ url, zoom, loading, error, dirty, iframeRef }: { url: string; zoom: number; loading: boolean; error: string; dirty: boolean; iframeRef: RefCallback<HTMLIFrameElement> }) {
  return (
    <div className="preview-scroll preview-scroll--pdf">
      <div className="pdf-preview-shell">
        {error ? <div className="inline-error">{error}</div> : null}
        {url ? (
          <iframe
            ref={iframeRef}
            title="Rendered print preview"
            className="pdf-preview-frame pdf-preview-frame--document"
            src={url}
            style={{ zoom: zoom / 100 }}
          />
        ) : !loading && !dirty ? (
          <p className="pdf-preview-status">No rendered preview available yet.</p>
        ) : null}
      </div>
    </div>
  );
}

export function RequiredShareIdentityPage({
  name,
  saving,
  error,
  onNameChange,
  onSubmit,
  onToggleTheme,
}: {
  name: string;
  saving: boolean;
  error: string;
  onNameChange: (name: string) => void;
  onSubmit: () => Promise<void>;
  onToggleTheme: () => void;
}) {
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || saving) {
      return;
    }
    await onSubmit();
  }

  return (
    <div className="page-shell simple-page">
      <div className="simple-page-content">
        <div className="auth-card">
          <div className="auth-header">
            <div>
              <h1>Enter your name</h1>
              <p>Set your name before opening this shared note.</p>
            </div>
            <button type="button" className="documine-btn documine-btn--md documine-btn--ghost theme-toggle" onClick={onToggleTheme}>
              Theme
            </button>
          </div>
          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className="field">
              <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Your name" autoFocus />
            </div>
            {error ? <div className="inline-error">{error}</div> : null}
            <div className="modal-actions">
              <button type="submit" className="primary" disabled={saving || !name.trim()}>
                {saving ? 'Opening...' : 'Open shared note'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export function CommentIdentityModal({
  name,
  onNameChange,
  onSave,
  onClose,
}: {
  name: string;
  onNameChange: (name: string) => void;
  onSave: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!name.trim()) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await onSave();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save your name.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal compact" onClick={(event) => event.stopPropagation()}>
        <h2>Comment identity</h2>
        <p>Set a name before creating comments on this shared note.</p>
        <div className="field">
          <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Your name" />
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void handleSave()} disabled={busy || !name.trim()}>
            {busy ? 'Saving...' : 'Save name'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function NewCommentThreadModal({
  anchor,
  onSubmit,
  onClose,
}: {
  anchor: ThreadAnchor;
  onSubmit: (anchor: ThreadAnchor, body: string) => Promise<void>;
  onClose: () => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!body.trim()) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await onSubmit(anchor, body);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to add comment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal compact" onClick={(event) => event.stopPropagation()}>
        <h2>New comment thread</h2>
        <p>Comment on the selected text.</p>
        <pre className="agent-instructions"><code>{anchor.quote}</code></pre>
        <div className="field">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => handleCommentTextareaKeyDown(event, !busy && !!body.trim(), () => void handleSubmit())}
            placeholder="Comment"
          />
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void handleSubmit()} disabled={busy || !body.trim()}>
            {busy ? 'Saving...' : 'Add comment'}
          </button>
        </div>
      </div>
    </div>
  );
}
