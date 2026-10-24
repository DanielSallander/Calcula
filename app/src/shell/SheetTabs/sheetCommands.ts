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
//          the one rename prompt (renameSheetPrompt.ts). Only an ABSENT
//          `index` means "the active sheet": one that is present but not a
//          whole number ("0", 1.5, null) is refused by name with one toast,
//          never read as absent -- the command line's `command <id> = <json>`
//          runs without a confirm card, and a typo there silently moved,
//          coloured or deleted the active sheet instead (review
//          SHEET-COMMAND-MALFORMED-INDEX-RETARGETS-ACTIVE). The same holds
//          for Move or Copy's `beforeIndex` and `copy` and Insert's `atEnd`.
//          And for the arguments as a WHOLE: only ABSENT arguments mean every
//          default. Arguments that are present but not a plain object -- a bare
//          number, a string, a boolean, an array, or null (`command
//          core.sheet.hide = 1`) -- are refused with one toast naming the shape
//          the command takes, never read as "no index" (review
//          SHEET-COMMAND-NON-OBJECT-ARGS-RETARGET-ACTIVE: `= 1` hid the ACTIVE
//          sheet, and `core.sheet.delete = 2` deleted a blank active sheet
//          without asking). ONE guard, `objectArgs`, asked first by every
//          handler that takes an index.
//
//          An index names a sheet only at the moment it is read: a temporary
//          sheet's discard renumbers every sheet after it, at any time
//          (model-drillthrough.md 2.7). So a command turns its index into the
//          sheet's STABLE id against the snapshot it just read, and whatever
//          it awaits afterwards -- Rename's prompt, Move or Copy's dialog --
//          it hands the strip that id. The strip finds the sheet again by id
//          once every discard already sent has answered, and refuses with a
//          toast when it is gone (SheetTabs.tsx `resolveDoorTargets`).
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
//
//          One more door, for a TEMPORARY sheet (a drill-through's result,
//          docs/design/model-drillthrough.md 2.7): `core.sheet.discardEphemeral
//          { sheetId }` runs the strip's own discard body -- the one its leave
//          observer runs when the user leaves such a sheet -- for the sheet with
//          that STABLE id. The id travels to the backend as it is
//          (`discard_ephemeral_sheet`), which finds the sheet's CURRENT index in
//          the same command that deletes it; no index is resolved here, because
//          an index read from the strip's list can name another sheet by the
//          time the delete lands. The drill runner takes it before adding the
//          next result sheet while the active one is still temporary (the
//          backend's `toSheet` refuses otherwise), and it RESOLVES to whether
//          the sheet is gone: true once the discard landed (or a discard of the
//          same id already in flight did, which it awaits), and true with no
//          toast when the backend refused because the sheet no longer exists
//          (another door deleted it, so a fresh read says it is gone); false on
//          every other refusal -- each toasted once, here or by the strip, so
//          the runner adds no toast of its own. It never lands inside one of
//          the strip's own doors -- between the read that finds a door's sheet
//          and the step that acts on it, or between the two steps of Insert
//          Sheet or Move or Copy: it waits for such a door to settle. It
//          refuses an ordinary sheet: it never asks, so it must never be a way
//          to delete one.

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

/**
 * The strip's own handlers, by what they do. Every index is a TRUE index, and
 * names the sheet it names in the strip's list AT THE MOMENT OF THE CALL: a
 * caller passes an index only when it read it from `snapshot()` without
 * awaiting anything since, and the strip takes that sheet's stable id at once
 * (a discard landing later then cannot move the call onto another sheet). A
 * caller that awaits between reading and calling -- a prompt, a dialog --
 * passes the STABLE id it read instead.
 */
