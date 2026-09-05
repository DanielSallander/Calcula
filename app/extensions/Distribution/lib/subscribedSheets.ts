// FILENAME: app/extensions/Distribution/lib/subscribedSheets.ts
// PURPOSE: A synchronous answer to "did this sheet come from an application, and
//          in which role?", for surfaces that cannot await — the sheet-tab
//          decoration provider is called for every visible tab on every render,
//          and a context menu's `visible`/`label` predicates run while the menu
//          is opening.
// CONTEXT: The authority is `Subscription.sheets` and the working-copy link in
//          the workbook's `user_files/`, reachable only over IPC. So this is a
//          cache, refreshed on the events that change what the workbook holds.
//
//          ONE KEY: THE SHEET ID. This used to hold a second map keyed by
//          workbook INDEX, because the sheet context menu was handed an index and
//          nothing else. Its refresh triggers are open / new / package-updated —
//          none of which a drag, a delete or a copy raises — so a reordered tab
//          strip left every menu item pointing one sheet over: `Detach from
//          "vendor-kpis"` offered on a sheet that never came from an application
//          (and refused by the backend after the confirm), while the sheet still
//          wearing the badge showed no items at all, because the badge keyed on
//          the id and was right. The index map is gone rather than more eagerly
//          refreshed; `SheetContext` now carries `sheetId`, so the menu asks the
//          same question the badge does.
//
//          TWO ROLES, ONE MAP. Since checkout became additive the application's
//          own sheets sit beside the author's in one workbook, so "which sheets
//          are the application's" is a per-tab question for a working copy too.
//          The role travels WITH the package name rather than in a second map:
//          the two are read together on every lookup, and a detach offered on a
//          working-copy sheet would be a command with nothing to detach from.

import { getSheetProvenance, type SheetProvenanceRole } from "@api";

/**
 * Where one sheet came from, and what that means for it.
 *
 * Carries the WORKSPACE and the RESOLVED VERSION as well as the name, because
 * the two commands a tab menu offers — `detachSheet` and `resetSubscription` —
 * are keyed differently: detach takes a sheet index, reset takes
 * (registryUrl, packageName). A menu that had only the name would have to guess
 * which workspace, and two teams may each publish `sales` to their own share.
 */
export interface SheetProvenanceEntry {
  packageName: string;
  registryUrl: string;
  resolvedVersion: string;
  /**
   * The environment this sheet's subscription follows, or absent for the
   * development line.
   *
   * Part of what the tab says, so it is part of what `same()` compares below:
   * switching prod → test moves no sheet and changes no version until the next
   * refresh, but it DOES change what the tooltip should say, and a comparison
   * that ignored it would leave every tab claiming the old stream.
   */
  environment?: string | null;
  role: SheetProvenanceRole;
}

/** localSheetId -> provenance. Stable across insert/delete/move/rename. */
let byId = new Map<string, SheetProvenanceEntry>();

/**
 * Full provenance for a sheet — application AND role — or `null`.
 *
 * KEYED ON THE LOCAL sheet id, never the application's `packageSheetId`. For a
 * subscribed sheet those are different uuids — the publisher's and the
 * subscriber's own, minted fresh at pull — and only the local one is a key into
 * THIS workbook. (For a working copy they coincide, because preserving the
 * application's sheet identity is what checkout is FOR; that coincidence is not
 * a licence to key on the wrong one.)
 *
 * NO NAME FALLBACK, deliberately. Falling back to a name when the id is missing
 * looks helpful and lies: rename the subscribed "Sales" to "Old", create a fresh
 * local "Sales", and the new sheet wears a badge claiming it came from an
 * application it has never touched. A sheet we cannot identify is not marked.
 */
export function provenanceForSheetId(
  sheetId: string | undefined,
): SheetProvenanceEntry | null {
  if (!sheetId) return null;
  return byId.get(sheetId) ?? null;
}

/**
 * The application a sheet is SUBSCRIBED to, or `null`.
 *
 * Subscribed only — a working-copy sheet answers `null` here. The callers are
 * the detach surfaces, and detaching a working-copy sheet is not a weaker
 * version of the same act: there is no subscription to leave. Widening this to
 * "came from an application" would put a Detach item on a tab whose backend
 * command refuses it.
 */
