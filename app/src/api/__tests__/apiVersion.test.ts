//! FILENAME: app/src/api/__tests__/apiVersion.test.ts
// PURPOSE: API_VERSION moves one minor version for every wave that ADDS to
//          @api, and version.ts says what each version added -- each name real.
// CONTEXT: Y12 (wave E; wave D shell fix-up). Waves C and D added to the
//          extension surface (unregisterMenu / IMenuAPI.unregister with
//          keepWhileShared, the selection-ownership events,
//          SelectionOwner.receivesTyping, ExtensionRegistry.unregisterCommand,
//          the object clipboard, undo-transaction tickets) and wave E added
//          more (ownUndoTransaction, executeCommandAnywhere, the object
//          clipboard's door rule) while API_VERSION stayed 1.1.0. An extension
//          that used one could not SAY so: `apiVersion: "^1.2.0"` would have
//          been refused by this very host, and "^1.1.0" loads on a 1.1.0 host
//          that has none of it -- the extension then calls `undefined`. The
//          changelog is data so this test can check that every name it lists
//          exists (a listed name that is not there is a lie).
//
//          1.3.0 is the Home tab programme (2026-10-04): Excel's Home tab built
//          through @api -- the ExtensionCommands ids, the new CoreCommands, the
//          kit's submenus / hero splits / registered menus / colour splits, the
//          dialog launcher, the format-painter and AutoFilter state seams, and
//          the cell-shift / decimal / border-preset wrappers. The checks below
//          run over EVERY entry, so an older version's list stays honest too.
//
//          1.4.0 is the canvas owner findings programme (2026-10-15), one entry
//          for every work package. WP-A added the reference-pick seam
//          (OverlayRegistration.referenceAt, isFormulaReferencePickActive, the
//          pick preview), the copy primitive and inner clipboard door
//          (copyCellRange, innerClipboardCommand), @api/statusBarRange,
//          hasDomTextSelection and GridContextMenuItem.disabledReason.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as version from "../version";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

type Entry = { name: string; module?: string; declaredIn?: string; pattern?: string };
type Changelog = ReadonlyArray<{ version: string; added: readonly Entry[]; changed: readonly string[] }>;
const CHANGELOG = (version as unknown as { API_CHANGELOG?: Changelog }).API_CHANGELOG;

