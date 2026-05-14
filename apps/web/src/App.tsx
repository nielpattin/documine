import { useCallback, useState, useSyncExternalStore } from "react";
import { apiRequest, type NoteSummary, type ViewerPayload } from "./lib/api";
import { broadcastNotesListRefresh } from "./pages/page-utils";
import { LoginPage } from "./pages/LoginPage";
import { NotesListPage } from "./pages/NotesListPage";
import { OwnerNotePage } from "./pages/OwnerNotePage";
import { SharedNotePage } from "./pages/SharedNotePage";
import { LoadingPage, OwnerAuthGuardToast } from "./components/shared-ui";

const OWNER_TOKEN_KEY = "documine_owner_token";

type Route =
  | { kind: "login" }
  | { kind: "list" }
  | { kind: "note"; noteId: string }
  | { kind: "share"; shareId: string };

function parseRoute(pathname: string): Route {
  if (pathname === "/login") {
    return { kind: "login" };
  }

  const noteMatch = pathname.match(/^\/notes\/([^/]+)$/);
  if (noteMatch) {
    return { kind: "note", noteId: decodeURIComponent(noteMatch[1]) };
  }

  const shareMatch = pathname.match(/^\/s\/([^/]+)$/);
  if (shareMatch) {
    return { kind: "share", shareId: decodeURIComponent(shareMatch[1]) };
  }

  return { kind: "list" };
}

function getStoredTheme() {
  return window.localStorage.getItem("md_theme") || "dark";
}

function applyTheme(theme: string) {
  document.documentElement.setAttribute("data-theme", theme);
  window.localStorage.setItem("md_theme", theme);
}

type ViewerStoreSnapshot = {
  payload: ViewerPayload | null;
  loading: boolean;
};

type AuthGuardToastSnapshot = {
  message: string | null;
};

const routeServerSnapshot: Route = { kind: "list" };
const viewerServerSnapshot: ViewerStoreSnapshot = { payload: null, loading: true };
const authGuardToastServerSnapshot: AuthGuardToastSnapshot = { message: null };
const routeStoreListeners = new Set<() => void>();
const viewerStoreListeners = new Set<() => void>();
const authGuardToastListeners = new Set<() => void>();
let routeSnapshot: Route = typeof window !== "undefined" ? parseRoute(window.location.pathname) : routeServerSnapshot;
let viewerStoreSnapshot: ViewerStoreSnapshot = { payload: null, loading: true };
let authGuardToastSnapshot: AuthGuardToastSnapshot = { message: null };
let authGuardToastTimeoutId: number | null = null;
let viewerStoreStarted = false;
let viewerPollingIntervalId: number | null = null;
let ownerSessionRestoreAttempted = false;
let routeStoreListening = false;

if (typeof window !== "undefined") {
  applyTheme(getStoredTheme());
}

function emitRouteChange() {
  routeSnapshot = parseRoute(window.location.pathname);
  for (const listener of routeStoreListeners) {
    listener();
  }
}

function ensureRouteStoreStarted() {
  if (routeStoreListening || typeof window === "undefined") {
    return;
  }
  routeStoreListening = true;
  window.addEventListener("popstate", emitRouteChange);
}

function subscribeRoute(listener: () => void) {
  ensureRouteStoreStarted();
  routeStoreListeners.add(listener);
  return () => {
    routeStoreListeners.delete(listener);
    if (routeStoreListeners.size === 0 && routeStoreListening && typeof window !== "undefined") {
      window.removeEventListener("popstate", emitRouteChange);
      routeStoreListening = false;
    }
  };
}

function getRouteSnapshot() {
  return routeSnapshot;
}

function useRoute() {
  return useSyncExternalStore(subscribeRoute, getRouteSnapshot, () => routeServerSnapshot);
}

function navigateTo(nextPath: string, replace = false) {
  if (replace) {
    window.history.replaceState({}, "", nextPath);
  } else {
    window.history.pushState({}, "", nextPath);
  }
  emitRouteChange();
}

function emitViewerStoreChange() {
  for (const listener of viewerStoreListeners) {
    listener();
  }
}

function setAuthGuardToastMessage(message: string | null) {
  if (authGuardToastTimeoutId != null) {
    window.clearTimeout(authGuardToastTimeoutId);
    authGuardToastTimeoutId = null;
  }
  authGuardToastSnapshot = { message };
  for (const listener of authGuardToastListeners) {
    listener();
  }
  if (!message) {
    return;
  }
  authGuardToastTimeoutId = window.setTimeout(() => {
    authGuardToastTimeoutId = null;
    authGuardToastSnapshot = { message: null };
    for (const listener of authGuardToastListeners) {
      listener();
    }
  }, 5000);
}

function maybeShowAuthGuardToast(previousPayload: ViewerPayload | null, nextPayload: ViewerPayload) {
  if (!previousPayload?.ownerAuthenticated || !nextPayload.ownerAuthenticated) {
    return;
  }
  if (previousPayload.authGuard.loginEnabled && !nextPayload.authGuard.loginEnabled) {
    setAuthGuardToastMessage(
      nextPayload.authGuard.globalLockActive
        ? "Owner login was locked due to suspicious activity."
        : "Owner login was disabled.",
    );
  }
}

