export type ShareAccess = "none" | "view" | "comment" | "edit";

export type ViewerInfo = {
  isOwner: boolean;
  commenterName: string | null;
  hasCommenterIdentity: boolean;
};

export type AuthGuardSummary = {
  loginEnabled: boolean;
  globalLockActive: boolean;
  globalLockAt: string | null;
  globalLockReason: string | null;
  recentLoginRequestCount: number;
  bannedIpCount: number;
};

export type ViewerPayload = {
  ok: true;
  authConfigured: boolean;
  ownerAuthenticated: boolean;
  ownerLocalStorageTokenKey: string;
  authGuard: AuthGuardSummary;
  viewer: ViewerInfo;
};

export type ThreadMessage = {
  id: string;
  parentId: string | null;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
};

export type ThreadAnchor = {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
};

export type Thread = {
  id: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  anchor: ThreadAnchor;
  canReply: boolean;
  canResolve: boolean;
  canDeleteThread: boolean;
  messages: ThreadMessage[];
};

export type NoteSummary = {
  id: string;
  title: string;
  updatedAt: string;
  shareId: string;
  snippet: string;
  isImportedUnread: boolean;
};

export type NoteDetails = {
  id: string;
  title: string;
  markdown: string;
  renderedHtml: string;
  shareId: string;
  shareAccess: ShareAccess;
  shareUrl: string;
  updatedAt: string;
  createdAt: string;
};

export type NotePayload = {
  ok: true;
  note: NoteDetails;
  viewer: ViewerInfo;
  threads: Thread[];
};

export type SharedNotePayload = {
  ok: true;
  note: {
    id: string;
    title: string;
    markdown: string;
    shareAccess: ShareAccess;
    updatedAt: string;
  };
  threads: Thread[];
};

export type ApiKey = {
  id: string;
  label: string;
  createdAt: string;
};

export type UploadedImagePayload = {
  ok: true;
  asset: {
    url: string;
    markdown: string;
  };
};

export type NoteAsset = {
  fileName: string;
  url: string;
  markdown: string;
  inUse: boolean;
  size: number;
  updatedAt: string;
};

export type PdfExportStylePreset = 'report' | 'academic' | 'clean' | 'compact';
export type PdfExportPageSize = 'A4' | 'Letter' | 'Legal';
export type PdfExportOrientation = 'portrait' | 'landscape';
export type PdfExportEngine = 'browser';
export type PdfExportFontFamily = 'Times New Roman' | 'Georgia' | 'Arial' | 'Inter' | 'system-ui';
export type PdfExportHeaderMode = 'none' | 'title' | 'date' | 'title-date';
export type PdfExportCodeWrapMode = 'wrap' | 'scroll';
export type PdfExportImageAlignment = 'left' | 'center' | 'right';

export type PdfExportSettings = {
  stylePreset: PdfExportStylePreset;
  pageSize: PdfExportPageSize;
  orientation: PdfExportOrientation;
  engine: PdfExportEngine;
  toc: boolean;
  includeTitle: boolean;
  includeDate: boolean;
  fontFamily: PdfExportFontFamily;
  fontSizePt: number;
  lineHeight: number;
  marginsCm: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  headerMode: PdfExportHeaderMode;
  justifyText: boolean;
  imageMaxWidthPercent: number;
  imageAlign: PdfExportImageAlignment;
  codeWrap: PdfExportCodeWrapMode;
};

export type PdfExportCapabilities = {
  pandoc: boolean;
  browser: boolean;
  availableEngines: PdfExportEngine[];
  styles: PdfExportStylePreset[];
  pageSizes: PdfExportPageSize[];
  fontFamilies: PdfExportFontFamily[];
  headerModes: PdfExportHeaderMode[];
  codeWrapModes: PdfExportCodeWrapMode[];
  imageAlignments: PdfExportImageAlignment[];
};

export type PdfExportSettingsPayload = {
  ok: true;
  settings: PdfExportSettings;
  defaults: PdfExportSettings;
  capabilities: PdfExportCapabilities;
};

export type NotePdfExport = {
  fileName: string;
  url: string;
  downloadUrl: string;
  debugUrl: string;
  debugHtmlUrl: string;
  debugCssUrl: string;
  debugMarkdownUrl: string;
  size: number;
  createdAt: string;
  shareToken: string | null;
  shareUrl: string | null;
};

export type NotePdfExportsPayload = {
  ok: true;
  exports: NotePdfExport[];
};

export type SaveNotePdfPayload = {
  ok: true;
  export: NotePdfExport | null;
  exports: NotePdfExport[];
};

export type DeleteNotePdfPayload = {
  ok: true;
  exports: NotePdfExport[];
};

export type ImportNotesPayload = {
  ok: true;
  imported: Array<{ id: string; title: string; updatedAt: string }>;
  skipped: Array<{ title: string; error: string }>;
  warnings: Array<{ title: string; warning: string }>;
};

export class ApiError extends Error {
  status: number;
  details?: string[];

