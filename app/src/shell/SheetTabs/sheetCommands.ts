//! FILENAME: app/src/shell/SheetTabs/sheetCommands.ts
// PURPOSE: The core.sheet.* commands -- Excel's Insert Sheet, Delete Sheet,
//          Rename Sheet, Hide / Unhide Sheet, Tab Color and Move or Copy
//          Sheet... (Home > Cells, and Shift+F11) -- and the CONTROLLER seat
//          through which they reach the sheet tab strip.
// CONTEXT: The tab strip (SheetTabs.tsx) owns every sheet-structure change:
//          each one ends in its commit-before-switch steps (`sheet:beforeSwitch`,
//          the canvas prime, the Redux sheet context, `sheet:normalSwitch`,
//          SHEET_CHANGED). The raw @api `addSheet` / `deleteSheet` wrappers skip
//          all of that, so a command that called them left the grid painting
//          the old sheet under the new tab. The commands therefore never touch
//          the backend: they decide WHICH sheet and WHETHER (the refusals below),
//          and hand the doing to the strip.
//
//          The strip is a component and mounts after bootstrap registers these
//          commands, so it SEATS a controller here on mount and releases it on
//          unmount. With no strip seated a command does nothing and says why in
//          the console -- there is no sheet UI to act through.
//
//          Every command acts on the ACTIVE sheet; `{ index }` names another
//          (a TRUE workbook index, as everything here). Protection's guarded
//          Rename override uses that to rename the right-clicked tab through
//          the one rename prompt (renameSheetPrompt.ts).
//
//          INSERT also takes `{ kind: "worksheet" | "canvas" }` (default a
//          worksheet) and `{ atEnd: true }` (append, the strip's own "+",
//          instead of inserting before the anchor). That is the PUBLIC door for
//          adding a canvas page: the Canvas tab's New Page and the tab menu's
//          Insert Canvas both run it, so neither reaches into the strip's
//          private `sheet:requestAdd` event and every sheet insert shares one
//          set of refusals (review finding 2026-10-08).
//
//          REFUSALS that can be answered synchronously from the strip's
//          snapshot are registered with the command-refusal registry
//          (@api/commandRefusals), so every door -- the ribbon, the keyboard,
//          the command line -- refuses them the same way, with one toast, and a
//          menu can ask `commandRefusalFor(id)` to grey an item: the strip is
//          mid-formula (structural changes are locked), or Unhide with nothing
//          hidden (Excel greys "Unhide Sheet..." then). Refusals that depend on
//          the command's own arguments (the last visible sheet, a bad colour)
//          are answered by the handler with the same one toast.
//
//          None of these is script-safe: they change the workbook's STRUCTURE,
//          which no grid-data API grants a script (CommandOptions.scriptSafe is
//          an audited opt-in).

import { CommandRegistry, CoreCommands } from "@api/commands";
import { addCommandRefusal } from "@api/commandRefusals";
import { showToast } from "@api/notifications";
import { DialogExtensions } from "@api/ui";
import type { SheetInfo, SheetKindName } from "../../core/lib/tauri-api";
import { promptForSheetName } from "./renameSheetPrompt";
import {
  MoveOrCopySheetDialog,
  MOVE_OR_COPY_SHEET_DIALOG_ID,
  type MoveOrCopySheetChoice,
  type MoveOrCopySheetData,
} from "../dialogs/MoveOrCopySheetDialog";

// ============================================================================
// The controller seat
// ============================================================================

/** What the strip knows right now. Read synchronously by the refusals. */
export interface SheetTabsSnapshot {
  /** Every USER sheet, hidden ones included, each with its TRUE index. */
  sheets: readonly SheetInfo[];
  /** The active sheet's TRUE index. */
  activeIndex: number;
  /** A formula is being written: adding, removing or reordering sheets would
   *  move the sheet the formula belongs to underneath it. */
  locked: boolean;
}

