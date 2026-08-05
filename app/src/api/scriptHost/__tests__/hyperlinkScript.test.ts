//! FILENAME: app/src/api/scriptHost/__tests__/hyperlinkScript.test.ts
// PURPOSE: Wave 3 item 6 — hyperlink rows. Pins (1) checkHyperlinkSpec's
//          per-type key enumeration, (2) the executors' exact AddHyperlinkParams
//          payloads (including cellReference doubling as the internal arm's
//          target slot), (3) removeHyperlink's false-not-throw contract, (4)
//          THE TOC MACRO — loop the sheets, attach one internalReference per
//          sheet onto a "TOC" sheet BY NAME, no activation — at unit level,
//          and (5) the deliberate no-follow exclusion (no such method or row).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));
vi.mock("../../../core/lib/cellEvents", () => ({
  cellEvents: { emitBatch: vi.fn() },
  cellToChange: vi.fn((c: unknown) => c),
}));

import {
  executeAddHyperlink,
  executeGetHyperlink,
  executeRemoveHyperlink,
  executeListHyperlinks,
  hyperlinkToScript,
} from "../host";
import { ALLOWLIST } from "../allowlist";
import {
  checkHyperlinkSpec,
  vAddHyperlink,
  vCellRef,
  vSheetScopedList,
  SCRIPT_HYPERLINK_TYPES,
} from "../validators";

const SHEETS = [
  { index: 0, name: "TOC" },
  { index: 1, name: "North" },
  { index: 2, name: "South" },
];

