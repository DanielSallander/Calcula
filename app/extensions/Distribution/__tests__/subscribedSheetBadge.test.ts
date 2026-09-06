//! FILENAME: app/extensions/Distribution/__tests__/subscribedSheetBadge.test.ts
// PURPOSE: The cache behind the subscribed-sheet tab mark.
// CONTEXT: Three disciplines, each of which is a way to mark the WRONG sheet —
//          which is worse than marking none, because the badge's whole claim is
//          "this one is not yours".

import { describe, it, expect, beforeEach, vi } from "vitest";

const getSheetProvenance = vi.fn();
vi.mock("@api", () => ({
  getSheetProvenance: (...a: unknown[]) => getSheetProvenance(...a),
}));

import {
  provenanceForSheetId,
  subscriptionForSheetId,
  subscribedProvenanceForSheetId,
  workingCopyForSheetId,
  refreshSubscribedSheets,
  resetSubscribedSheets,
  hasSubscribedSheets,
} from "../lib/subscribedSheets";

const ROW = {
  sheetIndex: 1,
  sheetId: "LOCAL-1",
  sheetName: "Sheet1 (2)",
  packageName: "vendor-kpis",
  registryUrl: "C:\\shared\\ws",
  resolvedVersion: "2.1.0",
  role: "subscribed",
};

/** The same shape for a sheet this workbook is the working copy OF. */
const WORKING_COPY_ROW = {
  sheetIndex: 2,
  sheetId: "APP-SHEET-1",
  sheetName: "Sales",
  packageName: "sales-report",
  registryUrl: "C:\\shared\\ws",
  resolvedVersion: "1.4.0",
  role: "workingCopy",
};

beforeEach(() => {
  getSheetProvenance.mockReset();
  resetSubscribedSheets();
});

describe("subscribed-sheet provenance cache", () => {
  it("answers by LOCAL sheet id", async () => {
    // The two ids in the ledger are different uuids — the publisher's and the
    // subscriber's own. Only the local one is a key into THIS workbook.
    // SABOTAGE: key the map on a package id instead.
    getSheetProvenance.mockResolvedValue([ROW]);
    await refreshSubscribedSheets();
    expect(subscriptionForSheetId("LOCAL-1")).toBe("vendor-kpis");
    expect(subscriptionForSheetId("SOMETHING-ELSE")).toBeNull();
  });

  it("answers the CONTEXT MENU by id too, not by index", async () => {
    // The menu items used to read a second map keyed by workbook index. It is
    // gone: `SheetContext` carries `sheetId`, so the menu asks exactly the
    // question the badge does.
    // SABOTAGE: reintroduce a `byIndex` map and have these read it.
    getSheetProvenance.mockResolvedValue([ROW]);
    await refreshSubscribedSheets();
    expect(subscribedProvenanceForSheetId("LOCAL-1")?.packageName).toBe("vendor-kpis");
    expect(subscribedProvenanceForSheetId("NOT-A-SHEET")).toBeNull();
    expect(workingCopyForSheetId("LOCAL-1")).toBeNull();
  });

  it("never marks a sheet it cannot identify", async () => {
    // SABOTAGE: add a name-keyed fallback. Rename the subscribed "Sales" to
    // "Old", create a fresh local "Sales", and the fallback badges the NEW sheet
    // as upstream content it has never touched.
    getSheetProvenance.mockResolvedValue([ROW]);
    await refreshSubscribedSheets();
    expect(subscriptionForSheetId(undefined)).toBeNull();
    expect(subscriptionForSheetId("")).toBeNull();
  });

  it("REPLACES rather than merges, so an unsubscribe leaves no ghost badge", async () => {
    // SABOTAGE: `next.forEach((v, k) => map.set(k, v))` instead of assigning.
    getSheetProvenance.mockResolvedValue([ROW]);
    await refreshSubscribedSheets();
    expect(hasSubscribedSheets()).toBe(true);

    getSheetProvenance.mockResolvedValue([]);
    await refreshSubscribedSheets();
    expect(subscriptionForSheetId("LOCAL-1")).toBeNull();
    expect(hasSubscribedSheets()).toBe(false);
  });

  it("keeps the previous answer when the read FAILS", async () => {
    // Absence means "not subscribed" here, so blanking on a transient error
    // would say these sheets are yours to publish.
    // SABOTAGE: clear the maps in the catch.
    getSheetProvenance.mockResolvedValue([ROW]);
    await refreshSubscribedSheets();

    getSheetProvenance.mockImplementation(() => Promise.reject(new Error("backend down")));
    const changed = await refreshSubscribedSheets();
    expect(changed).toBe(false);
    expect(subscriptionForSheetId("LOCAL-1")).toBe("vendor-kpis");
  });

  it("reports whether the answer actually changed", async () => {
    // So a caller only repaints the tab strip when a repaint would show
    // something different.
    // SABOTAGE: `return true` unconditionally.
    getSheetProvenance.mockResolvedValue([ROW]);
    expect(await refreshSubscribedSheets()).toBe(true);
    expect(await refreshSubscribedSheets()).toBe(false);

    getSheetProvenance.mockResolvedValue([{ ...ROW, packageName: "other-app" }]);
    expect(await refreshSubscribedSheets()).toBe(true);
  });

  it("SURVIVES A REORDER WITH NO REFRESH AT ALL", async () => {
    // THE DEFECT THIS CACHE HAD. A second map was keyed by workbook index and
    // refreshed on open / new / package-updated only — none of which a drag, a
    // delete or a copy raises. Drag the subscribed tab and every menu item
    // moved one sheet over: `Detach from "vendor-kpis"` was offered on a sheet
    // that had never touched an application, and the sheet still wearing the
    // badge showed none of the three items the badge advertises.
    //
    // The fix is not a fourth event. It is that no answer depends on position:
    // the cache below is never refreshed, and every lookup is still right.
    // SABOTAGE: key the lookups on `sheetIndex` again.
    getSheetProvenance.mockResolvedValue([ROW, WORKING_COPY_ROW]);
    await refreshSubscribedSheets();

    // The user drags tabs around. Nothing re-reads provenance.
    getSheetProvenance.mockReset();

    expect(subscriptionForSheetId("LOCAL-1")).toBe("vendor-kpis");
    expect(workingCopyForSheetId("APP-SHEET-1")?.packageName).toBe("sales-report");
    expect(getSheetProvenance).not.toHaveBeenCalled();
  });
});

