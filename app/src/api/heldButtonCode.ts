//! FILENAME: app/src/api/heldButtonCode.ts
// PURPOSE: The frontend's one reading of a button's HELD code (BUG-0257): the
//          application's button code a working copy or a subscription keeps in
//          the held compartment -- it travels with its application, runs only
//          after that application's approval, and a working copy publishes it
//          unchanged at the next push.
// CONTEXT: Checkout moves each non-empty `onSelect` / `macroRef` of an
//          application's button into `heldOnSelect` / `heldMacroRef`, stamped
//          `heldFrom` (which application, workspace and version), in Rust
//          (app/src-tauri/src/held_button_code.rs); since phase 3 a subscribe
//          or refresh does the same for a `macroRef` naming a macro that pull
//          landed. A held macro LINK runs only through one route -- Controls'
//          `runButtonMacroLink`, which asks the macro-run seam for exactly that
//          application's macro (`requirePackage`), behind the application's
//          approval and the Rust run gate. This module is how the UI SHOWS held
//          code -- the Properties pane, Code in This File, the approval screen
//          -- and the spellings here are pinned against the Rust constants and
//          the script write refusal (`SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS`) by
//          tests. What a CLICK on a button holding code says is the Rust
//          door's own answer (`run_control_action`), never a sentence composed
//          here.
//
//          Nothing here writes a held key. The backend refuses a write by name
//          and strips held keys from a copied button; the author gestures that
//          change held code are the Properties pane's three explicit steps,
//          each of which shows the held code first: "Replace the application's
//          code" (then the author writes the live slot), "Remove the
//          application's code", and "Make this my own" (phase 4: Rust
//          `controls::adopt_held_button_code` MOVES it into the live slots,
//          undoably and always audited; a button control's right-click menu
//          offers it too, through the pane's own confirm).
//
//          M6 (phase 4 of BUG-0257): a subscribe and a refresh HOLD an
//          application's static inline code too, and the Rust button door
//          (`scripting::control_action::run_control_action`) runs it only after
//          an approval of its exact bytes: the approval id is
//          `buttonAction:<sha256>` under the application's bare record. This
//          module is also how the approval screen and Code in This File LIST
//          that code -- by hash, with every place it sits -- and it decides
//          which held code is approvable by the door's own rule
//          (`heldInlineVerdict`), so the screen never asks approval for code no
//          click can run.
//
//          M8 (plan_M8 Task A, BUG-0257 phase 5): a button CELL from an
//          application may run a Calcula COMMAND on Rust's list once approved
//          under its own key, `button-commands:<application>`. This module holds
//          the page's half of that rule (`judgeApplicationCommand`), Rust's
//          second question (`authorizeButtonCommand`) and the listing the
//          approval screen and Code in This File read
//          (`listApplicationCellCommands`).

import { invokeBackend } from "./backend";
import { showToast } from "./notifications";
import { sha256Hex } from "./distributedConsent";

/** Mirror of HELD_ON_SELECT_PROPERTY (app/src-tauri/src/controls.rs). */
export const HELD_ON_SELECT_PROPERTY = "heldOnSelect";
/** Mirror of HELD_MACRO_REF_PROPERTY (app/src-tauri/src/controls.rs). */
export const HELD_MACRO_REF_PROPERTY = "heldMacroRef";
/** Mirror of HELD_FROM_PROPERTY (app/src-tauri/src/controls.rs). */
export const HELD_FROM_PROPERTY = "heldFrom";
/** Every key of the held compartment. */
export const HELD_CONTROL_PROPERTIES: readonly string[] = [
  HELD_ON_SELECT_PROPERTY,
  HELD_MACRO_REF_PROPERTY,
  HELD_FROM_PROPERTY,
];

/** Where held code came from. Mirrors Rust `HeldFrom` (camelCase JSON). */
export interface HeldFrom {
  /** The workspace's pin-scope id. Never display this. */
  workspace: string;
  application: string;
  version: string;
  valueTypes?: Record<string, string>;
}

/** A control property as the backend stores it. */
interface StoredProperty {
  valueType: string;
  value: string;
}

/** A button's held code, ready to show. */
export interface HeldButtonCode {
  /** The application the code came with ("an application" if unreadable). */
  application: string;
  /** The version it was checked out at; empty if unreadable. */
  version: string;
  /** The held inline code, or null. */
  onSelect: string | null;
  /** The held macro link (a macro id), or null. */
  macroRef: string | null;
  /**
   * A button CELL's held action (BUG-0260), exactly as it is published: the
   * canonical JSON of `{ kind, scriptId, functionName? }` or `{ kind, commandId }`.
   * Null for a button control.
   */
  cellAction?: string | null;
}