function makeLib(activeIndex = 0) {
  const lib = {
    getActiveSheet: vi.fn(async () => activeIndex),
    getSheets: vi.fn(async () => ({ sheets: SHEETS, activeIndex })),
    addHyperlink: vi.fn(async (params: Record<string, unknown>) => ({
      success: true,
      hyperlink: {
        row: params.row,
        col: params.col,
        sheetIndex: params.sheetIndex ?? activeIndex,
        linkType: params.linkType,
        target: params.target,
        displayText: params.displayText,
        tooltip: params.tooltip,
        internalRef:
          params.linkType === "internalReference"
            ? { sheetName: params.sheetName, cellReference: params.cellReference }
            : undefined,
      },
    })),
    removeHyperlink: vi.fn(async () => ({ success: true, hyperlink: undefined })),
    getHyperlink: vi.fn(async () => null),
    getAllHyperlinks: vi.fn(async () => []),
  };
  return lib;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

beforeEach(() => vi.clearAllMocks());

// ============================================================================
// (1) the spec gate
// ============================================================================

describe("checkHyperlinkSpec", () => {
  it("the type set mirrors HyperlinkType tag for tag", () => {
    expect([...SCRIPT_HYPERLINK_TYPES].sort()).toEqual(
      ["email", "file", "internalReference", "url"],
    );
  });

  it("accepts one well-formed spec per type", () => {
    expect(checkHyperlinkSpec({ type: "url", target: "https://example.com" })).toBe(true);
    expect(checkHyperlinkSpec({ type: "file", target: "C:/reports/q1.pdf" })).toBe(true);
    expect(checkHyperlinkSpec({ type: "email", target: "a@b.se", subject: "Hej" })).toBe(true);
    expect(checkHyperlinkSpec({ type: "internalReference", cellReference: "B4" })).toBe(true);
    expect(
      checkHyperlinkSpec({ type: "internalReference", cellReference: "A1", sheetName: "North" }),
    ).toBe(true);
  });

  it("an out-of-place key fails WITH the accepted list", () => {
    expect(checkHyperlinkSpec({ type: "url", target: "x", subject: "no" }))
      .toContain('unknown link key "subject" for type "url"');
    // The internal arm speaks cellReference, never target — one spelling.
    expect(checkHyperlinkSpec({ type: "internalReference", target: "A1" }))
      .toContain('unknown link key "target"');
  });

  it("requires the per-type payload", () => {
    expect(checkHyperlinkSpec({ type: "url" })).toContain("link.target");
    expect(checkHyperlinkSpec({ type: "url", target: "   " })).toContain("link.target");
    expect(checkHyperlinkSpec({ type: "internalReference" })).toContain("cellReference");
    expect(checkHyperlinkSpec({ type: "internalReference", cellReference: "A1", sheetName: "Bad[x]" }))
      .toContain("link.sheetName");
    expect(checkHyperlinkSpec({ type: "hover" })).toContain("link.type must be one of");
  });

  it("vAddHyperlink: coords + spec + options + sheet slot", () => {
    const link = { type: "url", target: "https://x" };
    expect(vAddHyperlink([0, 0, link])).toBe(true);
    expect(vAddHyperlink([0, 0, link, { displayText: "Here", tooltip: "t" }, "North"])).toBe(true);
    expect(vAddHyperlink([-1, 0, link])).toContain("row");
    expect(vAddHyperlink([0, 0, link, { color: "red" }])).toContain('unknown hyperlink option "color"');
    expect(vAddHyperlink([0, 0, link, undefined, true])).not.toBe(true);
  });
});

// ============================================================================
// (2) executors: exact payloads
// ============================================================================

describe("executeAddHyperlink", () => {
  it("url on the active sheet: sheetIndex undefined, options mapped", async () => {
    const lib = makeLib();
    const result = await executeAddHyperlink(
      asLib(lib), 2, 3, { type: "url", target: "https://example.com" }, { displayText: "Site" },
    );
    expect(lib.addHyperlink).toHaveBeenCalledWith({
      row: 2, col: 3, sheetIndex: undefined, linkType: "url",
      target: "https://example.com", displayText: "Site", tooltip: undefined,
      sheetName: undefined, cellReference: undefined, emailSubject: undefined,
    });
    expect(result).toMatchObject({ row: 2, col: 3, type: "url", target: "https://example.com" });
  });

  it("email: the subject rides emailSubject", async () => {
    const lib = makeLib();
    await executeAddHyperlink(asLib(lib), 0, 0, { type: "email", target: "a@b.se", subject: "Q1" });
    expect(lib.addHyperlink).toHaveBeenCalledWith(
      expect.objectContaining({ linkType: "email", target: "a@b.se", emailSubject: "Q1" }),
    );
  });

  it("internalReference: cellReference fills BOTH its own slot and target", async () => {
    const lib = makeLib();
    await executeAddHyperlink(
      asLib(lib), 1, 0,
      { type: "internalReference", sheetName: "North", cellReference: "B4" },
    );
    expect(lib.addHyperlink).toHaveBeenCalledWith(
      expect.objectContaining({
        linkType: "internalReference", target: "B4", cellReference: "B4", sheetName: "North",
      }),
    );
  });

  it("a backend refusal (protection) throws with the reason", async () => {
    const lib = makeLib();
    lib.addHyperlink.mockResolvedValueOnce({
      success: false, hyperlink: undefined, error: "Sheet is protected (insert hyperlinks)",
    });
    await expect(
      executeAddHyperlink(asLib(lib), 0, 0, { type: "url", target: "https://x" }),
    ).rejects.toThrow(/protected/);
  });
});

describe("executeRemoveHyperlink", () => {
  it("removed answers true; nothing-to-remove answers false; refusals throw", async () => {
    const lib = makeLib();
    expect(await executeRemoveHyperlink(asLib(lib), 0, 0, "North")).toBe(true);
    expect(lib.removeHyperlink).toHaveBeenCalledWith(0, 0, 1);
    lib.removeHyperlink.mockResolvedValueOnce({ success: false, error: "No hyperlink at this cell" });
    expect(await executeRemoveHyperlink(asLib(lib), 5, 5)).toBe(false);
    lib.removeHyperlink.mockResolvedValueOnce({ success: false, error: "No hyperlinks on this sheet" });
    expect(await executeRemoveHyperlink(asLib(lib), 5, 5)).toBe(false);
    lib.removeHyperlink.mockResolvedValueOnce({ success: false, error: "Sheet is protected" });
    await expect(executeRemoveHyperlink(asLib(lib), 5, 5)).rejects.toThrow(/protected/);
  });
});

describe("read-back", () => {
  it("getHyperlink resolves the sheet and maps field by field", async () => {
    const lib = makeLib();
    lib.getHyperlink.mockResolvedValueOnce({
      row: 4, col: 0, sheetIndex: 2, linkType: "internalReference", target: "'South'!A1",
      internalRef: { sheetName: "South", cellReference: "A1" },
      displayText: "South", tooltip: undefined,
    });
    const h = await executeGetHyperlink(asLib(lib), 4, 0, "South");
    expect(lib.getHyperlink).toHaveBeenCalledWith(4, 0, 2);
    expect(h).toEqual({
      row: 4, col: 0, sheetIndex: 2, type: "internalReference", target: "'South'!A1",
      displayText: "South", tooltip: null, sheetName: "South", cellReference: "A1",
    });
  });

  it("listHyperlinks maps every entry; hyperlinkToScript nulls absent fields", async () => {
    const lib = makeLib();
    lib.getAllHyperlinks.mockResolvedValueOnce([
      { row: 0, col: 0, sheetIndex: 1, linkType: "url", target: "https://x" },
    ]);
    const links = await executeListHyperlinks(asLib(lib), 1);
    expect(lib.getAllHyperlinks).toHaveBeenCalledWith(1);
    expect(links).toEqual([
      {
        row: 0, col: 0, sheetIndex: 1, type: "url", target: "https://x",
        displayText: null, tooltip: null, sheetName: null, cellReference: null,
      },
    ]);
    expect(
      hyperlinkToScript({ row: 1, col: 2, sheetIndex: 0, linkType: "file", target: "C:/a" }),
    ).toMatchObject({ type: "file", displayText: null, sheetName: null });
  });
});

// ============================================================================
// (4) THE TOC MACRO: one internalReference per sheet, written by sheet NAME
// ============================================================================

describe("the table-of-contents macro shape", () => {
  it("loops the sheet list and lands one link per row on 'TOC' without activating", async () => {
    // Active sheet is North (1) on purpose: the TOC writes must still land on
    // "TOC" (0) — by NAME, through the sheet slot, no setActiveSheet call.
    const lib = makeLib(1);
    const { sheets } = await lib.getSheets();
    for (let i = 0; i < sheets.length; i++) {
      await executeAddHyperlink(
        asLib(lib),
        i, 0,
        { type: "internalReference", sheetName: sheets[i].name, cellReference: "A1" },
        { displayText: sheets[i].name },
        "TOC",
      );
    }
    expect(lib.addHyperlink).toHaveBeenCalledTimes(3);
    for (let i = 0; i < sheets.length; i++) {
      expect(lib.addHyperlink).toHaveBeenNthCalledWith(
        i + 1,
        expect.objectContaining({
          row: i, col: 0,
          sheetIndex: 0, // resolved from the NAME "TOC", not the active sheet (1)
          linkType: "internalReference",
          sheetName: sheets[i].name,
          cellReference: "A1",
          displayText: sheets[i].name,
        }),
      );
    }
  });
});

// ============================================================================
// (5) allowlist rows + the deliberate no-follow exclusion
// ============================================================================

describe("allowlist rows", () => {
  it("unlocked tier, no capability, right validators", () => {
    expect(ALLOWLIST["api.addHyperlink"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.addHyperlink"].validate).toBe(vAddHyperlink);
    expect(ALLOWLIST["api.removeHyperlink"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.removeHyperlink"].validate).toBe(vCellRef);
    expect(ALLOWLIST["api.getHyperlink"]).toMatchObject({ tier: "unlocked", class: "read" });
    expect(ALLOWLIST["api.listHyperlinks"]).toMatchObject({ tier: "unlocked", class: "read" });
    expect(ALLOWLIST["api.listHyperlinks"].validate).toBe(vSheetScopedList);
    for (const m of [
      "api.addHyperlink", "api.removeHyperlink", "api.getHyperlink", "api.listHyperlinks",
    ]) {
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
  });

  it("there is NO follow row — the exclusion is structural, not doc-only", () => {
    for (const key of Object.keys(ALLOWLIST)) {
      expect(key.toLowerCase()).not.toMatch(/hyperlink.*(follow|open)|follow.*hyperlink/);
    }
    expect(ALLOWLIST["api.followHyperlink"]).toBeUndefined();
    expect(ALLOWLIST["api.openHyperlink"]).toBeUndefined();
  });
});
