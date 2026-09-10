// FILENAME: app/extensions/ModelEditor/lib/useSectionRoute.ts
// PURPOSE: The Model Editor's route — which section is showing and which
//          object is selected inside it — held in ONE place, mirrored to
//          location.hash and remembered per connection.
// CONTEXT: The window used to hold `useState<SectionId>("overview")`, so every
//          reopen landed on Overview no matter what you were doing, and there
//          was no way for the main window (or anything else) to open the
//          editor AT an object.
//
//          Two stores, deliberately, because neither is sufficient alone:
//          the HASH makes the current route addressable and survives a webview
//          reload, but the window is destroyed and recreated at a fixed
//          /modelEditor.html, so a hash cannot survive closing it. LOCALSTORAGE
//          survives that, but is not addressable. Hash wins on open when it
//          carries a route; otherwise the stored route seeds the session.

import { useCallback, useEffect, useState } from "react";
import { isSectionId } from "../components/editorShared";
import type { SectionId } from "../components/editorShared";

export interface SectionRoute {
  section: SectionId;
  /** The object selected inside the section (a table, measure, … name). */
  selection?: string;
}

const STORAGE_PREFIX = "calcula.modelEditor.route.";
const DEFAULT_SECTION: SectionId = "overview";

/** `#/measures/Margin%20%25` -> `{ section: "measures", selection: "Margin %" }` */
export function parseRouteHash(hash: string): SectionRoute | null {
  const raw = hash.replace(/^#\/?/, "");
  if (!raw) return null;
  const [rawSection, ...rest] = raw.split("/");
  let section: string;
  try {
    section = decodeURIComponent(rawSection);
  } catch {
    return null; // a malformed escape must not throw on boot
  }
  if (!isSectionId(section)) return null;
  const joined = rest.join("/");
  if (!joined) return { section };
  try {
    return { section, selection: decodeURIComponent(joined) };
  } catch {
    return { section };
  }
}

export function formatRouteHash(route: SectionRoute): string {
  const base = `#/${encodeURIComponent(route.section)}`;
  return route.selection ? `${base}/${encodeURIComponent(route.selection)}` : base;
}

function readStoredRoute(connectionId: string): SectionRoute | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + connectionId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { section, selection } = parsed as { section?: unknown; selection?: unknown };
    if (typeof section !== "string" || !isSectionId(section)) return null;
    return typeof selection === "string" ? { section, selection } : { section };
  } catch {
    // Private mode, cleared site data, or a value written by an older build.
    return null;
  }
}

interface RouteState {
  route: SectionRoute;
  /** The connection the route belongs to; "" until one is known. */
  conn: string;
  /** True once the hash or a stored route has had its say. */
  seeded: boolean;
}

export function useSectionRoute(connectionId: string): {
  route: SectionRoute;
  navigate: (section: SectionId, selection?: string) => void;
  setSelection: (selection: string | undefined) => void;
} {
  const [state, setState] = useState<RouteState>(() => {
    const fromHash = parseRouteHash(window.location.hash);
    return fromHash
      ? { route: fromHash, conn: "", seeded: true }
      : { route: { section: DEFAULT_SECTION }, conn: "", seeded: false };
  });

  // Adjust state at RENDER time when the connection changes, not in an effect —
  // this eslint config bans react-hooks/set-state-in-effect, and the codebase
  // uses this pattern throughout (see TablesSection's selection resync).
  if (connectionId && connectionId !== state.conn) {
    setState((s) => {
      if (!s.seeded) {
        // First model of the session and the hash said nothing: adopt whatever
        // this connection was last showing.
        return { route: readStoredRoute(connectionId) ?? s.route, conn: connectionId, seeded: true };
      }
      // SWITCHING models. The section survives; the selection cannot — it names
      // an object in the model being left, and restoring it would point a
      // section at a foreign object under a new connectionId. That is the exact
      // cross-model hazard ModelEditorApp's `setOverview(null)`-FIRST ordering
      // exists to prevent.
      return { route: { section: s.route.section }, conn: connectionId, seeded: true };
    });
  }

  // Persisting is a genuine side effect (DOM + storage), so it belongs here.
  useEffect(() => {
    const hash = formatRouteHash(state.route);
    if (window.location.hash !== hash) {
      // replaceState, not assignment: the editor has no back/forward UI, and
      // pushing entries would make the browser Back gesture walk a history the
      // user never knowingly built.
      window.history.replaceState(null, "", hash);
    }
    if (!state.conn) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + state.conn, JSON.stringify(state.route));
    } catch {
      // Storage unavailable — the route still works for this session.
    }
  }, [state.route, state.conn]);

  const navigate = useCallback((section: SectionId, selection?: string) => {
    setState((s) => ({ ...s, route: selection ? { section, selection } : { section } }));
  }, []);

  const setSelection = useCallback((selection: string | undefined) => {
    setState((s) => ({
      ...s,
      route: selection ? { section: s.route.section, selection } : { section: s.route.section },
    }));
  }, []);

  return { route: state.route, navigate, setSelection };
}