/** The strip's own handlers, by what they do. Every index is a TRUE index. */
export interface SheetTabsController {
  snapshot(): SheetTabsSnapshot;
  /** A new sheet (a worksheet unless `kind` says otherwise) immediately
   *  before `beforeIndex`, made active. */
  insertSheetBefore(beforeIndex: number, kind?: SheetKindName): Promise<void>;
  /** A new sheet at the END (the strip's "+"), made active. */
  appendSheet(kind?: SheetKindName): Promise<void>;
  /** Delete; the strip asks first when the sheet holds anything (Excel). */
  deleteSheet(index: number): Promise<void>;
  renameSheet(index: number, newName: string): Promise<void>;
  hideSheet(index: number): Promise<void>;
  /** The strip's Unhide dialog (the list of hidden sheets). */
  openUnhideDialog(): Promise<void>;
  /** `""` clears the colour. */
  setTabColor(index: number, color: string): Promise<void>;
  /** `beforeIndex` null is the end. */
  moveOrCopySheet(sourceIndex: number, beforeIndex: number | null, copy: boolean): Promise<void>;
}

let seated: SheetTabsController | null = null;

/**
 * Seat the strip's controller (SheetTabs does, on mount). Returns the release,
 * which only unseats THIS controller: a remount's new strip can seat itself
 * before the old one's cleanup runs, and that cleanup must not unseat it.
 */
export function registerSheetTabsController(controller: SheetTabsController): () => void {
  seated = controller;
  return () => {
    if (seated === controller) seated = null;
  };
}

/** The seated controller, or null when no sheet tab strip is mounted. */
export function getSheetTabsController(): SheetTabsController | null {
  return seated;
}

// ============================================================================
// Refusals
// ============================================================================

const SHEET_COMMAND_IDS: readonly string[] = [
  CoreCommands.SHEET_INSERT,
  CoreCommands.SHEET_DELETE,
  CoreCommands.SHEET_RENAME,
  CoreCommands.SHEET_HIDE,
  CoreCommands.SHEET_UNHIDE,
  CoreCommands.SHEET_TAB_COLOR,
  CoreCommands.SHEET_MOVE_OR_COPY,
];

const LOCKED = "Finish editing the formula first: sheets cannot be added, removed, renamed or moved while a formula is being written.";
const NO_HIDDEN = "No sheets are hidden.";
// Excel's own sentence for both Hide and Delete of the last visible sheet.
const LAST_VISIBLE = "A workbook must contain at least one visible worksheet.";
const CANVAS_COPY = "A canvas sheet cannot be copied yet: its objects would not come along.";
const BAD_COLOR = "Tab Color takes a color such as #FF0000, or null for No Color.";

/** One toast, as the refusal registry shows its own. */
function refuse(message: string): void {
  showToast(message, { variant: "info" });
}

/** Sheets Excel's Unhide dialog lists. A veryHidden sheet is not among them:
 *  only code can show it (the strip's own dialog filters the same way). */
function hiddenSheets(snapshot: SheetTabsSnapshot): SheetInfo[] {
  return snapshot.sheets.filter((s) => s.visibility === "hidden");
}

/** The synchronous refusals (asked by every door before the handler runs). */
function refusalFor(commandId: string): string | null {
  const controller = seated;
  if (!controller) return null;
  const snapshot = controller.snapshot();
  if (snapshot.locked) return LOCKED;
  if (commandId === CoreCommands.SHEET_UNHIDE && hiddenSheets(snapshot).length === 0) return NO_HIDDEN;
  return null;
}

// ============================================================================
// Handlers
// ============================================================================

/** The seated controller, or null with a console note (nothing to act through). */
function controllerFor(commandId: string): SheetTabsController | null {
  if (!seated) {
    console.warn(`[sheetCommands] ${commandId}: no sheet tab strip is mounted; nothing to act on.`);
  }
  return seated;
}

/** `args.index` when it is a number, else the active sheet; refused when unlisted. */
function targetSheet(controller: SheetTabsController, args: unknown): SheetInfo | null {
  const snapshot = controller.snapshot();
  const requested = (args as { index?: unknown } | null | undefined)?.index;
  const index = typeof requested === "number" ? requested : snapshot.activeIndex;
  const sheet = snapshot.sheets.find((s) => s.index === index);
  if (!sheet) {
    refuse(`There is no sheet at index ${index}.`);
    return null;
  }
  return sheet;
}