describe("working-copy sheets carry a DIFFERENT mark", () => {
  // Checkout used to replace the document, so every tab was the application's
  // and a per-tab mark said nothing. It is now additive: the application's
  // sheets sit beside the author's own, and the two behave oppositely on Push.

  it("reports the role, so the tab can show which kind of not-yours it is", async () => {
    // SABOTAGE: drop `role` from the stored entry and have the provider decide
    // from `packageName` alone — every application sheet would then wear the
    // subscribed ↓, claiming a push leaves it behind when a push carries it.
    getSheetProvenance.mockResolvedValue([ROW, WORKING_COPY_ROW]);
    await refreshSubscribedSheets();
    expect(provenanceForSheetId("LOCAL-1")).toEqual({
      packageName: "vendor-kpis",
      registryUrl: "C:\\shared\\ws",
      resolvedVersion: "2.1.0",
      // Absent on the row, so normalised to "follows the development line"
      // rather than left undefined: the tab tooltip and the change comparison
      // both read it, and undefined vs null there would be a difference with
      // no meaning behind it.
      environment: null,
      // Normalised the same way, and for the same reason: the badge, the delete
      // guard and the publish exclusion all read it, and a sheet the publisher
      // has dropped must keep answering for all three.
      upstreamRemoved: false,
      role: "subscribed",
    });
    expect(provenanceForSheetId("APP-SHEET-1")).toEqual({
      packageName: "sales-report",
      registryUrl: "C:\\shared\\ws",
      resolvedVersion: "1.4.0",
      environment: null,
      upstreamRemoved: false,
      role: "workingCopy",
    });
  });

  it("offers DETACH on the subscribed sheet only", async () => {
    // Detaching a working-copy sheet is not a weaker version of the same act:
    // there is no subscription to leave, and `calp_detach_sheet` refuses it. A
    // menu item whose command always refuses teaches people to ignore the menu.
    // SABOTAGE: make `subscriptionForSheetId` return the name for any entry.
    getSheetProvenance.mockResolvedValue([ROW, WORKING_COPY_ROW]);
    await refreshSubscribedSheets();
    expect(subscriptionForSheetId("LOCAL-1")).toBe("vendor-kpis");
    expect(subscriptionForSheetId("APP-SHEET-1")).toBeNull();
    expect(subscribedProvenanceForSheetId("APP-SHEET-1")).toBeNull();
  });

  it("does not count a working copy as having subscribed sheets", async () => {
    getSheetProvenance.mockResolvedValue([WORKING_COPY_ROW]);
    await refreshSubscribedSheets();
    expect(hasSubscribedSheets()).toBe(false);
  });

  it("notices a role change on the same sheet", async () => {
    // Detach-then-checkout, or a refresh landing after a push: the id is the
    // same and only the meaning moved. SABOTAGE: compare package names only.
    getSheetProvenance.mockResolvedValue([WORKING_COPY_ROW]);
    expect(await refreshSubscribedSheets()).toBe(true);
    getSheetProvenance.mockResolvedValue([{ ...WORKING_COPY_ROW, role: "subscribed" }]);
    expect(await refreshSubscribedSheets()).toBe(true);
  });
});
