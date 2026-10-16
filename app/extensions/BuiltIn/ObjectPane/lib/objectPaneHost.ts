//! FILENAME: app/extensions/BuiltIn/ObjectPane/lib/objectPaneHost.ts
// PURPOSE: THE object pane host (@api/objectPane `ObjectPaneHost`): open,
//          retarget, switch tab and close the ONE "object-pane" task pane.
// CONTEXT: Every door (Ctrl+1, a family's "Format...", the grip's menu,
//          View > Show, a chart double-click) and the open policy
//          (objectPanePolicy.ts) end here, through `openObjectPane`. The host
//          decides HOW:
//
//            - the object: the request's region (re-read LIVE by id), else the
//              primary object of @api/objectSelection;
//            - no family pane provider for it: refused (false);
//            - a "press" or "follow" while the user closed the pane by hand
//              (the Shell's manuallyClosed list): refused -- only a DOOR
//              ("command") reopens a pane the user closed;
//            - a "press" the family says must not open it (a run-mode button,
//              `opensOnPress`): refused;
//            - the tab: the request's, else (on a follow) the tab already shown
//              when the new object offers it, else the family's `defaultTab`,
//              else the reader's last choice for that family (tabMemory), else
//              the first build tab, else Format;
//            - a door that lands on Format first lets the family publish what
//              Format should show (`beforeShowFormat`: the chart's ladder rung);
//            - `openTaskPane(OBJECT_PANE_ID)` with NO data (the view reads the
//              live subject) -- not on a follow of a pane already shown, which
//              must not pull it in front of another pane the reader is using;
//            - the "object" context key (View > Show lists the pane).
//          It never calls focus(): the grid keeps the keyboard.
//
//          `close` closes the task pane and ends any format preview. It removes
//          nothing else (the policy keeps the context key in step with the
//          selection).

import {
  OBJECT_PANE_FORMAT_TAB,
  OBJECT_PANE_ID,
  getObjectPaneProvider,
  notifyObjectPaneStateChanged,
  type ObjectPaneHost,
  type ObjectPaneOpenRequest,
  type ObjectPaneProvider,
  type ObjectPaneState,
} from "@api/objectPane";
import { endObjectFormatPreview } from "@api/objectFormat";
import { getGridRegions, type GridRegion } from "@api/gridOverlays";
import { getPrimaryObjectRegion } from "@api/objectSelection";
import {
  addTaskPaneContextKey,
  closeTaskPane,
  getTaskPaneManuallyClosed,
  openTaskPane,
} from "@api/ui";
import { CLOSED_SUBJECT, getPaneSubject, isObjectPaneShown, setPaneSubject } from "./paneState";
import { rememberTab, rememberedTab } from "./tabMemory";

/** The live floating region with this id, or null. */
export function liveObjectRegion(regionId: string | null | undefined): GridRegion | null {
  if (!regionId) return null;
  return getGridRegions().find((r) => r.id === regionId && !!r.floating) ?? null;
}

/** The provider's build tab ids, never throwing (a throw = Format only, logged). */
export function buildTabIds(provider: ObjectPaneProvider, region: GridRegion): string[] {
  try {
    return (provider.tabs(region) ?? []).map((t) => t.id).filter((id) => id !== OBJECT_PANE_FORMAT_TAB);
  } catch (err) {
    console.error(`[ObjectPane] the "${region.type}" provider's tabs() threw:`, err);
    return [];
  }
}

/** May a canvas press open the pane on this object? A throw = no (logged). */
export function pressMayOpen(provider: ObjectPaneProvider, region: GridRegion): boolean {
  if (!provider.opensOnPress) return true;
  try {
    return provider.opensOnPress(region) !== false;
  } catch (err) {
    console.error(`[ObjectPane] the "${region.type}" provider's opensOnPress() threw:`, err);
    return false;
  }
}

/**
 * The tab an open lands on (see the header for the order). Pure apart from
 * the provider calls and the tab memory read.
 */
