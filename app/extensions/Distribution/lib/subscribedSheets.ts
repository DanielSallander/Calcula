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
//          TWO KEYS FROM ONE SNAPSHOT. The tab strip knows a sheet's `sheetId`;
//          the sheet context menu knows only its `index`. Fetching those from two
//          different commands would let them tear while a pull is appending
//          sheets, so `calp_get_sheet_provenance` returns both and this holds
//          both — one round trip, one consistent answer.
//
//          TWO ROLES, ONE MAP. Since checkout became additive the application's
//          own sheets sit beside the author's in one workbook, so "which sheets
//          are the application's" is a per-tab question for a working copy too.
//          The role travels WITH the package name rather than in a second map:
//          the two are read together on every lookup, and a detach offered on a
//          working-copy sheet would be a command with nothing to detach from.

import { getSheetProvenance, type SheetProvenanceRole } from "@api";

/** Where one sheet came from, and what that means for it. */
export interface SheetProvenanceEntry {
  packageName: string;
  role: SheetProvenanceRole;
}

/** localSheetId -> provenance. Stable across insert/delete/move/rename. */
let byId = new Map<string, SheetProvenanceEntry>();
/** workbook index -> provenance. Shifts when the sheet list changes. */
let byIndex = new Map<number, SheetProvenanceEntry>();

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
 * The application a sheet is subscribed to, by workbook INDEX.
 *
 * For the sheet context menu, which is handed an index and nothing else. Less
 * stable than the id form — an insert or a move invalidates it until the next
 * refresh — which is why the refresh below also listens for sheet-list changes.
 */
export function subscriptionForSheetIndex(index: number): string | null {
  const entry = byIndex.get(index);
  return entry?.role === "subscribed" ? entry.packageName : null;
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
  let nextByIndex: Map<number, SheetProvenanceEntry>;
  try {
    const rows = await getSheetProvenance();
    nextById = new Map();
    nextByIndex = new Map();
    for (const row of rows) {
      const entry: SheetProvenanceEntry = {
        packageName: row.packageName,
        role: row.role,
      };
      if (row.sheetId) nextById.set(row.sheetId, entry);
      nextByIndex.set(row.sheetIndex, entry);
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
  ): boolean => a?.packageName === b?.packageName && a?.role === b?.role;
  const sameById =
    nextById.size === byId.size && [...nextById].every(([k, v]) => same(byId.get(k), v));
  const sameByIndex =
    nextByIndex.size === byIndex.size &&
    [...nextByIndex].every(([k, v]) => same(byIndex.get(k), v));

  // ATOMIC REPLACE, never a merge: merging leaves a ghost badge on a sheet whose
  // subscription was detached or removed.
  byId = nextById;
  byIndex = nextByIndex;
  return !(sameById && sameByIndex);
}

/** Drop everything — the document was replaced, or the extension deactivated. */
export function resetSubscribedSheets(): void {
  byId = new Map();
  byIndex = new Map();
}