/** True when `sheet` is the only VISIBLE sheet (hiding or deleting it is refused). */
function isLastVisible(snapshot: SheetTabsSnapshot, sheet: SheetInfo): boolean {
  if (sheet.visibility !== "visible") return false;
  return !snapshot.sheets.some((s) => s.index !== sheet.index && s.visibility === "visible");
}

/** `{ color }` as the backend stores it: a hex colour, or `""` for No Color. */
function parseTabColor(args: unknown): string | null {
  if (typeof args !== "object" || args === null || !("color" in args)) return null;
  const color = (args as { color: unknown }).color;
  if (color === null) return "";
  if (typeof color === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return color;
  return null;
}

/** The kinds of sheet core.sheet.insert can add. */
const SHEET_INSERT_KINDS: readonly SheetKindName[] = ["worksheet", "canvas"];

/** `args.kind`: undefined (a worksheet), a known kind, or null when it names
 *  something else (refused by name, never guessed into a worksheet). */
function insertKind(args: unknown): SheetKindName | undefined | null {
  const kind = (args as { kind?: unknown } | null | undefined)?.kind;
  if (kind === undefined) return undefined;
  if (typeof kind === "string" && (SHEET_INSERT_KINDS as readonly string[]).includes(kind)) {
    return kind as SheetKindName;
  }
  refuse(`There is no kind of sheet called "${String(kind).slice(0, 40)}" (use "worksheet" or "canvas").`);
  return null;
}

async function insertSheet(args: unknown): Promise<void> {
  const controller = controllerFor(CoreCommands.SHEET_INSERT);
  if (!controller) return;
  const kind = insertKind(args);
  if (kind === null) return;
  if ((args as { atEnd?: unknown } | null | undefined)?.atEnd === true) {
    await controller.appendSheet(kind);
    return;
  }
  const anchor = targetSheet(controller, args);
  if (!anchor) return;
  if (kind === undefined) await controller.insertSheetBefore(anchor.index);
  else await controller.insertSheetBefore(anchor.index, kind);
}

async function deleteSheet(args: unknown): Promise<void> {
  const controller = controllerFor(CoreCommands.SHEET_DELETE);
  if (!controller) return;
  const sheet = targetSheet(controller, args);
  if (!sheet) return;
  // Before any confirmation: asking "delete this sheet?" and then refusing is
  // a question that never had a yes.
  if (isLastVisible(controller.snapshot(), sheet)) {
    refuse(LAST_VISIBLE);
    return;
  }
  await controller.deleteSheet(sheet.index);
}

async function renameSheet(args: unknown): Promise<void> {
  const controller = controllerFor(CoreCommands.SHEET_RENAME);
  if (!controller) return;
  const sheet = targetSheet(controller, args);
  if (!sheet) return;
  const newName = await promptForSheetName(sheet.name);
  if (newName === null) return;
  await controller.renameSheet(sheet.index, newName);
}

async function hideSheet(args: unknown): Promise<void> {
  const controller = controllerFor(CoreCommands.SHEET_HIDE);
  if (!controller) return;
  const sheet = targetSheet(controller, args);
  if (!sheet) return;
  if (isLastVisible(controller.snapshot(), sheet)) {
    refuse(LAST_VISIBLE);
    return;
  }
  await controller.hideSheet(sheet.index);
}

async function unhideSheet(): Promise<void> {
  const controller = controllerFor(CoreCommands.SHEET_UNHIDE);
  if (!controller) return;
  // The refusal registry already asked; asked again in case the strip's list
  // moved between the two (the dialog would open empty).
  if (hiddenSheets(controller.snapshot()).length === 0) {
    refuse(NO_HIDDEN);
    return;
  }
  await controller.openUnhideDialog();
}

async function setTabColor(args: unknown): Promise<void> {
  const controller = controllerFor(CoreCommands.SHEET_TAB_COLOR);
  if (!controller) return;
  const color = parseTabColor(args);
  if (color === null) {
    refuse(BAD_COLOR);
    return;
  }
  const sheet = targetSheet(controller, args);
  if (!sheet) return;
  await controller.setTabColor(sheet.index, color);
}

async function moveOrCopySheet(args: unknown): Promise<void> {
  const controller = controllerFor(CoreCommands.SHEET_MOVE_OR_COPY);
  if (!controller) return;
  const sheet = targetSheet(controller, args);
  if (!sheet) return;
  const snapshot = controller.snapshot();
  const visible = snapshot.sheets.filter((s) => s.visibility === "visible");
  const canCopy = sheet.kind !== "canvas";

  const run = async (choice: MoveOrCopySheetChoice): Promise<void> => {
    if (choice.copy && !canCopy) {
      refuse(CANVAS_COPY);
      return;
    }
    // The strip seated NOW (the dialog may have outlived a remount).
    const current = getSheetTabsController();
    if (!current) return;
    await current.moveOrCopySheet(sheet.index, choice.beforeIndex, choice.copy);
  };

  // Arguments run it without the dialog (scripts' executeCommand is refused
  // these anyway -- not script-safe -- but the command line and tests use it).
  if (typeof args === "object" && args !== null && "beforeIndex" in args) {
    const beforeIndex = (args as { beforeIndex: unknown }).beforeIndex;
    if (beforeIndex !== null && !(typeof beforeIndex === "number" && visible.some((s) => s.index === beforeIndex))) {
      refuse(`There is no visible sheet at index ${String(beforeIndex)} to place it before.`);
      return;
    }
    await run({ beforeIndex: beforeIndex as number | null, copy: (args as { copy?: unknown }).copy === true });
    return;
  }

  const data: MoveOrCopySheetData = {
    sourceIndex: sheet.index,
    sourceName: sheet.name,
    sheets: visible.map((s) => ({ index: s.index, name: s.name })),
    canCopy,
    onResult: run,
  };
  DialogExtensions.openDialog(MOVE_OR_COPY_SHEET_DIALOG_ID, data as unknown as Record<string, unknown>);
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register the seven core.sheet.* commands, their refusals and the Move or
 * Copy dialog. Called once by `registerCoreSheetContextMenu` (bootstrap).
 * Returns the cleanup (tests).
 *
 * One `register(CoreCommands.X, ...)` per command, spelled out: the built-in
 * shortcut census (builtinShortcutCensus.test.ts) reads registrations from the
 * source, and Shift+F11 is bound to core.sheet.insert.
 */
export function registerSheetCommands(): () => void {
  DialogExtensions.registerDialog({
    id: MOVE_OR_COPY_SHEET_DIALOG_ID,
    component: MoveOrCopySheetDialog,
    priority: 300,
  });

  CommandRegistry.register(CoreCommands.SHEET_INSERT, (args) => insertSheet(args));
  CommandRegistry.register(CoreCommands.SHEET_DELETE, (args) => deleteSheet(args));
  CommandRegistry.register(CoreCommands.SHEET_RENAME, (args) => renameSheet(args));
  CommandRegistry.register(CoreCommands.SHEET_HIDE, (args) => hideSheet(args));
  CommandRegistry.register(CoreCommands.SHEET_UNHIDE, () => unhideSheet());
  CommandRegistry.register(CoreCommands.SHEET_TAB_COLOR, (args) => setTabColor(args));
  CommandRegistry.register(CoreCommands.SHEET_MOVE_OR_COPY, (args) => moveOrCopySheet(args));

  const releaseRefusal = addCommandRefusal({
    commandIds: SHEET_COMMAND_IDS,
    refuse: refusalFor,
  });

  return () => {
    releaseRefusal();
    for (const id of SHEET_COMMAND_IDS) CommandRegistry.unregister(id);
    DialogExtensions.unregisterDialog(MOVE_OR_COPY_SHEET_DIALOG_ID);
  };
}