export function pickObjectPaneTab(
  provider: ObjectPaneProvider,
  region: GridRegion,
  req: ObjectPaneOpenRequest,
  currentTab: string | null,
): string {
  const ids = buildTabIds(provider, region);
  const offered = (id: string | null | undefined): id is string =>
    !!id && (id === OBJECT_PANE_FORMAT_TAB || ids.includes(id));

  if (offered(req.tab)) return req.tab;
  if (req.reason === "follow" && offered(currentTab)) return currentTab;
  if (provider.defaultTab) {
    try {
      const d = provider.defaultTab(region, req.reason);
      if (offered(d)) return d;
    } catch (err) {
      console.error(`[ObjectPane] the "${region.type}" provider's defaultTab() threw:`, err);
    }
  }
  const remembered = rememberedTab(region.type);
  if (offered(remembered)) return remembered;
  return ids[0] ?? OBJECT_PANE_FORMAT_TAB;
}

/** What the host reports: its subject while the Shell still shows the pane, else closed. */
export function objectPaneHostState(): ObjectPaneState {
  const s = getPaneSubject();
  if (!s.open || !isObjectPaneShown()) return CLOSED_SUBJECT;
  return { ...s };
}

function openPane(req: ObjectPaneOpenRequest): boolean {
  const region = req.region ? (liveObjectRegion(req.region.id) ?? req.region) : getPrimaryObjectRegion();
  if (!region || !region.floating) return false;
  const provider = getObjectPaneProvider(region);
  if (!provider) return false;

  const passive = req.reason === "press" || req.reason === "follow";
  if (passive && getTaskPaneManuallyClosed().includes(OBJECT_PANE_ID)) return false;
  if (req.reason === "press" && !pressMayOpen(provider, region)) return false;

  const before = objectPaneHostState();
  const tab = pickObjectPaneTab(provider, region, req, before.tabId);

  // A preview belongs to the object it was shown on.
  if (before.regionId !== null && before.regionId !== region.id) endObjectFormatPreview();

  if (tab === OBJECT_PANE_FORMAT_TAB && req.reason === "command" && provider.beforeShowFormat) {
    try {
      provider.beforeShowFormat(region);
    } catch (err) {
      console.error(`[ObjectPane] the "${region.type}" provider's beforeShowFormat() threw:`, err);
    }
  }

  // A door's tab is the door's choice, not the reader's: only a tab picked in
  // the pane's strip is remembered (selectObjectPaneTab).
  setPaneSubject({ open: true, regionId: region.id, regionType: region.type, tabId: tab });
  // A follow of a pane already shown retargets in place; everything else shows it.
  if (!(req.reason === "follow" && before.open)) openTaskPane(OBJECT_PANE_ID);
  addTaskPaneContextKey("object");
  notifyObjectPaneStateChanged();
  return true;
}

function closePane(): void {
  endObjectFormatPreview();
  const wasOpen = getPaneSubject().open;
  setPaneSubject(CLOSED_SUBJECT);
  closeTaskPane(OBJECT_PANE_ID);
  if (wasOpen) notifyObjectPaneStateChanged();
}

/**
 * The reader picked a tab in the pane's strip. Ignored when the pane is not
 * showing an object or the object does not offer the tab.
 */
export function selectObjectPaneTab(tabId: string): void {
  const s = getPaneSubject();
  if (!s.open || s.tabId === tabId) return;
  const region = liveObjectRegion(s.regionId);
  if (!region) return;
  const provider = getObjectPaneProvider(region);
  if (!provider) return;
  if (tabId !== OBJECT_PANE_FORMAT_TAB && !buildTabIds(provider, region).includes(tabId)) return;
  if (s.tabId === OBJECT_PANE_FORMAT_TAB) endObjectFormatPreview();
  rememberTab(region.type, tabId);
  setPaneSubject({ ...s, tabId });
  notifyObjectPaneStateChanged();
}

/**
 * The Shell closed the pane on its own (its X, Close Task Pane, another
 * caller's closeTaskPane): forget the subject, end any preview, announce it.
 * Called on every task-pane state change; a no-op while the pane is shown.
 */
export function reconcileWithTaskPane(): void {
  const s = getPaneSubject();
  if (!s.open || isObjectPaneShown()) return;
  endObjectFormatPreview();
  setPaneSubject(CLOSED_SUBJECT);
  notifyObjectPaneStateChanged();
}

/** THE host, for `registerObjectPaneHost`. */
export function createObjectPaneHost(): ObjectPaneHost {
  return {
    open: openPane,
    close: closePane,
    state: objectPaneHostState,
  };
}