/** Resolve an "@api/x" module name to a dynamic import of src/api/x. */
async function load(mod: string): Promise<Record<string, unknown>> {
  const rel = mod === "@api" ? "index" : mod.replace(/^@api\//, "");
  return (await import(/* @vite-ignore */ `../${rel}`)) as Record<string, unknown>;
}

const entry = (v: string) => CHANGELOG?.find((e) => e.version === v);
const names = (v: string): Set<string> => new Set(entry(v)?.added.map((e) => e.name) ?? []);

describe("API_VERSION", () => {
  it("is 1.4.0 (the canvas owner findings programme added to @api)", () => {
    expect(version.API_VERSION).toBe("1.4.0");
  });

  it("carries a changelog whose newest entry IS the current version", () => {
    expect(Array.isArray(CHANGELOG), "version.ts exports no API_CHANGELOG").toBe(true);
    expect(CHANGELOG![0].version).toBe(version.API_VERSION);
  });

  it("lists the versions newest first, each once", () => {
    const versions = CHANGELOG!.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
    const sorted = [...versions].sort((a, b) => {
      const [am, an, ap] = a.split(".").map(Number);
      const [bm, bn, bp] = b.split(".").map(Number);
      return bm - am || bn - an || bp - ap;
    });
    expect(versions).toEqual(sorted);
  });
});

describe("the 1.2.0 changelog names what waves C-E added", () => {
  const REQUIRED = [
    "unregisterMenu",
    "IMenuAPI.unregister",
    "onSelectionOwnershipChanged",
    "notifySelectionOwnershipChanged",
    "SelectionOwner.receivesTyping",
    "ExtensionRegistry.unregisterCommand",
    "copySelectedObjects",
    "pasteObjectClipboard",
    "clipboardDoorCommand",
    "readUndoBeginAnswer",
    "ownUndoTransaction",
    "executeCommandAnywhere",
  ];

  it("lists every wave C-E addition", () => {
    const listed = names("1.2.0");
    for (const n of REQUIRED) expect(listed.has(n), `1.2.0's changelog does not list ${n}`).toBe(true);
  });
});

describe("the 1.3.0 changelog names what the Home tab programme added", () => {
  // One or more names from every wave-1 lane's @api additions, so a lane's
  // addition dropped from the entry fails here by name.
  const REQUIRED = [
    // commands.ts: the extension-owned ids, and the new core.* ones.
    "ExtensionCommands",
    "CoreCommands.PASTE_TRANSPOSE",
    "CoreCommands.REMOVE_HYPERLINKS",
    "CoreCommands.INSERT_CELLS",
    "CoreCommands.AUTOFIT_ROW_HEIGHT",
    "CoreCommands.SHEET_TAB_COLOR",
    "CoreCommands.INSERT_FUNCTION",
    // New @api modules.
    "useFormatPainterState",
    "internalClipboardIsCurrent",
    "processPendingFills",
    "navigateToReference",
    // autoFilterService's state seam.
    "onChange",
    "getAutoFilterStatus",
    "AutoFilterController.reapply",
    // objectClipboard's worksheet-control door ids.
    "WORKSHEET_CONTROL_COPY_COMMAND",
    "WORKSHEET_CONTROL_PASTE_COMMAND",
    // The layout kit.
    "MenuSub",
    "MENU_ICON_BLANK",
    "useMenuClose",
    "RegisteredMenuButton",
    "useRegisteredMenuItem",
    "ColorPalette",
    "SplitMenuButtonProps.face",
    "CommandButtonProps.labelLines",
    "ColorSwatchProps.split",
    "ColorSwatchProps.onApply",
    // The dialog launcher.
    "PanelSection.dialogLauncher",
    // Backend wrappers and types.
    "adjustNumberFormatDecimals",
    "applyBorderPresetToSheets",
    "insertCellsRange",
    "deleteCellsRange",
    "TextRotation",
    "AccountingLayout",
  ];

  it("lists every wave-1 addition", () => {
    const listed = names("1.3.0");
    expect(entry("1.3.0"), "API_CHANGELOG has no 1.3.0 entry").toBeDefined();
    for (const n of REQUIRED) expect(listed.has(n), `1.3.0's changelog does not list ${n}`).toBe(true);
  });

  it("says what CHANGED meaning, not only what was added", () => {
    const changed = (entry("1.3.0")?.changed ?? []).join("\n");
    for (const word of [
      "clipboardDoorCommand",
      "FORMAT_PAINTER_LOCK",
      "INSERT_ROW",
      "CLEAR_COMMENTS",
      "F5",
      "Ctrl+G",
    ]) {
      expect(changed, `1.3.0's "changed" says nothing about ${word}`).toContain(word);
    }
  });
});

describe("the 1.4.0 changelog names what WP-A (picks and pivot cells) added", () => {
  // Every WP-A @api addition, so one dropped from the entry fails here by name.
  const REQUIRED = [
    "OverlayRegistration.referenceAt",
    "OverlayReferencePick",
    "OverlayReferenceAtFn",
    "referenceAtPoint",
    "getFloatingReferencePickPreview",
    "onFloatingReferencePickPreviewChanged",
    "FloatingReferencePickRange",
    "FloatingReferencePickPreview",
    "isFormulaReferencePickActive",
    "copyCellRange",
    "CellRangeCopyRequest",
    "CellRangeCopyResult",
    "ObjectSelectionProvider.innerClipboardCommand",
    "innerSelectionClipboardCommand",
    "publishStatusBarRange",
    "getStatusBarRange",
    "subscribeStatusBarRange",
    "StatusBarRange",
    "hasDomTextSelection",
    "GridContextMenuItem.disabledReason",
  ];

  it("lists every WP-A addition", () => {
    const listed = names("1.4.0");
    expect(entry("1.4.0"), "API_CHANGELOG has no 1.4.0 entry").toBeDefined();
    for (const n of REQUIRED) expect(listed.has(n), `1.4.0's changelog does not list ${n}`).toBe(true);
  });

  it("says what CHANGED meaning: the pick press, the clipboard door, the disabled reason", () => {
    const changed = (entry("1.4.0")?.changed ?? []).join("\n");
    for (const word of ["isFormulaReferencePickActive", "INERT", "clipboardDoorCommand", "innerClipboardCommand", "disabledReason"]) {
      expect(changed, `1.4.0's "changed" says nothing about ${word}`).toContain(word);
    }
  });
});

describe("every name in every changelog entry is real", () => {
  it("every runtime export listed exists where it says", async () => {
    for (const e of CHANGELOG?.flatMap((v) => v.added) ?? []) {
      if (!e.module) continue;
      const mod = await load(e.module);
      const exportName = e.name.includes(".") ? e.name.split(".")[0] : e.name;
      const value = mod[exportName];
      expect(value, `${e.name} is listed as exported by ${e.module}, which does not export it`).toBeDefined();
      if (e.name.includes(".")) {
        const member = e.name.split(".")[1];
        expect(
          (value as Record<string, unknown>)[member],
          `${e.name}: ${exportName} has no member ${member}`,
        ).toBeDefined();
      }
    }
  }, 120_000);

  it("every declared (type-only) member listed is declared where it says", () => {
    for (const e of CHANGELOG?.flatMap((v) => v.added) ?? []) {
      if (!e.declaredIn) continue;
      expect(e.pattern, `${e.name} names a file but no declaration pattern`).toBeTruthy();
      expect(read(e.declaredIn), `${e.name} is not declared in ${e.declaredIn}`).toMatch(new RegExp(e.pattern!));
    }
  });

  it("every entry says where its name lives (a runtime module, or a declaring file)", () => {
    for (const e of CHANGELOG?.flatMap((v) => v.added) ?? []) {
      expect(!!e.module || !!e.declaredIn, `${e.name} says neither module nor declaredIn`).toBe(true);
    }
  });
});
