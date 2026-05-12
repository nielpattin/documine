import { useState, type FormEvent } from 'react';
import { ApiError, apiRequest, type ViewerPayload } from '../lib/api';

export function LoginPage({
  ownerTokenKey,
  viewerPayload,
  onAuthenticated,
  onToggleTheme,
}: {
  ownerTokenKey: string;
  viewerPayload: ViewerPayload | null;
  onAuthenticated: () => Promise<void>;
  onToggleTheme: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const mode = viewerPayload?.authConfigured ? 'login' : 'setup';
  const loginDisabled = mode === 'login' && Boolean(viewerPayload && !viewerPayload.authGuard.loginEnabled);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const endpoint = mode === 'setup' ? '/api/auth/setup' : '/api/auth/login';
      const payload = await apiRequest<{ token: string }>(endpoint, {
        method: 'POST',
        body: mode === 'setup' ? { password, confirmPassword } : { password },
      });
      window.localStorage.setItem(ownerTokenKey, payload.token);
      await apiRequest('/api/auth/token', { method: 'POST', body: { token: payload.token } });
      await onAuthenticated();
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 423 || cause.status === 429)) {
        setError('Owner sign-in is unavailable. Contact the owner.');
      } else {
        setError(cause instanceof Error ? cause.message : 'Request failed.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-shell auth-shell">
      <button type="button" className="documine-btn-icon documine-btn-icon--md auth-theme-toggle theme-toggle" onClick={onToggleTheme}>
        {document.documentElement.getAttribute('data-theme') === 'dark' ? '☀' : '☾'}
      </button>
      <div className="auth-layout">
        <h1>{mode === 'setup' ? 'Set owner password' : 'Sign in'}</h1>
        <p className="auth-hint">
          {mode === 'setup'
            ? 'This password protects the owner workspace and API key management.'
            : 'Use the owner password for this Documine instance.'}
        </p>
        <div className={`auth-error ${error || loginDisabled ? '' : 'hidden'}`}>
          {error || (loginDisabled ? 'Owner sign-in is unavailable. Contact the owner.' : '')}
        </div>
        <form className="auth-form" onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Password"
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {mode === 'setup' ? (
            <input
              type="password"
              placeholder="Confirm password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          ) : null}
          <div className="auth-actions">
            <button type="submit" className="primary" disabled={submitting || loginDisabled}>
              {submitting ? 'Working...' : mode === 'setup' ? 'Save password' : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