export function subscriptionForSheetId(sheetId: string | undefined): string | null {
  const entry = provenanceForSheetId(sheetId);
  return entry?.role === "subscribed" ? entry.packageName : null;
}

/**
 * Full SUBSCRIBED provenance for a sheet, for the tab menu items that need more
 * than a name — `resetSubscription` is keyed by (registryUrl, packageName), not
 * by sheet.
 *
 * Subscribed only, like `subscriptionForSheetId`: a working-copy sheet has no
 * subscription to reset or detach.
 */
export function subscribedProvenanceForSheetId(
  sheetId: string | undefined,
): SheetProvenanceEntry | null {
  const entry = provenanceForSheetId(sheetId);
  return entry?.role === "subscribed" ? entry : null;
}

/**
 * Full WORKING-COPY provenance, for the push tab item.
 *
 * A SIBLING, not a widening of `subscribedProvenanceForSheetId`, whose
 * subscribed-only contract the detach and reset items rely on. Pushing FROM a
 * subscribed sheet is refused by name in Rust (`CALP_PUSH_IS_SUBSCRIBER`), so an
 * item offered there would be a menu entry whose command cannot run.
 */
export function workingCopyForSheetId(
  sheetId: string | undefined,
): SheetProvenanceEntry | null {
  const entry = provenanceForSheetId(sheetId);
  return entry?.role === "workingCopy" ? entry : null;
}

/**
 * How many SUBSCRIBED sheets in this workbook came from one application, so a
 * confirm can say what a whole-application reset will touch.
 *
 * Filtered on the role: the map also holds working-copy rows, and counting those
 * would promise to reset tabs the command will not touch.
 */
export function subscribedSheetCountForApplication(
  registryUrl: string,
  packageName: string,
): number {
  let n = 0;
  for (const e of byId.values()) {
    if (e.role === "subscribed" && e.packageName === packageName && e.registryUrl === registryUrl) {
      n += 1;
    }
  }
  return n;
}

export function hasSubscribedSheets(): boolean {
  return [...byId.values()].some((e) => e.role === "subscribed");
}

/**
 * Re-read the provenance snapshot.
 *
 * @returns whether the ANSWER changed, so a caller only invalidates the tab strip
 *          when a repaint would show something different.
 */
export async function refreshSubscribedSheets(): Promise<boolean> {
  let nextById: Map<string, SheetProvenanceEntry>;
  try {
    const rows = await getSheetProvenance();
    nextById = new Map();
    for (const row of rows) {
      const entry: SheetProvenanceEntry = {
        packageName: row.packageName,
        registryUrl: row.registryUrl,
        resolvedVersion: row.resolvedVersion,
        environment: row.environment ?? null,
        role: row.role,
      };
      // A ROW WITH NO ID IS DROPPED, not indexed by position instead. Every
      // consumer keys on the id now, so a row we cannot identify has no answer
      // to give — and inventing one from the index is the defect this map's
      // sibling was.
      if (row.sheetId) nextById.set(row.sheetId, entry);
    }
  } catch {
    // A FAILED READ KEEPS THE PREVIOUS ANSWER. Absence means "not subscribed"
    // here, so blanking the maps on a transient backend error would actively
    // misinform — it would say these sheets are yours to publish.
    return false;
  }

  const same = (
    a: SheetProvenanceEntry | undefined,
    b: SheetProvenanceEntry | undefined,
  ): boolean =>
    a?.packageName === b?.packageName &&
    a?.role === b?.role &&
    // The environment is IN the tooltip, so it is in the comparison. Without
    // this, switching a subscription from prod to test returns `false` here —
    // "nothing to repaint" — and every tab keeps naming the environment the
    // workbook no longer follows.
    (a?.environment ?? null) === (b?.environment ?? null);
  const sameById =
    nextById.size === byId.size && [...nextById].every(([k, v]) => same(byId.get(k), v));

  // ATOMIC REPLACE, never a merge: merging leaves a ghost badge on a sheet whose
  // subscription was detached or removed.
  byId = nextById;
  return !sameById;
}

/** Drop everything — the document was replaced, or the extension deactivated. */
export function resetSubscribedSheets(): void {
  byId = new Map();
}