  constructor(message: string, status: number, details?: string[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function isLocalBrowserHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function resolveLocalApiOrigin(protocol: string, hostname: string, port: string, origin: string) {
  if (isLocalBrowserHost(hostname) && port && port !== '3120') {
    return `${protocol}//${hostname}:3120`;
  }
  return trimTrailingSlash(origin);
}

export function getApiHttpOrigin() {
  const envOrigin = (import.meta.env.VITE_DOCUMINE_API_HTTP_ORIGIN as string | undefined)?.trim();
  if (envOrigin) {
    return trimTrailingSlash(envOrigin);
  }

  const { protocol, hostname, port, origin } = window.location;
  return resolveLocalApiOrigin(protocol, hostname, port, origin);
}

function buildApiUrl(path: string) {
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  return `${getApiHttpOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: any = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      const contentType = response.headers.get('content-type') || '';
      const looksLikeHtml = /text\/html/i.test(contentType) || text.trimStart().startsWith('<!doctype') || text.trimStart().startsWith('<html');
      const message = looksLikeHtml
        ? 'API returned HTML instead of JSON. Check that the web app is talking to the API server on port 3120.'
        : 'API returned invalid JSON.';
      throw new ApiError(message, response.status || 0);
    }
  }

  if (!response.ok) {
    throw new ApiError(payload?.error || payload?.errors?.join(", ") || "Request failed.", response.status, payload?.errors);
  }

  return payload as T;
}

export async function apiRequest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    method: init.method ?? "GET",
    credentials: "include",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  return parseApiResponse<T>(response);
}

export async function exportNotes(scope: 'all' | 'selected', noteIds: string[] = []): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(buildApiUrl('/api/notes/export'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scope === 'all' ? { scope } : { scope, noteIds }),
  });
  if (!response.ok) {
    await parseApiResponse(response);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'documine-notes.zip';
  return { blob: await response.blob(), fileName };
}

export async function importNotes(file: File): Promise<ImportNotesPayload> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(buildApiUrl('/api/notes/import'), {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  return parseApiResponse<ImportNotesPayload>(response);
}

export async function uploadImage(file: File, options: { noteId?: string; shareId?: string }): Promise<UploadedImagePayload> {
  const endpoint = options.noteId
    ? `/api/notes/${encodeURIComponent(options.noteId)}/images`
    : options.shareId
      ? `/api/share/${encodeURIComponent(options.shareId)}/images`
      : null;

  if (!endpoint) {
    throw new Error("Missing note identifier for image upload.");
  }

  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(buildApiUrl(endpoint), {
    method: "POST",
    credentials: "include",
    body: formData,
  });

  return parseApiResponse<UploadedImagePayload>(response);
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

export async function saveNotePdf(noteId: string, markdown: string, settings: PdfExportSettings): Promise<SaveNotePdfPayload> {
  const response = await fetch(buildApiUrl(`/api/notes/${encodeURIComponent(noteId)}/export/pdf`), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, settings }),
  });

  return parseApiResponse<SaveNotePdfPayload>(response);
}

export async function listNotePdfExports(noteId: string): Promise<NotePdfExportsPayload> {
  const response = await fetch(buildApiUrl(`/api/notes/${encodeURIComponent(noteId)}/exports`), {
    method: 'GET',
    credentials: 'include',
  });

  return parseApiResponse<NotePdfExportsPayload>(response);
}

export async function deleteNotePdf(noteId: string, fileName: string): Promise<DeleteNotePdfPayload> {
  const response = await fetch(buildApiUrl(`/api/notes/${encodeURIComponent(noteId)}/exports/${encodeURIComponent(fileName)}`), {
    method: 'DELETE',
    credentials: 'include',
  });

  return parseApiResponse<DeleteNotePdfPayload>(response);
}

export type ShareTokenPayload = {
  ok: true;
  token: string;
  shareUrl: string;
};

export async function createExportShareToken(noteId: string, fileName: string): Promise<ShareTokenPayload> {
  const response = await fetch(buildApiUrl(`/api/notes/${encodeURIComponent(noteId)}/exports/${encodeURIComponent(fileName)}/share-token`), {
    method: 'POST',
    credentials: 'include',
  });

  return parseApiResponse<ShareTokenPayload>(response);
}

export async function revokeExportShareToken(noteId: string, fileName: string): Promise<DeleteNotePdfPayload> {
  const response = await fetch(buildApiUrl(`/api/notes/${encodeURIComponent(noteId)}/exports/${encodeURIComponent(fileName)}/share-token`), {
    method: 'DELETE',
    credentials: 'include',
  });

  return parseApiResponse<DeleteNotePdfPayload>(response);
}

export async function requestRenderedHtmlPreview(noteId: string, markdown: string, settings?: PdfExportSettings): Promise<Blob> {
  const response = await fetch(buildApiUrl(`/api/notes/${encodeURIComponent(noteId)}/export/html-preview`), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings === undefined ? { markdown } : { markdown, settings }),
  });

  if (!response.ok) {
    const text = await response.text();
    let payload: { error?: string; errors?: string[] } | null = null;
    try {
      payload = text ? JSON.parse(text) as { error?: string; errors?: string[] } : null;
    } catch {
      payload = null;
    }
    throw new ApiError(payload?.error || payload?.errors?.join(', ') || 'Request failed.', response.status, payload?.errors);
  }

  return response.blob();
}

export async function requestSharedRenderedHtmlPreview(shareId: string, markdown: string): Promise<Blob> {
  const response = await fetch(buildApiUrl(`/api/share/${encodeURIComponent(shareId)}/export/html-preview`), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown }),
  });

  if (!response.ok) {
    const text = await response.text();
    let payload: { error?: string; errors?: string[] } | null = null;
    try {
      payload = text ? JSON.parse(text) as { error?: string; errors?: string[] } : null;
    } catch {
      payload = null;
    }
    throw new ApiError(payload?.error || payload?.errors?.join(', ') || 'Request failed.', response.status, payload?.errors);
  }

  return response.blob();
}

export function buildWsUrl(pathAndQuery: string) {
  const envOrigin = (import.meta.env.VITE_DOCUMINE_API_WS_ORIGIN as string | undefined)?.trim();
  if (envOrigin) {
    return `${trimTrailingSlash(envOrigin)}${pathAndQuery}`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const { hostname, port, host } = window.location;
  if (isLocalBrowserHost(hostname) && port && port !== '3120') {
    return `${protocol}//${hostname}:3120${pathAndQuery}`;
  }

  return `${protocol}//${host}${pathAndQuery}`;
}
