//! FILENAME: app/src/api/objectPane.ts
// PURPOSE: The OBJECT PANE seam (WP-C D-PANE): ONE task pane, "object-pane",
//          that follows the PRIMARY floating object of @api/objectSelection and
//          shows that object's BUILD tabs (a pivot's Fields | Design, a range
//          chart's Data, a slicer's Settings, a control's Properties) plus the
//          shared Format tab.
// CONTEXT: Three parties meet here and none of them imports another:
//
//            - every object FAMILY registers an `ObjectPaneProvider` for its
//              region types: which build tabs the object offers, which one a
//              press or a door should land on, the pane header, and whether a
//              canvas press may open the pane at all (a run-mode button may not);
//            - the HOST (the BuiltIn/ObjectPane extension) registers itself with
//              `registerObjectPaneHost`: it owns the task-pane view, the open
//              policy (auto-open only at the release of a canvas press that did
//              not move; keyboard selection retargets an open pane and never
//              opens one), the tab strip and the Format tab;
//            - every DOOR (Ctrl+1, a family's right-click "Format...", a chart
//              double-click, View > Show, the grip's menu) calls
//              `openObjectPane` / `objectPaneMenuEntry` and never learns who
//              hosts the pane.
//
//          Callers say WHAT they want (this object, this tab, this reason) and
//          the host decides HOW -- the Seam Rule. Without a host every door
//          answers false / a disabled row with a reason, never a silent no-op.
//
//          Feature-neutral: nothing here imports an extension, and nothing here
//          imports @api/objectFormat (the host joins the two).

import type { ReactNode } from "react";
import type { GridRegion } from "./gridOverlays";

// ============================================================================
// Names
// ============================================================================

/** The task-pane view id of THE object pane. */
export const OBJECT_PANE_ID = "object-pane";
/** Its title (View > Show lists it by this). */
export const OBJECT_PANE_TITLE = "Object pane";
/** The id of the shared Format tab the host adds itself (never a provider's tab id). */
export const OBJECT_PANE_FORMAT_TAB = "format";
/** The label of the "Format..." row in every family's menu and the grip's. */
export const OBJECT_PANE_FORMAT_LABEL = "Format...";
/** Command: open the pane on the primary object's Format tab (Ctrl+1, menus). */
export const OBJECT_PANE_COMMAND_FORMAT = "objectPane.format";
/** Command: open the pane on the primary object's default tab. */
export const OBJECT_PANE_COMMAND_SHOW = "objectPane.show";

/** Why a menu row is disabled: no family offers a pane for this object. */
export const OBJECT_PANE_NO_PROVIDER = "This object has no pane to format it.";
/** Why a menu row is disabled: no object pane is installed. */
export const OBJECT_PANE_NOT_INSTALLED = "The object pane is not available.";
/** Why a menu row for a BUILD tab is disabled: the object does not offer that tab. */
export function objectPaneNoTabReason(tabId: string): string {
  return `This object has no "${tabId}" tab.`;
}

// ============================================================================
// Providers (one per family; last wins per region type)
// ============================================================================

/**
 * Why the pane is being opened:
 *   - "press":  the release of a canvas press that did not move (the policy);
 *   - "follow": the open pane retargets to a newly selected primary object;
 *   - "command": a DOOR -- Ctrl+1, a menu row, a double-click, View > Show.
 * A press or follow never opens a pane the user closed (manuallyClosed); a
 * command always does.
 */
export type ObjectPaneOpenReason = "press" | "follow" | "command";

/** What a build tab's render receives. */
export interface ObjectPaneTabContext {
  /** The LIVE region (the host re-reads it by id on every regions change). */
  region: GridRegion;
  /** The object is on a subscribed page: the tab must not write. */
  readOnly: boolean;
  /** The sentence that says why, or null. */
  readOnlyReason: string | null;
  /** The tab the host is showing (a build tab id, or OBJECT_PANE_FORMAT_TAB). */
  activeTabId: string;
}

/** One BUILD tab a family offers for an object. */
export interface ObjectPaneTab {
  /** "fields" | "design" | "data" | "settings" | "properties" -- never "format". */
  id: string;
  label: string;
  /**
   * The host renders the active BUILD tab's element into ONE slot that stays
   * mounted (display:none) while Format is shown. Returning the same component
   * type from several tabs keeps ONE instance across them (React
   * reconciliation) -- the pivot relies on this for its Fields/Design editor
   * state.
   */
  render(ctx: ObjectPaneTabContext): ReactNode;
}