async function restoreOwnerSessionFromStorage() {
  if (ownerSessionRestoreAttempted || typeof window === "undefined") {
    return;
  }
  ownerSessionRestoreAttempted = true;
  const token = window.localStorage.getItem(OWNER_TOKEN_KEY);
  if (!token) {
    return;
  }
  try {
    await apiRequest("/api/auth/token", { method: "POST", body: { token } });
  } catch {
    window.localStorage.removeItem(OWNER_TOKEN_KEY);
  }
}

async function refreshViewerStore(options?: { silent?: boolean }) {
  if (!options?.silent) {
    viewerStoreSnapshot = { ...viewerStoreSnapshot, loading: true };
    emitViewerStoreChange();
  }

  const previousPayload = viewerStoreSnapshot.payload;
  try {
    const payload = await apiRequest<ViewerPayload>("/api/viewer");
    viewerStoreSnapshot = { payload, loading: false };
    maybeShowAuthGuardToast(previousPayload, payload);
    emitViewerStoreChange();
    if (payload.ownerAuthenticated && window.location.pathname === "/login") {
      navigateTo("/", true);
    }
    return payload;
  } catch (error) {
    viewerStoreSnapshot = { ...viewerStoreSnapshot, loading: false };
    emitViewerStoreChange();
    throw error;
  }
}

function ensureViewerStoreStarted() {
  if (viewerStoreStarted || typeof window === "undefined") {
    return;
  }
  viewerStoreStarted = true;
  void (async () => {
    await restoreOwnerSessionFromStorage();
    await refreshViewerStore().catch(() => undefined);
  })();
  viewerPollingIntervalId = window.setInterval(() => {
    void refreshViewerStore({ silent: true }).catch(() => undefined);
  }, 10000);
}

function subscribeViewerStore(listener: () => void) {
  ensureViewerStoreStarted();
  viewerStoreListeners.add(listener);
  return () => {
    viewerStoreListeners.delete(listener);
    if (viewerStoreListeners.size === 0 && viewerPollingIntervalId != null) {
      window.clearInterval(viewerPollingIntervalId);
      viewerPollingIntervalId = null;
      viewerStoreStarted = false;
    }
  };
}

function useViewerStore() {
  return useSyncExternalStore(
    subscribeViewerStore,
    () => viewerStoreSnapshot,
    () => viewerServerSnapshot,
  );
}

function subscribeAuthGuardToast(listener: () => void) {
  authGuardToastListeners.add(listener);
  return () => {
    authGuardToastListeners.delete(listener);
  };
}

function useAuthGuardToastStore() {
  return useSyncExternalStore(
    subscribeAuthGuardToast,
    () => authGuardToastSnapshot,
    () => authGuardToastServerSnapshot,
  );
}

function App() {
  const route = useRoute();
  const { payload: viewerPayload, loading: viewerLoading } = useViewerStore();
  const { message: authGuardToastMessage } = useAuthGuardToastStore();
  const [, setTheme] = useState(() => getStoredTheme());

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  const ownerTokenKey = viewerPayload?.ownerLocalStorageTokenKey ?? OWNER_TOKEN_KEY;

  const handleLogout = useCallback(async () => {
    await apiRequest("/api/auth/logout", { method: "POST" });
    window.localStorage.removeItem(ownerTokenKey);
    await refreshViewerStore();
    navigateTo("/login", true);
  }, [ownerTokenKey]);

  const handleAuthenticated = useCallback(async () => {
    await refreshViewerStore();
    if (route.kind === "note") {
      navigateTo(`/notes/${route.noteId}`, true);
      return;
    }
    navigateTo("/", true);
  }, [route]);

  if (route.kind === "share") {
    return <SharedNotePage shareId={route.shareId} onToggleTheme={toggleTheme} />;
  }

  if (viewerLoading || !viewerPayload) {
    return <LoadingPage message="Loading" />;
  }

  if (route.kind === "login" || !viewerPayload.ownerAuthenticated) {
    return (
      <LoginPage
        ownerTokenKey={ownerTokenKey}
        viewerPayload={viewerPayload}
        onAuthenticated={handleAuthenticated}
        onToggleTheme={toggleTheme}
      />
    );
  }

  async function handleCreateNoteFromEditor() {
    const payload = await apiRequest<{ ok: true; note: NoteSummary }>("/api/notes", { method: "POST" });
    broadcastNotesListRefresh();
    navigateTo(`/notes/${payload.note.id}`);
  }

  if (route.kind === "note") {
    return (
      <>
        <OwnerAuthGuardToast message={authGuardToastMessage} onDismiss={() => setAuthGuardToastMessage(null)} />
        <OwnerNotePage
          noteId={route.noteId}
          onBack={() => navigateTo("/")}
          onOpenNote={(noteId) => navigateTo(`/notes/${noteId}`)}
          onCreateNote={handleCreateNoteFromEditor}
          onLogout={handleLogout}
          onToggleTheme={toggleTheme}
        />
      </>
    );
  }

  return (
    <>
      <OwnerAuthGuardToast message={authGuardToastMessage} onDismiss={() => setAuthGuardToastMessage(null)} />
      <NotesListPage
        onOpenNote={(noteId) => navigateTo(`/notes/${noteId}`)}
        onLogout={handleLogout}
        onToggleTheme={toggleTheme}
      />
    </>
  );
}

export default App;
