import type { SavedCollabState, CollabState } from '../collab.js';

export type CommentAnchor = {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
};

export type CommentMessage = {
  id: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type CommentThread = {
  id: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  anchor: CommentAnchor;
  messages: CommentMessage[];
};

export type ShareAccess = 'none' | 'view' | 'comment' | 'edit';

export type NoteMetaFile = {
  id: string;
  title: string;
  shareId: string;
  shareAccess: ShareAccess;
  createdAt: string;
  updatedAt: string;
  threads: CommentThread[];
  collab?: SavedCollabState;
  collabState?: SavedCollabState;
  importedAt?: string;
  importOpenedAt?: string | null;
};

export type NoteRecord = {
  id: string;
  title: string;
  shareId: string;
  shareAccess: ShareAccess;
  createdAt: string;
  updatedAt: string;
  threads: CommentThread[];
  markdown: string;
  collab: CollabState;
  clientAcks: Map<string, number>;
  importedAt?: string;
  importOpenedAt?: string | null;
};

export type NoteSummary = {
  id: string;
  title: string;
  updatedAt: string;
  shareId: string;
  snippet: string;
  isImportedUnread: boolean;
};

export type NoteAssetSummary = {
  fileName: string;
  url: string;
  markdown: string;
  inUse: boolean;
  size: number;
  updatedAt: string;
};

export type NotePdfExportSummary = {
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