/** A family's contribution to the object pane. */
export interface ObjectPaneProvider {
  /** The GridRegion types this provider answers for. */
  types: readonly string[];
  /** The object's build tabs, in order. [] = the pane shows Format only. */
  tabs(region: GridRegion): readonly ObjectPaneTab[];
  /** The tab an open lands on when the request names none. Default: the first build tab (else Format). */
  defaultTab?(region: GridRegion, reason: ObjectPaneOpenReason): string;
  /** The pane header ("Chart - Sales by Region"). */
  headerOf?(region: GridRegion): string;
  /**
   * Called by the HOST before a door shows Format (the chart publishes its
   * current element selection so the element card shows the right rung).
   */
  beforeShowFormat?(region: GridRegion): void;
  /**
   * May a canvas PRESS (reason "press") open the pane on this object? Default
   * true. The control provider answers false for a design-mode-only control
   * (button, page navigator) outside Design Mode, through WP-B's
   * `isDesignModeOnlyControl`.
   */
  opensOnPress?(region: GridRegion): boolean;
}

interface ProviderEntry {
  provider: ObjectPaneProvider;
}

const providers = new Map<string, ProviderEntry>();

/**
 * Register a family's pane provider. Last registration wins per region type;
 * the cleanup removes only the types still owned by THIS registration (a
 * stale cleanup cannot remove a newer one -- the controlsService precedent).
 */
export function registerObjectPaneProvider(p: ObjectPaneProvider): () => void {
  const entry: ProviderEntry = { provider: p };
  const types = Array.from(new Set(p.types));
  for (const type of types) providers.set(type, entry);
  return () => {
    for (const type of types) {
      if (providers.get(type) === entry) providers.delete(type);
    }
  };
}

/** The provider for the object behind `region`, or null. */
export function getObjectPaneProvider(region: GridRegion): ObjectPaneProvider | null {
  return providers.get(region.type)?.provider ?? null;
}

/** Whether some family offers a pane for objects of this region type. */
export function hasObjectPaneProvider(type: string): boolean {
  return providers.has(type);
}

// ============================================================================
// The host
// ============================================================================

/** What a door asks for. */
export interface ObjectPaneOpenRequest {
  /** The object; default: the primary object of @api/objectSelection. */
  region?: GridRegion;
  /** A build tab id or OBJECT_PANE_FORMAT_TAB; default: the provider's choice. */
  tab?: string;
  reason: ObjectPaneOpenReason;
}

/** What the pane shows right now. */
export interface ObjectPaneState {
  open: boolean;
  regionId: string | null;
  regionType: string | null;
  tabId: string | null;
}

/** THE object pane's host (the BuiltIn/ObjectPane extension). */
export interface ObjectPaneHost {
  /**
   * Open (or retarget) the pane. False: no region, no provider, or a "press" /
   * "follow" while the user has closed the pane.
   */
  open(req: ObjectPaneOpenRequest): boolean;
  close(): void;
  state(): ObjectPaneState;
}

const CLOSED_STATE: ObjectPaneState = Object.freeze({
  open: false,
  regionId: null,
  regionType: null,
  tabId: null,
}) as ObjectPaneState;

let host: ObjectPaneHost | null = null;
const stateListeners = new Set<(s: ObjectPaneState) => void>();

/**
 * Install THE object pane host. Last registration wins; the cleanup removes
 * only what is still this registration. Both announce a state change (a pane
 * whose host goes away reads closed).
 */
export function registerObjectPaneHost(h: ObjectPaneHost): () => void {
  host = h;
  notifyObjectPaneStateChanged();
  return () => {
    if (host !== h) return;
    host = null;
    notifyObjectPaneStateChanged();
  };
}

/**
 * Ask the host to open the pane. False without a host, when the host refused,
 * or when it threw (logged) -- a door that gets false says so; it never
 * pretends the pane opened.
 */
export function openObjectPane(req: ObjectPaneOpenRequest): boolean {
  const h = host;
  if (!h) return false;
  try {
    return h.open(req) === true;
  } catch (err) {
    console.error("[objectPane] the host's open threw:", err);
    return false;
  }
}