/**
 * Parse a `heldFrom` value. Null for anything that is not a stamp.
 *
 * LAX, for DISPLAY: a missing `workspace` reads as "". The Rust door is
 * stricter (`HeldFrom::decode`), so a decision about whether held code can RUN
 * must use {@link parseHeldFromStrict}, never this.
 */
export function parseHeldFrom(value: string | undefined | null): HeldFrom | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<HeldFrom>;
    if (typeof parsed?.application !== "string" || typeof parsed?.version !== "string") return null;
    return {
      workspace: typeof parsed.workspace === "string" ? parsed.workspace : "",
      application: parsed.application,
      version: parsed.version,
      valueTypes: parsed.valueTypes,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a `heldFrom` value EXACTLY as the Rust door does (`HeldFrom::decode`,
 * app/src-tauri/src/held_button_code.rs): serde with NO default for
 * `workspace`, `application` or `version`, and `valueTypes` either absent or a
 * map of strings (`null` is not a map to serde). Null for anything Rust would
 * refuse to decode -- the door answers such a button `stampUnreadable`, so the
 * approval screen must not offer it: an approval of code no click can run
 * approves nothing that matters.
 */
export function parseHeldFromStrict(value: string | undefined | null): HeldFrom | null {
  if (typeof value !== "string" || value === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const stamp = parsed as Record<string, unknown>;
  if (
    typeof stamp.workspace !== "string" ||
    typeof stamp.application !== "string" ||
    typeof stamp.version !== "string"
  ) {
    return null;
  }
  let valueTypes: Record<string, string> | undefined;
  if (stamp.valueTypes !== undefined) {
    const raw = stamp.valueTypes;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    valueTypes = {};
    for (const [slot, type] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof type !== "string") return null;
      valueTypes[slot] = type;
    }
  }
  return {
    workspace: stamp.workspace,
    application: stamp.application,
    version: stamp.version,
    valueTypes,
  };
}

/** Mirror of ON_SELECT_PROPERTY (app/src-tauri/src/controls.rs): the user's own inline code. */
const LIVE_ON_SELECT_PROPERTY = "onSelect";
/** Mirror of MACRO_REF_PROPERTY (app/src-tauri/src/controls.rs): the user's own macro link. */
const LIVE_MACRO_REF_PROPERTY = "macroRef";

/**
 * Whether a click can run a control's held inline code once it is approved:
 * the application whose approval it needs, or why no click ever runs it.
 */
export type HeldInlineVerdict =
  | { runs: true; application: string }
  | { runs: false; why: string };

/**
 * Whether a click on a control can ever run its HELD inline code, decided by
 * the Rust button door's own precedence (`control_action::decide_control`):
 *
 *   1. only a BUTTON runs code when clicked (any other control: `notAButton`);
 *   2. a macro link -- live or held -- wins, and the page's link route runs it;
 *   3. the user's own live `onSelect` wins over the application's held one;
 *   4. the stamp must decode the Rust way and name an application;
 *   5. only STATIC code is approvable: the approval is of exact bytes that run
 *      as themselves, and a formula-typed slot (kept for a faithful push) is not.
 *
 * Null when the control holds no inline code at all. An empty slot is no slot,
 * as the door's `slot(..)` filter reads it.
 */
export function heldInlineVerdict(
  controlType: string,
  properties: Record<string, StoredProperty> | undefined | null,
): HeldInlineVerdict | null {
  const filled = (key: string): StoredProperty | null => {
    const property = properties?.[key];
    return property && typeof property.value === "string" && property.value !== "" ? property : null;
  };
  const held = filled(HELD_ON_SELECT_PROPERTY);
  if (!held) return null;
  if (controlType !== "button") {
    return {
      runs: false,
      why: `it sits on a ${controlType || "control"}, and only a button runs code when it is clicked`,
    };
  }
  if (filled(LIVE_MACRO_REF_PROPERTY) || filled(HELD_MACRO_REF_PROPERTY)) {
    return { runs: false, why: "the button links a macro, and a click runs the link instead" };
  }
  if (filled(LIVE_ON_SELECT_PROPERTY)) {
    return { runs: false, why: "the button has code of your own, and a click runs that instead" };
  }
  const from = parseHeldFromStrict(properties?.[HELD_FROM_PROPERTY]?.value);
  if (!from) {
    return { runs: false, why: "its record of which application it came with cannot be read" };
  }
  if (from.application.trim() === "") {
    return { runs: false, why: "its record of which application it came with names none" };
  }
  if (held.valueType !== "static" || (from.valueTypes?.[LIVE_ON_SELECT_PROPERTY] ?? "static") !== "static") {
    return { runs: false, why: "it came as a formula, which Calcula does not run as button code" };
  }
  return { runs: true, application: from.application };
}

/**
 * The held code on a control, or null when it holds none.
 *
 * Presence is decided by the held CODE slots, never by the stamp alone: a stamp
 * with no code is nothing to show.
 */
export function readHeldButtonCode(
  properties: Record<string, StoredProperty> | undefined | null,
): HeldButtonCode | null {
  if (!properties) return null;
  const onSelect = properties[HELD_ON_SELECT_PROPERTY]?.value ?? null;
  const macroRef = properties[HELD_MACRO_REF_PROPERTY]?.value ?? null;
  if (onSelect === null && macroRef === null) return null;
  const from = parseHeldFrom(properties[HELD_FROM_PROPERTY]?.value);
  return {
    application: from?.application ?? "an application",
    version: from?.version ?? "",
    onSelect,
    macroRef,
  };
}

/** "'Sales' (v1.2.0)", or "'Sales'" when the version is unknown. */
export function describeHeldOrigin(held: HeldButtonCode): string {
  return held.version ? `'${held.application}' (v${held.version})` : `'${held.application}'`;
}

/**
 * What a held macro LINK does, in one sentence, wherever held code is shown
 * (the Properties pane, Code in This File). Phase 3 of BUG-0257: the link runs
 * the application's macro when clicked, and only after the application's code
 * is approved -- on the same approval screen that lists the application's
 * macros and the buttons that run them.
 */
export function describeHeldMacroLink(macroRef: string): string {
  return (
    `Runs the application's macro ${macroRef} when clicked, only after you approve the ` +
    `application's code.`
  );
}

// ============================================================================
// Which buttons run a macro (phase 3 of BUG-0257)
// ============================================================================

/**
 * One button that runs a macro, located and captioned. Mirrors Rust
 * `MacroLinkingControl` (app/src-tauri/src/controls.rs, camelCase JSON).
 */
export interface ButtonRunningMacro {
  sheetIndex: number;
  /** The sheet's display name, resolved backend-side. */
  sheetName: string;
  row: number;
  col: number;
  /**
   * The application whose HELD link this is (a working copy's application
   * buttons, and a subscriber's landed links). Null/absent for a live link of
   * the author's own.
   */
  heldBy?: string | null;
  /** A button CONTROL's `macroRef` (live or held), or a button CELL's script action. */
  kind: "control" | "cell";
  /** What the button says: a control's `text`, a cell's `label`. May be empty. */
  caption: string;
  /**
   * The application the BUTTON came with, read from this machine's own stamp.
   * Null for a button of the author's own, and for an unreadable stamp -- which
   * vouches for nothing.
   */
  application?: string | null;
}

/**
 * Every button -- control or cell, live link or held -- that runs `macroId`,
 * across all sheets, in sheet/row/col order. The ONE wrapper of
 * `list_controls_referencing_macro`: the delete-a-macro warning and the
 * approval screen's "Buttons that run this macro" both read it.
 */
export async function listButtonsRunningMacro(macroId: string): Promise<ButtonRunningMacro[]> {
  return invokeBackend<ButtonRunningMacro[]>("list_controls_referencing_macro", { macroId });
}

/** "Dashboard!B2" for a listed button. */
export function buttonRunningMacroCell(button: Pick<ButtonRunningMacro, "sheetName" | "row" | "col">): string {
  return `${button.sheetName}!${cellA1(button.row, button.col)}`;
}

// ============================================================================
// Button CELLS (Cell Type: Button, `calcula.button`) -- BUG-0260
// ============================================================================
//
// A button cell carries its action in its cell-type params. Rust stamps every
// button cell an application brings in (`fromApplication`, the same shape as a
// control's `heldFrom`), keeps a script action only when it names a macro that
// pull applied for the application, and at a checkout moves every other action
// into `heldAction`, which no click reads (app/src-tauri/src/button_cells.rs).
// The spellings are pinned against the Rust constants by
// `button_cells::tests::the_frontend_spells_the_params_as_rust_does`.

/** Mirror of HELD_ACTION_PARAM (app/src-tauri/src/button_cells.rs). */
export const CELL_BUTTON_HELD_ACTION_PARAM = "heldAction";
/** Mirror of FROM_APPLICATION_PARAM (app/src-tauri/src/button_cells.rs). */
export const CELL_BUTTON_FROM_APPLICATION_PARAM = "fromApplication";

/**
 * The application a button cell came with, or null for the user's own button.
 *
 * Only the application NAME is read: it is what a module's `sourcePackage`
 * names, and so the one thing the click can compare. A stamp only ever NARROWS
 * what a click runs -- a stamped button runs its application's macros and
 * nothing else -- so reading it from params the page can write is safe.
 */
export function cellButtonApplication(params: Record<string, unknown> | null | undefined): string | null {
  const stamp = params?.[CELL_BUTTON_FROM_APPLICATION_PARAM];
  if (!stamp || typeof stamp !== "object") return null;
  const application = (stamp as { application?: unknown }).application;
  return typeof application === "string" && application !== "" ? application : null;
}

/** The version a stamped button cell was checked out or pulled at ("" if unknown). */
function cellButtonVersion(params: Record<string, unknown> | null | undefined): string {
  const stamp = params?.[CELL_BUTTON_FROM_APPLICATION_PARAM];
  const version = stamp && typeof stamp === "object" ? (stamp as { version?: unknown }).version : "";
  return typeof version === "string" ? version : "";
}

/** True when a checkout HELD this button cell's action (it does not run). */
export function hasHeldCellButtonAction(params: Record<string, unknown> | null | undefined): boolean {
  const held = params?.[CELL_BUTTON_HELD_ACTION_PARAM];
  return held !== undefined && held !== null;
}

/**
 * A control's held INLINE code as an approval item: its approval id, the hash
 * of its exact bytes, and whether a click can ever run it (the door's rule).
 */
export interface HeldInlineCode {
  /** `buttonAction:<sha256 of the exact bytes>` -- the id the Rust door asks for. */
  id: string;
  /** The sha256 hex of the exact bytes. */
  hash: string;
  verdict: HeldInlineVerdict;
}

/** One button's held code, located, for "Code in This File". */
export interface HeldButtonCodeEntry extends HeldButtonCode {
  sheetIndex: number;
  sheetName: string;
  row: number;
  col: number;
  /** "Dashboard!B4" */
  cell: string;
  /** A button CONTROL, or a button CELL (Cell Type: Button). */
  kind: "control" | "cell";
  /** What the button says: a control's `text`, a cell's `label`. May be empty. */
  caption?: string;
  /**
   * The value type the PACKAGE gave the held `onSelect` (the stamp's
   * `valueTypes`; `static` when it names none). Null when nothing inline is held.
   * Only static code is approvable.
   */
  onSelectValueType?: string | null;
  /** A control's held inline code as an approval item; null when it holds none. */
  inline?: HeldInlineCode | null;
}

/**
 * JSON with its object keys sorted, recursively -- the canonical form Rust
 * hashes a cell action in (`button_cells::canonical_action`, serde_json with
 * sorted maps), so what is shown is what is published.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A button cell's held action, or null when it holds none. */
export function readHeldCellButtonAction(
  params: Record<string, unknown> | null | undefined,
): HeldButtonCode | null {
  if (!hasHeldCellButtonAction(params)) return null;
  return {
    application: cellButtonApplication(params) ?? "an application",
    version: cellButtonVersion(params),
    onSelect: null,
    macroRef: null,
    cellAction: canonicalJson(params?.[CELL_BUTTON_HELD_ACTION_PARAM]),
  };
}

/** A cell action (canonical JSON) in words: "Runs the macro X and calls F()". */
export function describeCellActionText(code: string): string {
  try {
    const action = JSON.parse(code) as Record<string, unknown>;
    if (action.kind === "script" && typeof action.scriptId === "string") {
      const fn =
        typeof action.functionName === "string" && action.functionName
          ? ` and calls ${action.functionName}()`
          : "";
      return `Runs the macro ${action.scriptId}${fn}`;
    }
    if (action.kind === "command" && typeof action.commandId === "string") {
      return `Runs the command ${action.commandId}`;
    }
  } catch {
    // Not JSON: shown as it is.
  }
  return code;
}

/** Which kind of button a click's refusal is about (Rust `MacroLinkKind`). */
export type RefusedButtonKind = "control" | "cell";

/**
 * Record a CLICK's refusal of an application's button on the always-on audit
 * trail ("every run and every refusal of application code is written to the
 * audit trail") -- for the refusals still decided on the page: a button
 * control's held macro LINK refused by the macro-run seam (phase 3 of
 * BUG-0257, Controls' `runButtonMacroLink`), a button cell's macro the seam
 * refused, and an application's button COMMAND the page refused on its live
 * registration (plan_M8: `commandUnregistered`, `commandNotAllowed`,
 * `commandShadowed`, `commandDisabled` -- CellTypes/lib/buttonCommandRun.ts).
 * Every refusal the Rust button
 * door (`run_control_action`) answers is ALREADY recorded by Rust, through the
 * same backend core; recording it here as well would write a second row for
 * one click. The backend reads the application from the button's own stamp in
 * its store; this names the button -- its sheet (the TRUE state-vector index
 * the click happened on, never "whatever sheet is active by the time this
 * lands") and cell -- and what was refused.
 *
 * A failure to record never changes what the click did, but it is SAID: the
 * user is told the refusal is missing from the trail, rather than it vanishing
 * into the console.
 */
export async function recordButtonRefusal(
  kind: RefusedButtonKind,
  sheetIndex: number,
  row: number,
  col: number,
  refused: string,
  reason: string,
): Promise<void> {
  try {
    await invokeBackend<void>("audit_button_refusal", { kind, sheetIndex, row, col, refused, reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[heldButtonCode] The click's refusal could not be recorded:", err);
    showToast(
      `The refusal of this button's code could not be written to the audit trail: ${message}`,
      { variant: "warning" },
    );
  }
}

interface CellTypeEntryLike {
  sheetIndex: number;
  row: number;
  col: number;
  typeId: string;
  params: Record<string, unknown> | null;
}

/** Mirror of BUTTON_CELL_TYPE_ID (app/src-tauri/src/button_cells.rs). */
const BUTTON_CELL_TYPE_ID = "calcula.button";

/** "B4" for a 0-based (row, col). */
export function cellA1(row: number, col: number): string {
  let letters = "";
  let c = col;
  do {
    letters = String.fromCharCode(65 + (c % 26)) + letters;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${letters}${row + 1}`;
}

interface SheetsResultLike {
  sheets: { index: number; name: string }[];
}

interface ControlEntryLike {
  sheetIndex: number;
  row: number;
  col: number;
  metadata: { controlType: string; properties: Record<string, StoredProperty> };
}

/** A control's caption (`text`), or "" when it has none. */
function controlCaption(properties: Record<string, StoredProperty> | undefined | null): string {
  const text = properties?.text?.value;
  return typeof text === "string" ? text : "";
}

/** A button cell's caption (`label`), or "" when it has none. */
function cellCaption(params: Record<string, unknown> | null | undefined): string {
  const label = params?.label;
  return typeof label === "string" ? label : "";
}

/**
 * Every button in the open workbook that holds its application's code, in
 * sheet/row/col order: button CONTROLS (held `onSelect` / `macroRef`) and
 * button CELLS (a held action, BUG-0260). Read through the existing per-sheet
 * control and cell-type listings, so it sees exactly what the backend stores.
 *
 * A control's held INLINE code also carries its approval item
 * ({@link HeldInlineCode}): the id and hash the Rust door asks the approval of,
 * and whether a click can ever run it.
 */
export async function listHeldButtonCode(): Promise<HeldButtonCodeEntry[]> {
  const sheets = await invokeBackend<SheetsResultLike>("get_sheets");
  const out: HeldButtonCodeEntry[] = [];
  for (const sheet of sheets.sheets) {
    const controls = await invokeBackend<ControlEntryLike[]>("get_all_controls", {
      sheetIndex: sheet.index,
    });
    for (const entry of controls) {
      const properties = entry.metadata.properties;
      const held = readHeldButtonCode(properties);
      if (!held) continue;
      const verdict = heldInlineVerdict(entry.metadata.controlType, properties);
      let inline: HeldInlineCode | null = null;
      if (verdict && held.onSelect !== null) {
        const hash = await sha256Hex(held.onSelect);
        inline = { id: buttonActionConsentId(hash), hash, verdict };
      }
      out.push({
        ...held,
        sheetIndex: entry.sheetIndex,
        sheetName: sheet.name,
        row: entry.row,
        col: entry.col,
        cell: `${sheet.name}!${cellA1(entry.row, entry.col)}`,
        kind: "control",
        caption: controlCaption(properties),
        onSelectValueType:
          held.onSelect !== null
            ? (parseHeldFrom(properties[HELD_FROM_PROPERTY]?.value)?.valueTypes?.[LIVE_ON_SELECT_PROPERTY] ??
              "static")
            : null,
        inline,
      });
    }
    const cells = await invokeBackend<CellTypeEntryLike[]>("get_all_cell_types", {
      sheetIndex: sheet.index,
    });
    for (const entry of cells) {
      if (entry.typeId !== BUTTON_CELL_TYPE_ID) continue;
      const held = readHeldCellButtonAction(entry.params);
      if (!held) continue;
      out.push({
        ...held,
        sheetIndex: entry.sheetIndex,
        sheetName: sheet.name,
        row: entry.row,
        col: entry.col,
        cell: `${sheet.name}!${cellA1(entry.row, entry.col)}`,
        kind: "cell",
        caption: cellCaption(entry.params),
        onSelectValueType: null,
        inline: null,
      });
    }
  }
  out.sort((a, b) => a.sheetIndex - b.sheetIndex || a.row - b.row || a.col - b.col);
  return out;
}

// ============================================================================
// Inline button code as an approval item (M6, phase 4 of BUG-0257)
// ============================================================================
//
// A subscribe or refresh holds an application's STATIC inline button code, and
// the Rust door runs it only after the approval of its exact bytes. The id of
// that approval is `buttonAction:<sha256>` under the application's BARE record
// -- the one that also holds its object scripts and macros -- so one screen and
// one Allow cover all three. Two buttons carrying the same bytes are ONE item
// with two locations: the hash is the identity, never the position.

/**
 * Mirror of BUTTON_ACTION_CONSENT_PREFIX
 * (app/src-tauri/src/scripting/control_action.rs), drift-tested against it.
 * Reserved: a pull refuses a module, notebook or object script whose id starts
 * with it, and the approval plan never lets anything else claim it.
 */
export const BUTTON_ACTION_CONSENT_PREFIX = "buttonAction:";

/** The approval id of inline button code whose exact bytes hash to `hash`. */
export function buttonActionConsentId(hash: string): string {
  return `${BUTTON_ACTION_CONSENT_PREFIX}${hash}`;
}

/** One place a piece of button code sits: its cell and what the button says. */
export interface ButtonActionLocation {
  sheetIndex: number;
  sheetName: string;
  row: number;
  col: number;
  /** "Dashboard!B4" */
  cell: string;
  /** The control's caption (`text`); may be empty. */
  caption: string;
}

/** One piece of an application's held inline button code, as the approval screen lists it. */
export interface HeldButtonAction {
  /** `buttonAction:<sha256 of the exact bytes>` -- the approval id the Rust door asks for. */
  id: string;
  /** The sha256 hex of the exact bytes. */
  hash: string;
  /** The exact bytes: shown verbatim, and recorded verbatim. */
  source: string;
  /** Every place these bytes sit, in sheet/row/col order. */
  locations: ButtonActionLocation[];
}

/**
 * The approvable button actions among `entries`, grouped by the application
 * whose approval they need (the stamp's name, VERBATIM -- both Rust gates
 * compare it raw) and then by the hash of their exact bytes, sorted by id.
 *
 * Only held inline code a click CAN run is approvable ({@link heldInlineVerdict}):
 * a shape's code, a button whose link wins, a button whose own code wins, an
 * unreadable stamp and a formula-typed slot are left out, because the screen
 * would otherwise ask approval for code no click can run.
 */
export function groupHeldButtonActions(entries: readonly HeldButtonCodeEntry[]): Map<string, HeldButtonAction[]> {
  const byApplication = new Map<string, Map<string, HeldButtonAction>>();
  for (const entry of entries) {
    if (entry.kind !== "control" || entry.onSelect === null) continue;
    const inline = entry.inline;
    if (!inline || !inline.verdict.runs) continue;
    const application = inline.verdict.application;
    const byHash = byApplication.get(application) ?? new Map<string, HeldButtonAction>();
    byApplication.set(application, byHash);
    const action =
      byHash.get(inline.hash) ??
      ({ id: inline.id, hash: inline.hash, source: entry.onSelect, locations: [] } satisfies HeldButtonAction);
    byHash.set(inline.hash, action);
    action.locations.push({
      sheetIndex: entry.sheetIndex,
      sheetName: entry.sheetName,
      row: entry.row,
      col: entry.col,
      cell: entry.cell,
      caption: entry.caption ?? "",
    });
  }
  const out = new Map<string, HeldButtonAction[]>();
  for (const [application, byHash] of byApplication) {
    const actions = [...byHash.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const action of actions) {
      action.locations.sort((a, b) => a.sheetIndex - b.sheetIndex || a.row - b.row || a.col - b.col);
    }
    out.set(application, actions);
  }
  return out;
}

/**
 * Every application's approvable button actions, from ONE {@link listHeldButtonCode}
 * walk. Rejects when the workbook cannot be listed: a caller decides whether
 * that degrades (the load pass, as it does for macros) or refuses (a grant).
 */
export async function listHeldButtonActions(): Promise<Map<string, HeldButtonAction[]>> {
  return groupHeldButtonActions(await listHeldButtonCode());
}

/** One place a piece of inline code sits, with the kind of control it is on. */
export interface ButtonInlineLocation extends ButtonActionLocation {
  controlType: string;
}

/**
 * One piece of inline control code (`onSelect`) in the open workbook, BY
 * CONTENT -- for Code in This File and per-workbook trust. Two buttons carrying
 * the same bytes are one entry naming both cells, and moving a button changes
 * a location, never the identity.
 */
export interface ButtonInlineAction {
  /**
   * "local": a LIVE `onSelect`, which is always the user's own -- no admission
   * ever writes a live slot. "distributed": an application's HELD `onSelect`.
   */
  provenance: "local" | "distributed";
  /** The application held code came with (its stamp, read for display); null for the user's own or an unreadable stamp. */
  application: string | null;
  /** The sha256 hex of the exact bytes. */
  hash: string;
  source: string;
  /** Every place these bytes sit, in sheet/row/col order. */
  locations: ButtonInlineLocation[];
}

/**
 * Every piece of inline control code in the open workbook, live and held,
 * grouped by (provenance, application, hash): the user's own first, then each
 * application's. REJECTS when a listing fails -- per-workbook trust must read
 * a failure as "could not look", never as "no button code".
 */
export async function listButtonInlineActions(): Promise<ButtonInlineAction[]> {
  const sheets = await invokeBackend<SheetsResultLike>("get_sheets");
  const groups = new Map<string, ButtonInlineAction>();
  const add = async (
    provenance: "local" | "distributed",
    application: string | null,
    source: string,
    location: ButtonInlineLocation,
  ): Promise<void> => {
    const hash = await sha256Hex(source);
    const key = JSON.stringify([provenance, application, hash]);
    const group = groups.get(key) ?? { provenance, application, hash, source, locations: [] };
    groups.set(key, group);
    group.locations.push(location);
  };
  for (const sheet of sheets.sheets) {
    const controls = await invokeBackend<ControlEntryLike[]>("get_all_controls", {
      sheetIndex: sheet.index,
    });
    for (const entry of controls) {
      const properties = entry.metadata.properties ?? {};
      const location: ButtonInlineLocation = {
        sheetIndex: entry.sheetIndex,
        sheetName: sheet.name,
        row: entry.row,
        col: entry.col,
        cell: `${sheet.name}!${cellA1(entry.row, entry.col)}`,
        caption: controlCaption(properties),
        controlType: entry.metadata.controlType,
      };
      const live = properties[LIVE_ON_SELECT_PROPERTY]?.value;
      if (typeof live === "string" && live !== "") {
        await add("local", null, live, location);
      }
      const held = properties[HELD_ON_SELECT_PROPERTY]?.value;
      if (typeof held === "string" && held !== "") {
        const stamped = parseHeldFrom(properties[HELD_FROM_PROPERTY]?.value)?.application;
        await add("distributed", stamped && stamped.trim() !== "" ? stamped : null, held, { ...location });
      }
    }
  }
  const rank = (a: ButtonInlineAction): string =>
    `${a.provenance === "local" ? "0" : "1"}\u0000${a.application ?? ""}\u0000${a.hash}`;
  const out = [...groups.values()].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  for (const action of out) {
    action.locations.sort((a, b) => a.sheetIndex - b.sheetIndex || a.row - b.row || a.col - b.col);
  }
  return out;
}

// ============================================================================
// An application's button COMMAND (plan_M8, BUG-0257 phase 5)
// ============================================================================
//
// A button cell that came with an application may run a Calcula command only
// when two independent yeses agree:
//
//   * RUST'S: the id is on `DISTRIBUTABLE_BUTTON_COMMANDS`
//     (app/src-tauri/src/button_cells.rs) -- the admission keeps such an action
//     live and stamped, every other one is removed (or held at a checkout) --
//     and, at the click, the button door asks
//     `application_code_gate::button_command_gate`: the list, the approval
//     under `button-commands:<application>`, the working-copy private-sheet
//     rule. Only then does it answer `command` WITH the application.
//   * THE PAGE'S: the command's LIVE registration opts in
//     (`distributableTrigger: true`) and no registration stands over another
//     under that id ({@link judgeApplicationCommand}). Then
//     {@link authorizeButtonCommand} asks Rust again from its own store and
//     writes the always-on run row, and only after that resolves does the page
//     run the command (extensions/CellTypes/lib/buttonCommandRun.ts).
//
// The approval is recorded under its OWN key -- never the application's bare
// record, which is the object-script mount floor's key: the mount door admits a
// mount naming no artifact on ANY non-empty record under the bare name, so a
// command approval recorded there would open that floor.

/**
 * Mirror of BUTTON_COMMAND_CONSENT_PREFIX (app/src-tauri/src/button_cells.rs),
 * drift-tested against it (src/api/__tests__/buttonCommandListDrift.test.ts).
 */
export const BUTTON_COMMAND_CONSENT_PREFIX = "button-commands:";

/** The consent key an application's command approvals are recorded under. */
export function buttonCommandConsentKey(application: string): string {
  return `${BUTTON_COMMAND_CONSENT_PREFIX}${application}`;
}

/**
 * Why the PAGE refuses an application's button command -- the reason recorded
 * on the audit trail (`audit_button_refusal`):
 *   * `commandUnregistered` -- no command of that id is registered;
 *   * `commandNotAllowed`   -- its LIVE registration does not opt in;
 *   * `commandShadowed`     -- a registration stands over another under that id.
 */
export type ApplicationCommandRefusal = "commandUnregistered" | "commandNotAllowed" | "commandShadowed";

/** ...and, at the click only, `commandDisabled`: its `isEnabled` said no. */
export type RefusedButtonCommand = ApplicationCommandRefusal | "commandDisabled";

/**
 * THE PAGE'S RULE for an application's button command, over the LIVE
 * registration and the registry's shadow answer -- the one rule the click
 * (buttonCommandRun.ts) and the approval screen (packageConsentSet.ts) both
 * apply, so the screen never asks approval for a command no click would run.
 * Null when the page says yes. The order is the refusal's precedence.
 */
export function judgeApplicationCommand(
  live: { distributableTrigger?: unknown } | null | undefined,
  shadowed: boolean,
): ApplicationCommandRefusal | null {
  if (!live) return "commandUnregistered";
  if (live.distributableTrigger !== true) return "commandNotAllowed";
  if (shadowed) return "commandShadowed";
  return null;
}

/** Why an application's button command does not run, as a clause ("it is ..."). */
export function describeApplicationCommandRefusal(why: RefusedButtonCommand): string {
  switch (why) {
    case "commandUnregistered":
      return "it is not registered in Calcula";
    case "commandNotAllowed":
      return "it is not on Calcula's list of commands a button from an application may run";
    case "commandShadowed":
      return "another registration has replaced Calcula's own command of that name";
    case "commandDisabled":
      return "it is not available right now";
  }
}

/**
 * THE SECOND QUESTION (Rust `scripting::control_action::authorize_button_command`):
 * the button cell at (sheetIndex, row, col) must still hold exactly this
 * command under an application's stamp, and the command gate is asked again --
 * then the always-on run row is written. Resolves only when the page may run
 * the command; REJECTS with Rust's own sentence otherwise, and Rust has already
 * recorded that refusal (the caller must not record it again).
 */
export async function authorizeButtonCommand(
  sheetIndex: number,
  row: number,
  col: number,
  commandId: string,
): Promise<void> {
  try {
    await invokeBackend<void>("authorize_button_command", { request: { sheetIndex, row, col, commandId } });
  } catch (err) {
    throw new Error(typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
  }
}

/** One button cell that came with an application and runs a Calcula command. */
export interface ApplicationCellCommand {
  /** The application the button came with: its stamp, VERBATIM (Rust's gate keys on it raw). */
  application: string;
  commandId: string;
  /**
   * The sha256 hex of the command id's own bytes: the hash an approval of it
   * is recorded and asked at (Rust's command gate hashes the id the same way).
   */
  commandHash: string;
  sheetIndex: number;
  sheetName: string;
  row: number;
  col: number;
  /** "Dashboard!B2" */
  cell: string;
  /** The button's caption (`label`); may be empty. */
  caption: string;
}

/**
 * Every button cell that came with an application (a stamp naming one, read as
 * Rust's `cell_stamp` reads it) and whose LIVE action is a command, in
 * sheet/row/col order -- through the same per-sheet listings as
 * {@link listHeldButtonCode}. A held action is not listed (it runs nowhere), and
 * neither is the user's own button (its command needs no approval). Rejects
 * when the workbook cannot be listed.
 */
export async function listApplicationCellCommands(): Promise<ApplicationCellCommand[]> {
  const sheets = await invokeBackend<SheetsResultLike>("get_sheets");
  const out: ApplicationCellCommand[] = [];
  for (const sheet of sheets.sheets) {
    const cells = await invokeBackend<CellTypeEntryLike[]>("get_all_cell_types", {
      sheetIndex: sheet.index,
    });
    for (const entry of cells) {
      if (entry.typeId !== BUTTON_CELL_TYPE_ID) continue;
      const application = cellButtonApplication(entry.params);
      if (application === null) continue;
      const action = entry.params?.action as { kind?: unknown; commandId?: unknown } | null | undefined;
      if (!action || typeof action !== "object" || action.kind !== "command") continue;
      if (typeof action.commandId !== "string" || action.commandId === "") continue;
      out.push({
        application,
        commandId: action.commandId,
        commandHash: await sha256Hex(action.commandId),
        sheetIndex: entry.sheetIndex,
        sheetName: sheet.name,
        row: entry.row,
        col: entry.col,
        cell: `${sheet.name}!${cellA1(entry.row, entry.col)}`,
        caption: cellCaption(entry.params),
      });
    }
  }
  out.sort((a, b) => a.sheetIndex - b.sheetIndex || a.row - b.row || a.col - b.col);
  return out;
}