export interface SheetTabsController {
  snapshot(): SheetTabsSnapshot;
  /** A new sheet (a worksheet unless `kind` says otherwise) immediately
   *  before `beforeIndex`, made active. */
  insertSheetBefore(beforeIndex: number, kind?: SheetKindName): Promise<void>;
  /** A new sheet at the END (the strip's "+"), made active. */
  appendSheet(kind?: SheetKindName): Promise<void>;
  /** Delete; the strip asks first when the sheet holds anything (Excel). */
  deleteSheet(index: number): Promise<void>;
  /**
   * Discard a TEMPORARY (drill-through) sheet WITHOUT asking, by its STABLE id:
   * the strip's own discard body, the one its leave observer runs -- no switch
   * steps, the backend resolves the id to the sheet's index at the moment of
   * deletion, a refusal keeps the sheet and toasts once (model-drillthrough.md
   * 2.7). Resolves true once the sheet is gone -- a second request for the
   * same id AWAITS the first one's answer; a refusal for a sheet a fresh read
   * shows gone is true too, with no toast -- and false on any other refusal,
   * which it has already told the user about. Waits for the strip's own
   * doors in flight (each from its fresh read to its last step) to settle
   * before it sends anything.
   */
  discardSheet(sheetId: string): Promise<boolean>;
  /**
   * Make a TEMPORARY sheet an ordinary one (the tab's double-click; Keep
   * Sheet), by the STABLE id the caller saw. Says "Sheet kept" only when the
   * answered list holds that sheet unflagged; otherwise says it is still
   * temporary, or gone. `undefined` (a list without ids) is refused with a toast.
   */
  keepSheet(sheetId: string | undefined): Promise<void>;
  /**
   * `sheetId`: the STABLE id read together with `index`, BEFORE the prompt
   * was awaited -- the sheet the user named. Without it the strip takes the
   * sheet at `index` now.
   */
  renameSheet(index: number, newName: string, sheetId?: string): Promise<void>;
  hideSheet(index: number): Promise<void>;
  /** The strip's Unhide dialog (the list of hidden sheets). */
  openUnhideDialog(): Promise<void>;
  /** `""` clears the colour. */
  setTabColor(index: number, color: string): Promise<void>;
  /**
   * The sheet with STABLE id `sourceSheetId` -- or a copy of it -- before the
   * sheet with id `beforeSheetId`, or at the end (null). By id because the
   * dialog that chose them can outlive the indices it was opened with; the
   * strip refuses with a toast when either sheet is gone, and never reads a
   * gone target as "(move to end)".
   */
  moveOrCopySheet(sourceSheetId: string, beforeSheetId: string | null, copy: boolean): Promise<void>;
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

/**
 * `core.sheet.discardEphemeral { sheetId }`: discard a TEMPORARY (drill-through)
 * sheet by its STABLE id (model-drillthrough.md 2.7, "Drill-from-drill"). The
 * id is spelled here, not in `CoreCommands` (api/commands.ts is the facade's
 * file); a caller outside the shell runs it by this literal.
 */
export const SHEET_DISCARD_EPHEMERAL_COMMAND = "core.sheet.discardEphemeral";

/**
 * The commands the command-refusal registry refuses while the strip is locked.
 * `core.sheet.discardEphemeral` is NOT among them, though the lock refuses it
 * too: a registry refusal returns before the handler runs, so the command
 * could not RESOLVE to its boolean (false) -- its handler asks the lock itself,
 * with the same sentence and the same one toast.
 */
const SHEET_COMMAND_IDS: readonly string[] = [
  CoreCommands.SHEET_INSERT,
  CoreCommands.SHEET_DELETE,
  CoreCommands.SHEET_RENAME,
  CoreCommands.SHEET_HIDE,
  CoreCommands.SHEET_UNHIDE,
  CoreCommands.SHEET_TAB_COLOR,
  CoreCommands.SHEET_MOVE_OR_COPY,
];

/**
 * THE structural lock's one sentence: the refusal registry's, the discard
 * door's, and the tab strip's own re-check of the lock after a door's wait
 * (SheetTabs.tsx `runSheetDoor`) -- one sentence, so the doors that refuse the
 * same fact cannot drift apart.
 */
export const STRUCTURE_LOCKED =
  "Finish editing the formula first: sheets cannot be added, removed, renamed or moved while a formula is being written.";
const LOCKED = STRUCTURE_LOCKED;
const NO_HIDDEN = "No sheets are hidden.";
// Excel's own sentence for both Hide and Delete of the last visible sheet.
const LAST_VISIBLE = "A workbook must contain at least one visible worksheet.";
const CANVAS_COPY = "A canvas sheet cannot be copied yet: its objects would not come along.";
const BAD_COLOR = "Tab Color takes a color such as #FF0000, or null for No Color.";
const NO_SHEET_ID = "core.sheet.discardEphemeral takes { sheetId }: the stable id of the temporary sheet to discard.";
const NO_STRIP = "The temporary sheet cannot be closed: there is no sheet tab strip to close it through.";
const NOT_EPHEMERAL = (name: string) =>
  `Only a temporary (drill-through) sheet can be discarded this way; "${name}" is an ordinary sheet.`;
// Only against a backend too old to report stable ids: without one the sheet
// cannot be followed through a dialog that a renumbering can outlive.
const NO_IDENTITY = (name: string) =>
  `"${name}" cannot be moved or copied: the workbook did not report which sheet it is.`;

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

/** What an argument reader answers once it has REFUSED a malformed value (its one toast is shown). */
const MALFORMED = Symbol("malformed argument");

/** A command's arguments once `objectArgs` checked their shape: always a plain object. */
type CommandArgs = Readonly<Record<string, unknown>>;

/**
 * The shape each index-taking command's arguments must have, as its refusal
 * names it (every key optional; `index` defaults to the active sheet).
 */
const ARGS_SHAPE: Readonly<Record<string, string>> = {
  [CoreCommands.SHEET_INSERT]: '{ "index": 0 }',
  [CoreCommands.SHEET_DELETE]: '{ "index": 0 }',
  [CoreCommands.SHEET_RENAME]: '{ "index": 0 }',
  [CoreCommands.SHEET_HIDE]: '{ "index": 0 }',
  [CoreCommands.SHEET_TAB_COLOR]: '{ "index": 0, "color": "#FF0000" }',
  [CoreCommands.SHEET_MOVE_OR_COPY]: '{ "index": 0, "beforeIndex": 1, "copy": false }',
};

/**
 * THE one guard on a command's arguments as a WHOLE, asked FIRST by every
 * handler that takes an index -- before any reader below, before the target
 * sheet is resolved, before a prompt or a dialog. ABSENT arguments (undefined:
 * the keyboard, the ribbon, `command <id>` with no `=`) are `{}`: every
 * default, the active sheet. A plain object is checked field by field by the
 * readers. ANYTHING ELSE that is present -- a number, a string, a boolean, an
 * array, or null -- is MALFORMED: refused once, naming the shape the command
 * takes, never read as "no index". `command core.sheet.hide = 1` hid the
 * ACTIVE sheet, and `command core.sheet.delete = 2` deleted a blank active
 * sheet without asking, ending the undo history (review
 * SHEET-COMMAND-NON-OBJECT-ARGS-RETARGET-ACTIVE). No production door passes
 * null, and `{ "index": null }` is already refused, so a bare null is too.
 */
function objectArgs(commandId: string, args: unknown): CommandArgs | typeof MALFORMED {
  if (args === undefined) return {};
  if (typeof args === "object" && args !== null && !Array.isArray(args)) return args as CommandArgs;
  refuse(`${commandId} takes ${ARGS_SHAPE[commandId] ?? "an object"} (got ${shown(args)}).`);
  return MALFORMED;
}

/** `args[field]`: undefined when the (already shape-checked) arguments lack the field. */
function fieldOf(args: CommandArgs, field: string): unknown {
  return args[field];
}

/** A value as a refusal quotes it: a string in quotes, anything else as JSON, kept short. */
function shown(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = `"${value}"`;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

/**
 * A sheet-index argument as the command was given it: undefined when the field
 * is ABSENT (the caller means its default), the number when it is a whole
 * number, null only where `nullMeans` allows it (Move or Copy's "(move to
 * end)"), and MALFORMED -- refused once, by name -- for anything else that is
 * PRESENT. A malformed index is never read as absent: that turned
 * `{"index":"1"}` into "the active sheet" (review
 * SHEET-COMMAND-MALFORMED-INDEX-RETARGETS-ACTIVE).
 */
function indexArg(
  args: CommandArgs,
  field: "index" | "beforeIndex",
  nullMeans?: "end",
): number | null | undefined | typeof MALFORMED {
  const value = fieldOf(args, field);
  if (value === undefined) return undefined;
  if (value === null && nullMeans === "end") return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  refuse(`"${field}" takes a sheet's number, such as 0 (got ${shown(value)}).`);
  return MALFORMED;
}

/** A yes/no argument: false when ABSENT, the boolean itself, or MALFORMED -- refused once, by name -- for anything else. */
function booleanArg(args: CommandArgs, field: "copy" | "atEnd"): boolean | typeof MALFORMED {
  const value = fieldOf(args, field);
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  refuse(`"${field}" takes true or false (got ${shown(value)}).`);
  return MALFORMED;
}

/**
 * The sheet `args.index` names, else -- only when `index` is ABSENT -- the
 * active sheet. A malformed index and an index the strip does not list are
 * each refused with one toast; neither ever falls back to the active sheet.
 */
function targetSheet(controller: SheetTabsController, args: CommandArgs): SheetInfo | null {
  const requested = indexArg(args, "index");
  if (requested === MALFORMED) return null;
  const snapshot = controller.snapshot();
  const index = requested ?? snapshot.activeIndex;
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
function parseTabColor(args: CommandArgs): string | null {
  if (!("color" in args)) return null;
  const color = args.color;
  if (color === null) return "";
  if (typeof color === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return color;
  return null;
}

/** The kinds of sheet core.sheet.insert can add. */
const SHEET_INSERT_KINDS: readonly SheetKindName[] = ["worksheet", "canvas"];

/** `args.kind`: undefined (a worksheet), a known kind, or null when it names
 *  something else (refused by name, never guessed into a worksheet). */
function insertKind(args: CommandArgs): SheetKindName | undefined | null {
  const kind = fieldOf(args, "kind");
  if (kind === undefined) return undefined;
  if (typeof kind === "string" && (SHEET_INSERT_KINDS as readonly string[]).includes(kind)) {
    return kind as SheetKindName;
  }
  refuse(`There is no kind of sheet called "${String(kind).slice(0, 40)}" (use "worksheet" or "canvas").`);
  return null;
}

async function insertSheet(rawArgs: unknown): Promise<void> {
  const args = objectArgs(CoreCommands.SHEET_INSERT, rawArgs);
  if (args === MALFORMED) return;
  const controller = controllerFor(CoreCommands.SHEET_INSERT);
  if (!controller) return;
  const kind = insertKind(args);
  if (kind === null) return;
  const atEnd = booleanArg(args, "atEnd");
  if (atEnd === MALFORMED) return;
  if (atEnd) {
    await controller.appendSheet(kind);
    return;
  }
  const anchor = targetSheet(controller, args);
  if (!anchor) return;
  if (kind === undefined) await controller.insertSheetBefore(anchor.index);
  else await controller.insertSheetBefore(anchor.index, kind);
}

async function deleteSheet(rawArgs: unknown): Promise<void> {
  const args = objectArgs(CoreCommands.SHEET_DELETE, rawArgs);
  if (args === MALFORMED) return;
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

/**
 * Discard a TEMPORARY sheet by its STABLE id (model-drillthrough.md 2.7),
 * resolving to whether the sheet is gone (C7).
 *
 * The id goes to the strip -- and on to the backend -- AS IT IS. Never an
 * index resolved here: the caller read the sheet before an insert, a copy or a
 * move may have shifted its index, and the strip's list can lag the backend
 * the other way (a result sheet added a moment ago is not in it yet). The
 * backend resolves the id at the moment of deletion and refuses an id it does
 * not know or no longer flags; the strip toasts that refusal once.
 *
 * Refused HERE, each with one toast: no strip seated, the structure lock (a
 * formula is being written), no `{ sheetId }`, and a sheet the strip lists as
 * ORDINARY -- the strip's discard never asks, so this door must never become a
 * way to delete one (a sheet's temporary flag only ever goes away, so a sheet
 * listed as ordinary IS ordinary). Otherwise the strip is AWAITED: the runner
 * adds its next sheet only once this one is gone, and a discard of the same id
 * already in flight is awaited rather than raced.
 */
async function discardEphemeralSheet(args: unknown): Promise<boolean> {
  const controller = seated;
  if (!controller) {
    console.warn(`[sheetCommands] ${SHEET_DISCARD_EPHEMERAL_COMMAND}: no sheet tab strip is mounted; nothing to act on.`);
    refuse(NO_STRIP);
    return false;
  }
  const snapshot = controller.snapshot();
  if (snapshot.locked) {
    refuse(LOCKED);
    return false;
  }
  const sheetId = (args as { sheetId?: unknown } | null | undefined)?.sheetId;
  if (typeof sheetId !== "string" || sheetId === "") {
    refuse(NO_SHEET_ID);
    return false;
  }
  const listed = snapshot.sheets.find((s) => s.sheetId === sheetId);
  if (listed && listed.ephemeral !== true) {
    refuse(NOT_EPHEMERAL(listed.name));
    return false;
  }
  return controller.discardSheet(sheetId);
}

async function renameSheet(rawArgs: unknown): Promise<void> {
  const args = objectArgs(CoreCommands.SHEET_RENAME, rawArgs);
  if (args === MALFORMED) return;
  const controller = controllerFor(CoreCommands.SHEET_RENAME);
  if (!controller) return;
  const sheet = targetSheet(controller, args);
  if (!sheet) return;
  const newName = await promptForSheetName(sheet.name);
  if (newName === null) return;
  // The id read BEFORE the prompt: a discard landing while it was open has
  // renumbered the sheets since, and `sheet.index` may name another one now.
  // The strip seated NOW (the prompt may have outlived a remount).
  const current = getSheetTabsController();
  if (!current) return;
  await current.renameSheet(sheet.index, newName, sheet.sheetId);
}

async function hideSheet(rawArgs: unknown): Promise<void> {
  const args = objectArgs(CoreCommands.SHEET_HIDE, rawArgs);
  if (args === MALFORMED) return;
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

async function setTabColor(rawArgs: unknown): Promise<void> {
  // The SHAPE first: a bare `1` is told the shape it should have had, not the
  // colour sentence below.
  const args = objectArgs(CoreCommands.SHEET_TAB_COLOR, rawArgs);
  if (args === MALFORMED) return;
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

/**
 * Move or Copy Sheet... -- the dialog, or with `{ beforeIndex, copy? }` the
 * same placement without it (the command line and tests; scripts are refused
 * these anyway, they are not script-safe).
 *
 * BY STABLE ID from here on: the source, and the sheet to place it before, are
 * read from the snapshot NOW and handed to the strip as ids. The dialog can
 * stay open while a temporary sheet's discard renumbers every sheet after it,
 * and the indices it was opened with then name other sheets (review
 * TSHELL3-CONVERSE-DIALOG-WINDOW); the strip finds both again by id and
 * refuses with a toast when either is gone.
 */
async function moveOrCopySheet(rawArgs: unknown): Promise<void> {
  const args = objectArgs(CoreCommands.SHEET_MOVE_OR_COPY, rawArgs);
  if (args === MALFORMED) return;
  const controller = controllerFor(CoreCommands.SHEET_MOVE_OR_COPY);
  if (!controller) return;
  // The placement's own arguments are checked by SHAPE first, before the
  // source is resolved: a `beforeIndex` of "2" is a type mistake, never "no
  // visible sheet at index 2" while sheet 2 exists, and a `copy` of "true" is
  // refused, never quietly read as a move.
  let placement: { beforeIndex: number | null | undefined; copy: boolean } | null = null;
  if ("beforeIndex" in args) {
    const beforeIndex = indexArg(args, "beforeIndex", "end");
    if (beforeIndex === MALFORMED) return;
    const copy = booleanArg(args, "copy");
    if (copy === MALFORMED) return;
    placement = { beforeIndex, copy };
  }
  const sheet = targetSheet(controller, args);
  if (!sheet) return;
  const sourceSheetId = sheet.sheetId;
  if (!sourceSheetId) {
    refuse(NO_IDENTITY(sheet.name));
    return;
  }
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
    await current.moveOrCopySheet(sourceSheetId, choice.beforeSheetId, choice.copy);
  };

  if (placement !== null) {
    const { beforeIndex, copy } = placement;
    // The command line names the target by index: turned into its id NOW,
    // against the list this command just read.
    const before =
      beforeIndex === null
        ? null
        : typeof beforeIndex === "number"
          ? visible.find((s) => s.index === beforeIndex)
          : undefined;
    if (before === undefined) {
      refuse(`There is no visible sheet at index ${String(beforeIndex)} to place it before.`);
      return;
    }
    if (before !== null && !before.sheetId) {
      refuse(NO_IDENTITY(before.name));
      return;
    }
    await run({ beforeSheetId: before === null ? null : before.sheetId!, copy });
    return;
  }

  const data: MoveOrCopySheetData = {
    sourceSheetId,
    sourceName: sheet.name,
    // Every row by id (a backend that reports ids reports one for every sheet).
    sheets: visible.flatMap((s) => (s.sheetId ? [{ sheetId: s.sheetId, name: s.name }] : [])),
    canCopy,
    onResult: run,
  };
  DialogExtensions.openDialog(MOVE_OR_COPY_SHEET_DIALOG_ID, data as unknown as Record<string, unknown>);
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register the seven core.sheet.* commands, the temporary sheet's discard door
 * (core.sheet.discardEphemeral), their refusals and the Move or Copy dialog.
 * Called once by `registerCoreSheetContextMenu` (bootstrap). Returns the
 * cleanup (tests).
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
  // Resolves to a boolean (C7); refuses the structure lock in its own handler.
  CommandRegistry.register(SHEET_DISCARD_EPHEMERAL_COMMAND, (args) => discardEphemeralSheet(args));

  const releaseRefusal = addCommandRefusal({
    commandIds: SHEET_COMMAND_IDS,
    refuse: refusalFor,
  });

  return () => {
    releaseRefusal();
    for (const id of SHEET_COMMAND_IDS) CommandRegistry.unregister(id);
    CommandRegistry.unregister(SHEET_DISCARD_EPHEMERAL_COMMAND);
    DialogExtensions.unregisterDialog(MOVE_OR_COPY_SHEET_DIALOG_ID);
  };
}