/** Close the pane (a no-op without a host). */
export function closeObjectPane(): void {
  const h = host;
  if (!h) return;
  try {
    h.close();
  } catch (err) {
    console.error("[objectPane] the host's close threw:", err);
  }
}

/** What the pane shows; closed without a host (or when the host's state throws, logged). */
export function getObjectPaneState(): ObjectPaneState {
  const h = host;
  if (!h) return CLOSED_STATE;
  try {
    const s = h.state();
    return {
      open: s.open === true,
      regionId: s.regionId ?? null,
      regionType: s.regionType ?? null,
      tabId: s.tabId ?? null,
    };
  } catch (err) {
    console.error("[objectPane] the host's state threw:", err);
    return CLOSED_STATE;
  }
}

/** Listen for pane state changes (open/close, retarget, tab switch). Returns the cleanup. */
export function onObjectPaneStateChanged(cb: (s: ObjectPaneState) => void): () => void {
  stateListeners.add(cb);
  return () => {
    stateListeners.delete(cb);
  };
}

/**
 * HOST ONLY: the pane's state changed. Every listener gets the current state;
 * a listener that throws is logged and the rest still run.
 */
export function notifyObjectPaneStateChanged(): void {
  const s = getObjectPaneState();
  for (const cb of Array.from(stateListeners)) {
    try {
      cb(s);
    } catch (err) {
      console.error("[objectPane] a state listener threw:", err);
    }
  }
}

// ============================================================================
// The menu row every family adds
// ============================================================================

/** One family menu's "Format..." (or build-tab) row. */
export interface ObjectPaneMenuEntry {
  /** OBJECT_PANE_COMMAND_FORMAT for Format; `objectPane.tab.<id>` for a build tab. */
  id: string;
  /** OBJECT_PANE_FORMAT_LABEL, or the build tab's own label + "..." (a caller may relabel: "Edit data"). */
  label: string;
  /** True when the row can do nothing: no provider, no host, or the object lacks that tab. */
  disabled: boolean;
  /** Why the row is disabled, or null. */
  reason: string | null;
  /** Open the pane on the object and tab (a no-op when disabled). */
  run(): void;
}

function offeredTabs(provider: ObjectPaneProvider, region: GridRegion): readonly ObjectPaneTab[] {
  try {
    return provider.tabs(region) ?? [];
  } catch (err) {
    console.error(`[objectPane] the "${region.type}" provider's tabs() threw:`, err);
    return [];
  }
}

/**
 * The row every family's right-click menu adds (census-pinned): "Format..."
 * opens the pane on the object's Format tab as a DOOR (`reason: "command"`, so
 * it opens even when the user closed the pane). With `tab` naming a build tab
 * ("data", "fields"), the row opens that tab instead and is disabled when the
 * object does not offer it.
 */
export function objectPaneMenuEntry(region: GridRegion, tab?: string): ObjectPaneMenuEntry {
  const targetTab = tab ?? OBJECT_PANE_FORMAT_TAB;
  const isFormat = targetTab === OBJECT_PANE_FORMAT_TAB;
  const provider = getObjectPaneProvider(region);
  const buildTab =
    provider && !isFormat ? offeredTabs(provider, region).find((t) => t.id === targetTab) ?? null : null;

  let reason: string | null = null;
  if (!provider) reason = OBJECT_PANE_NO_PROVIDER;
  else if (!host) reason = OBJECT_PANE_NOT_INSTALLED;
  else if (!isFormat && !buildTab) reason = objectPaneNoTabReason(targetTab);
  const disabled = reason !== null;

  return {
    id: isFormat ? OBJECT_PANE_COMMAND_FORMAT : `objectPane.tab.${targetTab}`,
    label: isFormat ? OBJECT_PANE_FORMAT_LABEL : `${buildTab?.label ?? targetTab}...`,
    disabled,
    reason,
    run: () => {
      if (disabled) return;
      openObjectPane({ region, tab: targetTab, reason: "command" });
    },
  };
}

/** Test hook: forget every provider, the host and every state listener. */
export function resetObjectPane(): void {
  providers.clear();
  host = null;
  stateListeners.clear();
}
