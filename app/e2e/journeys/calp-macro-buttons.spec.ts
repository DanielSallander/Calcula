/**
 * CALP MACRO BUTTONS, LIVE -- the M4 programme (phase 3 of BUG-0257 and its
 * prerequisites) proved against the running app, over a real workspace on disk.
 *
 *   M4-1  SUBSCRIBER HAPPY PATH. A publisher's button that LINKS one of the
 *         application's macros arrives HELD (heldMacroRef + heldFrom, no live
 *         macroRef); the consent screen names the button under its macro
 *         (`[data-consent-macro-buttons]`); before Allow a click writes nothing
 *         (NEGATIVE CONTROL, and the refusing door is RECORDED, not assumed);
 *         after Allow the click runs the application's macro and leaves an
 *         always-on `application_code_run` row naming the application, the
 *         macro and the button (viewer label "Application code ran").
 *   M4-2  THE CONFUSED DEPUTY, in the two halves two different guards own:
 *         (ii) AFTER admission (serial with M4-1, same workbook): the
 *              application's macro is replaced by a LOCAL one of the same id;
 *              the click is refused before anything runs (`requirePackage`,
 *              the one guard here -- Rust passes local code untouched), no
 *              marker, and a `button_code_refused` row (macroNotFromApplication).
 *              POSITIVE CONTROL: the local macro does run from the user's own
 *              button.
 *         (i)  AT admission: the subscriber already owns a module with the
 *              application's id, the pull skips the application's, the REAL
 *              Subscribe dialog names the removed link
 *              (`[data-testid=subscribe-button-links-removed]`), no link is held,
 *              and the click never reaches the subscriber's macro. POSITIVE
 *              CONTROL as above.
 *   M4-3  PRIVATE SHEETS. A checkout into a workbook whose own Sheet1 holds a
 *         cell says so (`checkout-private-sheets`), and the application's code
 *         is refused beside it on BOTH doors -- the module runtime
 *         (`distributed_run_gate`) and the one-off mount (`mount_run_gate`, a
 *         runtime=objectScript macro) -- with `application_code_refused`
 *         (privateSheets) rows. The remedy ("Open it in a new workbook", a
 *         native confirm answered over Win32) opens the SAME version in a fresh
 *         workbook, where both buttons run.
 *   M4-4  INCLUDE IN APPLICATION. A working copy's NEW macro linked by a NEW
 *         button: the backend refuses the push (CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED),
 *         the push dialog names the button (`unshipped-macro-links`), the
 *         include tick is disabled until the code is shown; VARIANT: the macro
 *         edited after the tick refuses the push (CALP_PUSH_INCLUDED_CHANGED) and
 *         is marked stale; re-read and re-ticked it ships (`push-added-notice`,
 *         the version's modules/ holds the EDITED code), and the subscriber's
 *         refresh + re-approval makes the new button run.
 *   M4-5  DEVELOPER ANCHOR. The creator remembered at publish is matched on the
 *         first checkout; a Mallory-signed 0.0.1 root plus a Mallory-re-signed
 *         head is refused as a contradiction naming both fingerprints; Forget
 *         answered NO forgets nothing (state AND Code in This File), answered
 *         YES forgets, audits, and the retry trusts Mallory on first use.
 *   M4-6  BUG-0266 (fixed 2026-09-30), live: with no anchor remembered, a
 *         Mallory-signed 0.0.1 ROOT ONLY (head still this computer's) is refused
 *         by the SIGNER check -- and the refusal records NO anchor; with the
 *         genuine listing written back the checkout succeeds and records THIS
 *         profile as the creator on first contact.
 *   M4-7  OWNER DECISION B (2026-09-30), live: an application's RECORDED macro
 *         (the Macro Recorder's own object-script source, `context.api`) writes
 *         its cell in a subscriber workbook after Allow when the person runs it
 *         from Developer > Macros > Run (an `application_code_run` row names it),
 *         and -- follow-ups F1 + F6 -- when the person CLICKS the application's
 *         button control that links it (B2) or its button CELL that runs it
 *         (D2; the Rust door answers `macro` and the page runs it through the
 *         macro seam), each run row naming that button. POSITIVE CONTROLS: both
 *         buttons write as the publisher's own code. The SAME macro started by a
 *         script -- a local unlocked one-off calling `context.api.runMacro`, a
 *         restricted one that has no `context.api` to call it with, or the
 *         application's own STANDING restricted script on a probe button (F2)
 *         that tries `api.runMacro` through `context.api` and through a raw
 *         broker post -- writes nothing and leaves no run row; and a recording
 *         that also formats is refused before it runs, naming
 *         `api.setRangeFormat`. Follow-ups F3/F15/F8 (Rust names the grant):
 *         each run row a person started says `cellAccess: true` and the
 *         door (`macrosDialog`, `button`, `commandLine`) with a `grantId`,
 *         and ONE `script_executed` row per sheet (surface `object-script`,
 *         the macro as surface id, the bounds) carries that grantId; the
 *         script-started run's row says `cellAccess: false`, `startedBy:
 *         "script"` and leaves no such row; the formatting recording's
 *         refusal is an `application_code_refused` row, reason
 *         `outsideCellAccess`, naming `api.setRangeFormat`.
 *
 * STATE AND DOM, NEVER PIXELS. The goldens are stale after the owner's UI
 * changes and this machine runs at DPR 2, so nothing here compares a
 * screenshot: assertions read control metadata (`get_all_controls`), stored
 * scripts (`get_script`), cells (`get_watch_cells`), the workbook's audit log
 * (`calp_get_audit_log`), the developer anchors (`calp_list_trusted_publishers`),
 * the published files in the temp workspace (checksums re-verified), and the
 * dialogs' own test ids.
 *
 * WHY M4-1..M4-6's CELL-WRITING MACROS USE THE MODULE RUNTIME. A distributed
 * macro run through the OBJECT-SCRIPT route mounts at the restricted tier, and
 * a restricted realm's `context.api` is null (contextShims.ts `buildBase`) --
 * UNLESS the person ran it themselves (owner decision B,
 * docs/design/wave3-scripting-security.md section 11): then the realm, still
 * restricted, gets `context.api` with CELL access only, for that one run.
 * Developer > Macros > Run, a person's click on a button that runs the macro
 * (the click's pointer gesture mints it; follow-ups F1 + F6) and a `run` line
 * typed at the command line (F2) carry that pass. A run a SCRIPT starts never
 * does: an object-script macro stays restricted -- the recorded scaffold then
 * THROWS "needs cell access" (F12) -- and an application's MODULE macro is
 * refused outright by the Rust module-runtime gate, with an
 * `application_code_refused` row (reason notStartedByYou; F10). M4-1..M4-6
 * predate the button doors, so
 * their button-driven macros whose marker is a CELL are module-runtime macros
 * (`Calcula.setCellValue`, the QuickJS interpreter); M4-3's second macro is a
 * `runtime=objectScript` one whose observable is a `context.notify` toast
 * (restricted tier: `base.notify`), which is what puts the MOUNT door under
 * test. M4-7 is the object-script macro that writes a cell, through every door
 * that is wired: the Macros dialog, a button control's link, a button cell and
 * the command line -- plus a MODULE macro of the same application, which the
 * command line runs and a script's runMacro is refused.
 *
 * NATIVE DIALOGS are answered over Win32 by `e2e/answer-native-dialog.ps1`,
 * keyed on the confirm's TITLE. The click that raises one is AWAITED before the
 * synchronous driver runs (memory: e2e_unawaited_call_before_execfilesync).
 *
 * LIVE SABOTAGES for the main loop (from the M4 notes -- NOT performed here):
 *   M4-2 (ii): drop `requirePackage: link.application`
 *              (extensions/Controls/lib/applicationMacroLink.ts) -> the local
 *              macro writes its marker and (ii) goes red.
 *   M4-3:      make `private_sheet_refusal` return `None`
 *              (app/src-tauri/src/scripting/application_code_gate.rs) -> both
 *              clicks run beside Sheet1. Rebuild BETWEEN runs, never during one.
 *   M4-5:      break rule 1 of `developer_anchor::anchor_root` (the contradiction
 *              compare) -> the planted version opens; `CheckOnly` in core checkout
 *              is a NO-OP for this test.
 *   M4-7:      remove the `explicitRun:` line from MacroLibraryDialog.tsx `run`
 *              -> step 1 goes red (the recorded macro runs restricted and its
 *              scaffold throws "needs cell access"); make
 *              macroLibrary.ts `runMacroByRef` forward
 *              `options.explicitRun ?? mintExplicitMacroRun("macrosDialog", macroId)`
 *              -> step 2 goes red (the script-started run writes); delete the
 *              pre-flight in objectScriptRunner.ts -> step 3 goes red (the macro
 *              writes its cell and only THEN fails at the broker: the cell is
 *              not empty and the error lacks "Nothing was changed");
 *              drop the `(macroId) => mintExplicitMacroRun("button", macroId)`
 *              argument from Controls/index.ts `handleButtonPress` -> step 1b
 *              goes red (the link runs restricted and the recording bails out);
 *              drop it from CellTypes/types/button.ts `onClick` -> step 1c goes
 *              red; make `plan_cell_action` refuse an object-script module again
 *              (app/src-tauri/src/scripting/control_action.rs) -> the publisher's
 *              button-cell POSITIVE CONTROL and step 1c go red (rebuild BETWEEN
 *              runs, never during one); give `api.runMacro` the restricted tier
 *              (src/api/scriptHost/allowlist.ts) -> step 2c goes red on its
 *              run-row count (the standing probe's raw broker post starts it);
 *              drop the `explicitRun` argument from CommandLine/cli/appWriters.ts
 *              runMacro (`s.gateway.runMacroByRef(match.id)`) -> step 1d goes
 *              red (the typed object-script run throws "needs cell access" and
 *              the module macro is refused as not started by you); make
 *              `not_started_by_you` answer `None` for `Script`
 *              (app/src-tauri/src/scripting/application_code_gate.rs, rebuild
 *              BETWEEN runs) -> step 2d goes red (the script-started module
 *              macro writes its cell).
 *              F3/F15/F8 (B2c): drop `answer.cell_access = true;` in
 *              `mount_run_gate` (application_code_gate.rs, rebuild BETWEEN
 *              runs) -> step 1 goes red (no grant: the recording throws
 *              "needs cell access"); drop `endGrantedRun(mw.definition.id,
 *              msg.ok);` from the "mounted" deliver (src/api/scriptHost/
 *              host.ts) -> step 1's write row never comes; drop the
 *              `recordRefusedBeforeRun(` call from objectScriptRunner.ts ->
 *              step 3's refusal row never comes.
 *              F4/F9 (B2d): drop the `{objectScriptMacroCount > 0 && (...)}`
 *              paragraph from ScriptConsentDialog.tsx -> the approval-screen
 *              check before Allow goes red; in host.ts `closeGrantedRunStep`,
 *              commit a failed run instead of calling
 *              `roll_back_to_undo_savepoint` -> step 1e goes red (K9/K10 keep
 *              the failed run's marker and the dialog says its changes could
 *              not be undone).
 *
 * SELF-CLEANING. The workspace lives under one temp folder removed first;
 * application names carry a per-run suffix (E2E runs use the REAL profile, so a
 * fixed name at a fixed path would carry anchors and pins between runs). Every
 * test ends in the app's own File > New, and `afterAll` forgets the developer
 * anchors this run's applications left in the profile.
 */
import type { Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";
import {
  API,
  COLLAB,
  activate,
  bounded,
  callModule,
  dismissToasts,
  emitApp,
  eventually,
  installAppImport,
  invoke,
  isDirty,
  newFile,
  openAt,
  readCell,
  renameSheetByName,
  saveAs,
  setCells,
  sheetIndex,
  sheetNames,
  sheets,
  tryModule,
  type AppWindow,
} from "../helpers/calp-harness";
import { publishNew, push, refreshApply, refreshPreview, subscribe, workingCopy, type PullResult } from "../helpers/calp-collab";
import { escapeRe, startToastLog, toastLog } from "../helpers/pivot-live";

const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), "calcula-calp-macro-buttons");
const WS = path.join(WORK, "workspace");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_DRIVER = path.join(HERE, "..", "answer-native-dialog.ps1");

const BUTTONS = "/src/api/buttonControlService.ts";
const DESIGN_MODE = "/src/api/designMode.ts";
const FLOATING_STORE = "/extensions/Controls/lib/floatingStore.ts";
/** The cell-type registry (`setCellType`, `refreshCellTypeAssignments`): button CELLS. */
const CELL_TYPES = "/src/api/cellTypes.ts";
/** `CODE_IN_FILE_PANEL_ID`, app/extensions/ScriptableObjects/index.ts. */
const CODE_IN_FILE_PANEL = "scriptable-objects.codeInThisFile";

/** A stored macro with no runtime marker runs in the MODULE runtime (`run_script`). */
const MODULE_MACRO_DESC = "e2e calp-macro-buttons (module runtime)";
/** The marker `parseModuleScriptRuntime` reads: this one runs as a one-off OBJECT SCRIPT. */
const OBJECT_MACRO_DESC = "Recorded macro - runtime=objectScript - e2e calp-macro-buttons";

/** The native confirms, by the title their `confirmAsync` gives them. */
const FORGET_TITLE = "Forget the remembered creator";
const UNSAVED_TITLE = "Unsaved changes";

/** Every application this run publishes; `afterAll` forgets their anchors. */
const CREATED_APPS: string[] = [];

// ===========================================================================
// Plumbing: output, scripts, buttons, run mode, toasts, markers
// ===========================================================================

/** Plain ASCII for the terminal (CLAUDE.md "Clean Output"). */
function ascii(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

function log(message: string): void {
  console.log(`[calp-macro-buttons] ${ascii(message)}`);
}

async function withScriptsEnabled<T>(page: Page, body: () => Promise<T>): Promise<T> {
  const previous = await invoke<string>(page, "get_script_security_level").catch(() => "prompt");
  await invoke(page, "set_script_security_level", { level: "enabled" });
  try {
    return await body();
  } finally {
    await invoke(page, "set_script_security_level", { level: previous }).catch(() => undefined);
  }
}

/** A module script in the workbook's library (what Developer > Macros lists), with no provenance. */
async function saveModule(page: Page, id: string, name: string, source: string, description = MODULE_MACRO_DESC): Promise<void> {
  await invoke(page, "save_script", { script: { id, name, description, source, scope: { type: "workbook" } } });
}

/** A module-runtime macro that writes `marker` into (row, col) of the sheet on screen. */
function cellMacro(row: number, col: number, marker: string): string {
  return `Calcula.setCellValue(${row}, ${col}, '${marker}');\n`;
}

/** A one-off object-script macro whose only effect is a toast (allowed at the restricted tier). */
function toastMacro(message: string): string {
  return ["function setup(context) {", `  context.notify(${JSON.stringify(message)}, "info");`, "}", ""].join("\n");
}

interface StoredScript {
  id: string;
  name: string;
  source: string;
  description?: string | null;
  sourcePackage?: string | null;
}

async function storedScript(page: Page, id: string): Promise<StoredScript> {
  return invoke<StoredScript>(page, "get_script", { id });
}

interface ButtonHandle {
  instanceId: string;
  sheetIndex: number;
  row: number;
  col: number;
}

/** A real, clickable floating button through the @api seam (the Controls recipe; `label` becomes `text`). */
async function createButton(
  page: Page,
  req: { sheetIndex: number; row: number; col: number; label: string; macroRef?: string },
): Promise<ButtonHandle> {
  await installAppImport(page);
  return bounded(
    "createButton",
    page.evaluate(
      async ({ mod, req }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          requireButtonControlProvider: () => { createButton: (r: unknown) => Promise<ButtonHandle> };
        };
        return m.requireButtonControlProvider().createButton(req);
      },
      { mod: BUTTONS, req },
    ),
  );
}

interface StoredProp {
  valueType: string;
  value: string;
}

interface ControlEntryRow {
  sheetIndex: number;
  row: number;
  col: number;
  metadata: { controlType: string; properties: Record<string, StoredProp> };
}

/** The stored properties of the control at (row, col), from `get_all_controls`. */
async function controlAt(page: Page, sheetIdx: number, row: number, col: number): Promise<Record<string, StoredProp> | null> {
  const all = await invoke<ControlEntryRow[]>(page, "get_all_controls", { sheetIndex: sheetIdx });
  return all.find((c) => c.row === row && c.col === col)?.metadata.properties ?? null;
}

/** The `heldFrom` stamp of a control, parsed, or null. */
function heldStamp(props: Record<string, StoredProp> | null): { application?: string; version?: string } | null {
  const raw = props?.heldFrom?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { application?: string; version?: string };
  } catch {
    return null;
  }
}

/** Run mode: a click on a button RUNS it (Design Mode would select it instead). */
async function ensureRunMode(page: Page): Promise<void> {
  const design = await callModule<boolean>(page, DESIGN_MODE, "getDesignMode");
  if (design) await callModule(page, DESIGN_MODE, "setDesignMode", [false]);
  expect(await callModule<boolean>(page, DESIGN_MODE, "getDesignMode"), "precondition: Design Mode is off").toBe(false);
}

/** Leave the sheet and come back: the tab strip's route, which reloads its controls. */
async function revisit(page: Page, name: string): Promise<number> {
  const other = (await sheets(page)).sheets.find((s) => s.name !== name);
  if (other) await activate(page, other.name);
  return activate(page, name);
}

/**
 * Make sure the floating buttons anchored at `anchors` are in the Controls
 * extension's floating store for `sheetName` (what paints and hit-tests them);
 * a pulled button can be absent until a tab switch (fixall-calp C4).
 */
async function revealControls(page: Page, sheetName: string, anchors: Array<[number, number]>): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const idx = attempt === 0 ? await activate(page, sheetName) : await revisit(page, sheetName);
    const present = async (): Promise<boolean> => {
      const all = await callModule<Array<{ row: number; col: number }>>(page, FLOATING_STORE, "getFloatingControlsForSheet", [idx]);
      last = JSON.stringify(all.map((f) => [f.row, f.col]));
      return anchors.every(([r, c]) => all.some((f) => f.row === r && f.col === c));
    };
    const ok = await eventually(present, (v) => v, "", 3000).then(
      () => true,
      () => false,
    );
    if (ok) {
      await page.waitForTimeout(300);
      return;
    }
  }
  throw new Error(`the buttons ${JSON.stringify(anchors)} never reached the floating store of "${sheetName}" (it holds ${last})`);
}

/**
 * Click the button anchored at `ref` with the real pointer -- after proving the
 * point is not covered by a dialog, so a click that "ran nothing" cannot be a
 * click that never reached the grid.
 */
async function clickButtonCell(page: Page, grid: GridHelper, ref: string): Promise<void> {
  const p = await grid.cellCenterScrollAware(ref);
  const box = await grid.canvas.boundingBox();
  // Only a cell already on screen can be judged here; an off-screen one is
  // scrolled into view by clickCell itself.
  const onScreen = !!box && p.x >= 0 && p.y >= 0 && p.x <= box.width && p.y <= box.height;
  if (box && onScreen) {
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const area = document.querySelector("[data-grid-area]");
        const inside = !!el && !!area && area.contains(el);
        const what = el ? `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 80)}"` : "(nothing)";
        return { inside, what };
      },
      { x: box.x + p.x, y: box.y + p.y },
    );
    if (!hit.inside) throw new Error(`${ref} is covered by ${ascii(hit.what)}: a click there would not reach the button`);
  }
  await grid.clickCell(ref);
}

async function waitForToast(page: Page, pattern: RegExp, label: string, ms = 20_000): Promise<string> {
  const seen = await eventually(() => toastLog(page), (t) => t.some((x) => pattern.test(x.text)), label, ms);
  return seen.find((x) => pattern.test(x.text))!.text;
}

async function toastTextsLogged(page: Page): Promise<string[]> {
  return (await toastLog(page)).map((t) => t.text);
}

/** The names of the sheets whose `ref` displays `marker`. */
async function sheetsShowing(page: Page, ref: string, marker: string): Promise<string[]> {
  const out: string[] = [];
  for (const s of (await sheets(page)).sheets) {
    if ((await readCell(page, s.index, ref)).display === marker) out.push(s.name);
  }
  return out;
}

// ===========================================================================
// The command line (owner decision B, follow-up F2): a line a person TYPES
// ===========================================================================

/** Press the Command Line toggle the way View > Command Line / Ctrl+Shift+P do (the registered command). */
async function toggleCommandLine(page: Page): Promise<void> {
  await installAppImport(page);
  await page.evaluate(async () => {
    const m = (await (window as unknown as AppWindow).__appImport!("/src/api/commands.ts")) as {
      CommandRegistry: { execute: (id: string) => Promise<unknown> };
    };
    await m.CommandRegistry.execute("commandLine.toggle");
  });
}

/** Open the command line panel (its toggle, falling back to the dialog service) and return it. */
async function openCommandLine(page: Page): Promise<Locator> {
  const header = page.locator("span", { hasText: /^Command Line$/ });
  if ((await header.count()) === 0) {
    await toggleCommandLine(page);
    const opened = await header.first().waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
    if (!opened) {
      log("the toggle did not open the command line; opening it through @api showDialog");
      await callModule(page, "/src/api/index.ts", "showDialog", ["command-line-panel"]);
    }
  }
  await header.first().waitFor({ state: "visible", timeout: 10_000 });
  const panel = header.first().locator("xpath=../..");
  await panel.locator(".monaco-editor").first().waitFor({ state: "visible", timeout: 20_000 });
  return panel;
}

async function closeCommandLine(page: Page): Promise<void> {
  const header = page.locator("span", { hasText: /^Command Line$/ });
  if ((await header.count()) > 0) {
    await header.first().locator("xpath=..").locator("button", { hasText: "\u2715" }).click().catch(() => undefined);
  }
}

async function commandLineEntries(panel: Locator): Promise<string[]> {
  return panel.locator("pre").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
}

/**
 * TYPE `text` at the prompt and run it (Ctrl+Enter, the prompt's run key) -- the
 * person's act the command line's pass stands for. Resolves with the lines the
 * run printed once `done` matches one of them.
 */
async function typeAtCommandLine(page: Page, panel: Locator, text: string, done: RegExp): Promise<string[]> {
  const before = (await commandLineEntries(panel)).length;
  const promptButton = panel.locator("button", { hasText: /^Prompt$/ });
  if ((await promptButton.count()) > 0) await promptButton.click();
  await panel.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press("Control+Enter");
  const lines = await eventually(
    async () => (await commandLineEntries(panel)).slice(before),
    (l) => l.some((x) => done.test(x)),
    `the command line never finished "${text}"`,
    30_000,
  );
  await page.waitForTimeout(500);
  return lines;
}

// ===========================================================================
// The workbook's audit trail (always-on rows; extras are flattened on the entry)
// ===========================================================================

interface AuditRow {
  event: string;
  description: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface ButtonOnRow {
  kind?: string;
  cell?: string;
  caption?: string;
  application?: string | null;
  held?: boolean;
}

async function auditRows(page: Page): Promise<AuditRow[]> {
  const logged = await callModule<{ entries?: AuditRow[] }>(page, COLLAB, "getAuditLog");
  return logged.entries ?? [];
}

function rowsOf(rows: AuditRow[], event: string, app: string): AuditRow[] {
  return rows.filter((r) => r.event === event && r.application === app);
}

function buttonOf(row: AuditRow | undefined): ButtonOnRow | null {
  const b = row?.button;
  return b && typeof b === "object" ? (b as ButtonOnRow) : null;
}

function describeRows(rows: AuditRow[]): string {
  return ascii(
    JSON.stringify(
      rows.map((r) => ({
        event: r.event,
        reason: r.reason,
        surface: r.surface,
        macroId: r.macroId,
        application: r.application,
        button: r.button,
        privateSheets: r.privateSheets,
      })),
    ),
  ).slice(0, 2000);
}

/** Collaboration > Audit Log...: does the viewer show `label` on a row? (Closes the pane after.) */
async function auditViewerShows(page: Page, label: string): Promise<boolean> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.locator("button").filter({ hasText: /^Collaboration$/ }).first().click();
  await page.getByText("Audit Log...", { exact: true }).first().click();
  const shown = await page
    .getByText(label, { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(
      () => true,
      () => false,
    );
  await closeAuditLogPane(page);
  return shown;
}

const AUDIT_LOG_PANE_ID = "collaboration:auditLog";

/**
 * Close the Audit Log task pane AND prove it closed. It docks on the right and
 * narrows the grid by ~500 px, so a pane this spec leaves open moves every
 * later spec's objects under it: run 9 (2026-09-30) lost fixall-canvas V3 to a
 * Ctrl+click that landed on this pane, because the first version of this
 * helper "closed" it through a window global that does not exist.
 */
async function closeAuditLogPane(page: Page): Promise<void> {
  await callModule(page, API, "closeTaskPane", [AUDIT_LOG_PANE_ID]).catch(() => undefined);
  await callModule(page, API, "hideTaskPaneContainer", []).catch(() => undefined);
  await page
    // The pane's intro, shown whether audit logging is on or off.
    .getByText("Script grid-mutations, capability use", { exact: false })
    .first()
    .waitFor({ state: "hidden", timeout: 10_000 })
    .catch(async () => {
      throw new Error("the Audit Log pane is still open after closeTaskPane -- later specs would run against a narrowed grid");
    });
}

// ===========================================================================
// The consent screen (ScriptableObjects' ScriptConsentDialog)
// ===========================================================================

function allowButton(page: Page): Locator {
  return page.getByRole("button", { name: "Allow Scripts", exact: true }).first();
}

/** The consent dialog box: the deepest element holding both its header and its Allow button. */
function consentDialog(page: Page): Locator {
  return page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: "Allow Scripts", exact: true }) })
    .filter({ hasText: "Script Security" })
    .last();
}

/**
 * Wait for the consent screen of `app`. A screen left over for ANOTHER
 * application (the queue is per window, one instance serves every spec) is
 * refused and the next one read.
 */
async function consentPromptFor(page: Page, app: string, firstWaitMs = 20_000): Promise<Locator> {
  const deadline = Date.now() + firstWaitMs;
  for (let i = 0; i < 6; i++) {
    const remaining = Math.max(1500, deadline - Date.now());
    const shown = await allowButton(page)
      .waitFor({ state: "visible", timeout: remaining })
      .then(
        () => true,
        () => false,
      );
    if (!shown) break;
    const box = consentDialog(page);
    const text = await box.innerText().catch(() => "");
    if (text.includes(`"${app}"`)) return box;
    log(`a consent screen for another application was open; refusing it: ${text.slice(0, 160)}`);
    await box.getByRole("button", { name: "Block", exact: true }).click();
    await page.waitForTimeout(600);
  }
  throw new Error(`no consent screen for "${app}" appeared`);
}

/**
 * Allow `app`'s code and wait until the grant is RECORDED (the product's own
 * "enabled" toast). A grant refused because its screen was superseded re-asks;
 * that re-ask is answered too.
 */
async function allowConsentFor(page: Page, app: string, firstWaitMs = 20_000): Promise<void> {
  const enabled = new RegExp(`Scripts from "${escapeRe(app)}" (enabled|approved)`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = await consentPromptFor(page, app, attempt === 0 ? firstWaitMs : 8000);
    await startToastLog(page);
    await prompt.getByRole("button", { name: "Allow Scripts", exact: true }).click();
    const outcome = await eventually(
      async () => {
        const texts = await toastTextsLogged(page);
        if (texts.some((t) => enabled.test(t))) return "enabled";
        if (texts.some((t) => /Nothing was approved/.test(t))) return "reasked";
        return "";
      },
      (v) => v !== "",
      `allowing "${app}" produced neither its "enabled" toast nor a re-ask`,
      20_000,
    );
    if (outcome === "enabled") return;
    log(`the approval of "${app}" was refused and re-asked (attempt ${attempt + 1}); answering again`);
  }
  throw new Error(`"${app}" could not be approved in three attempts`);
}

/** Answer any consent screen that appears (stragglers), up to four. */
async function answerConsentPrompts(page: Page, choice: "Allow Scripts" | "Block", firstWaitMs = 4000): Promise<string[]> {
  const answered: string[] = [];
  let wait = firstWaitMs;
  for (let i = 0; i < 4; i++) {
    const shown = await allowButton(page)
      .waitFor({ state: "visible", timeout: wait })
      .then(
        () => true,
        () => false,
      );
    if (!shown) break;
    const text = await consentDialog(page).innerText().catch(() => "");
    await page.getByRole("button", { name: choice, exact: true }).first().click();
    answered.push(`${choice}: ${text.slice(0, 80)}`);
    await page.waitForTimeout(500);
    wait = 1500;
  }
  return answered;
}

// ===========================================================================
// Native dialogs (tauri-plugin-dialog -> Win32 TaskDialog), driven from outside
// ===========================================================================

function answerNativeDialogRaw(titleLike: string, action: "ok" | "cancel", waitMs = 20_000): string {
  if (!fs.existsSync(DIALOG_DRIVER)) {
    throw new Error(`the native-dialog driver is missing at ${DIALOG_DRIVER}: "no dialog appeared" could not be told from "nothing looked"`);
  }
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DIALOG_DRIVER, "-TitleLike", titleLike, "-Action", action, "-TimeoutMs", String(waitMs)],
      { encoding: "utf-8", timeout: waitMs + 40_000, windowsHide: true },
    );
  } catch (e) {
    return `DRIVERERROR:${String(e)}`;
  }
}

/**
 * Press OK (an OK-like label in any locale) or Cancel on the native dialog
 * whose title contains `titleLike`. The CALLER must already have AWAITED the
 * gesture that raises it: this call blocks Node's event loop.
 */
function answerNativeDialog(titleLike: string, action: "ok" | "cancel"): { text: string; clicked: string } {
  const out = answerNativeDialogRaw(titleLike, action);
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    text: lines
      .filter((l) => l.startsWith("TEXT:"))
      .map((l) => l.slice(5))
      .join(" "),
    clicked: lines.find((l) => l.startsWith("CLICKED:")) ?? lines.join("|"),
  };
}

/** Dismiss leftovers from a crashed run, so the driver never answers a dialog this test did not raise. */
function drainNativeDialogs(titles: string[]): void {
  for (const title of titles) {
    for (let i = 0; i < 3; i++) {
      const r = answerNativeDialogRaw(title, "cancel", 1200);
      if (!r.includes("CLICKED:")) break;
      log(`drained a leftover native dialog titled "${title}"`);
    }
  }
}

// ===========================================================================
// The Checkout dialog (Collaboration > Open Application for Editing...)
// ===========================================================================

async function openCheckoutDialog(page: Page): Promise<Locator> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.locator("button").filter({ hasText: /^Collaboration$/ }).first().click();
  await page.getByText("Open Application for Editing...", { exact: true }).first().click();
  const header = page.locator("span", { hasText: /^Open Application for Editing$/ }).first();
  await header.waitFor({ state: "visible", timeout: 15_000 });
  // header span -> header row -> the dialog window.
  return header.locator("xpath=../..");
}

/** Type the workspace, list its applications, pick `app` (its newest listed version is pre-selected). */
async function chooseApplication(page: Page, dialog: Locator, workspace: string, app: string): Promise<void> {
  await dialog.getByPlaceholder("C:\\shared\\workspace", { exact: true }).fill(workspace);
  await dialog.getByRole("button", { name: "List applications", exact: true }).click();
  const select = dialog.locator("select").filter({ has: page.locator(`option[value="${app}"]`) }).first();
  await select.waitFor({ state: "visible", timeout: 30_000 });
  await select.selectOption(app);
  await dialog.locator('input[type="radio"][name="checkout-version"]').first().waitFor({ state: "visible", timeout: 15_000 });
}

async function pickVersion(dialog: Locator, version: string): Promise<void> {
  const radio = dialog.locator("label").filter({ hasText: `v${version}` }).locator('input[type="radio"]').first();
  await radio.check();
  await expect(radio, `precondition: v${version} is the version being opened`).toBeChecked();
}

async function clickOpenForEditing(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Open for Editing", exact: true }).click();
}

async function waitForCheckoutResult(dialog: Locator, ms = 90_000): Promise<void> {
  const ok = await dialog
    .locator('[data-testid="checkout-result"]')
    .waitFor({ state: "visible", timeout: ms })
    .then(
      () => true,
      () => false,
    );
  if (!ok) {
    const said = await dialog.innerText().catch(() => "(unreadable)");
    throw new Error(`the checkout never showed its result; the dialog says: ${ascii(said).slice(0, 1500)}`);
  }
}

type CheckoutOutcome = { kind: "pending" | "result" | "anchorRemedy" | "error"; text: string };

/** Wait until the dialog shows a result, the anchor remedy, or an error matching `errorPattern`. */
async function checkoutOutcome(dialog: Locator, errorPattern: RegExp, ms = 60_000): Promise<CheckoutOutcome> {
  return eventually<CheckoutOutcome>(
    async () => {
      const text = await dialog.innerText().catch(() => "");
      if ((await dialog.locator('[data-testid="checkout-result"]').count()) > 0) return { kind: "result", text };
      if ((await dialog.locator('[data-testid="checkout-anchor-remedy"]').count()) > 0) return { kind: "anchorRemedy", text };
      if (errorPattern.test(text)) return { kind: "error", text };
      return { kind: "pending", text };
    },
    (o) => o.kind !== "pending",
    "Open for Editing produced no result, no anchor remedy and no refusal",
    ms,
  );
}

async function closeCheckoutDialog(dialog: Locator): Promise<void> {
  const done = dialog.getByRole("button", { name: "Done", exact: true });
  if ((await done.count()) > 0) {
    await done.click();
    return;
  }
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  if ((await cancel.count()) > 0) await cancel.click();
}

// ===========================================================================
// The Subscribe dialog (Collaboration > Subscribe to Application...)
// ===========================================================================

/** Subscribe through the REAL dialog: list, pick, review, accept. Returns the dialog (review mode). */
async function subscribeThroughDialog(page: Page, workspace: string, app: string): Promise<Locator> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.locator("button").filter({ hasText: /^Collaboration$/ }).first().click();
  await page.getByText("Subscribe to Application...", { exact: true }).first().click();
  const header = page.locator("span", { hasText: /^Subscribe to Application$/ }).first();
  await header.waitFor({ state: "visible", timeout: 15_000 });
  const pick = header.locator("xpath=../..");
  await pick.getByPlaceholder("C:\\shared\\workspace  or  https://host/workspace", { exact: true }).fill(workspace);
  await pick.getByRole("button", { name: "List Applications", exact: true }).click();
  const row = pick.getByText(app, { exact: true }).first();
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.click();
  await pick.getByRole("button", { name: "Review Contents...", exact: true }).click();
  const reviewHeader = page.locator("span", { hasText: new RegExp(`^Review: .*${escapeRe(app)}`) }).first();
  await reviewHeader.waitFor({ state: "visible", timeout: 30_000 });
  const review = reviewHeader.locator("xpath=../..");
  await review.getByRole("button", { name: "Accept and Subscribe", exact: true }).click();
  return review;
}

// ===========================================================================
// The Push dialog (Collaboration > Publish Application... on a working copy)
// ===========================================================================

async function openPushDialog(page: Page, app: string): Promise<Locator> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.locator("button").filter({ hasText: /^Collaboration$/ }).first().click();
  await page.getByText("Publish Application...", { exact: true }).first().click();
  const header = page.locator("span", { hasText: new RegExp(`^Push to ${escapeRe(app)}$`) }).first();
  await header.waitFor({ state: "visible", timeout: 30_000 });
  return header.locator("xpath=../..");
}

function pushButton(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: "Push", exact: true });
}

/** Tick every "I have read this code" box the button-code review shows (BUG-0257). */
async function acknowledgeButtonCode(dialog: Locator): Promise<number> {
  const boxes = dialog.locator("input[data-button-code-ack]");
  const n = await boxes.count();
  let ticked = 0;
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i);
    if (!(await box.isChecked().catch(() => true))) {
      await box.click();
      ticked++;
    }
  }
  return ticked;
}

/** Wait until the dialog's own readiness no longer blocks the push (the Push button's `title` is the reason). */
async function waitPushReady(dialog: Locator, label: string): Promise<void> {
  await eventually(
    async () => {
      await acknowledgeButtonCode(dialog);
      return pushButton(dialog).getAttribute("title");
    },
    (reason) => reason === null,
    `${label}: the push dialog still blocks the push`,
    60_000,
  );
}

// ===========================================================================
// The developer anchors (what THIS COMPUTER remembers about creators)
// ===========================================================================

interface DeveloperAnchorRow {
  scopeLabel: string;
  application: string;
  rootName: string;
  rootFingerprint: string;
  rootVersion: string;
  publishersRevision: number;
  anchoredAt: string;
  anchoredBy: string;
}

/** `listTrustedPublishers` -> `calp_list_trusted_publishers`, the call Code in This File makes. */
async function developerAnchors(page: Page): Promise<{ anchors: DeveloperAnchorRow[]; error: string }> {
  const r = await callModule<{ developerAnchors?: DeveloperAnchorRow[]; developerAnchorsError?: string }>(page, COLLAB, "listTrustedPublishers");
  return { anchors: r.developerAnchors ?? [], error: r.developerAnchorsError ?? "" };
}

function anchorOf(anchors: DeveloperAnchorRow[], app: string): DeveloperAnchorRow | undefined {
  return anchors.find((a) => a.application.toLowerCase() === app.toLowerCase());
}

/**
 * The rows of Code in This File's "Applications you develop" section, read off
 * the DOM. The panel is closed and opened again first so it reloads (it reads
 * the machine store on mount), and closed again after.
 */
async function codeInThisFileAnchorRows(page: Page): Promise<string[]> {
  await callModule(page, API, "closePanel", [CODE_IN_FILE_PANEL]).catch(() => undefined);
  await page.waitForTimeout(300);
  await callModule(page, API, "openPanel", [CODE_IN_FILE_PANEL]);
  try {
    // The section carries its test id only once the report has loaded.
    const section = page.locator('[data-testid="developer-anchors"]').first();
    await section.waitFor({ state: "attached", timeout: 20_000 });
    await page.waitForTimeout(400);
    return (await section.locator('[data-testid="developer-anchor-row"]').allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  } finally {
    await callModule(page, API, "closePanel", [CODE_IN_FILE_PANEL]).catch(() => undefined);
  }
}

/** Rust `key_fingerprint`: the first 16 hex characters, lowercase, then "...". */
function fingerprint(keyHex: string): string {
  const key = keyHex.trim();
  return key.length > 16 ? `${key.slice(0, 16).toLowerCase()}...` : key.toLowerCase();
}

// ===========================================================================
// Published files (read from the temp workspace, checksum re-verified)
// ===========================================================================

interface VersionManifestHead {
  version: string;
  publisherKey: string;
  publisherName?: string;
  publishedBy?: string;
  artifactChecksums?: Record<string, string>;
  moduleScripts?: Array<{ id: string; name: string }>;
}

function versionManifest(app: string, version: string): VersionManifestHead {
  return JSON.parse(fs.readFileSync(path.join(WS, app, version, "version-manifest.json"), "utf8")) as VersionManifestHead;
}

/** One published artifact, located the way the workspace reads it and hashed against its signed manifest here. */
function publishedArtifact(app: string, version: string, rel: string): { checksum: string; text: string } {
  const manifest = versionManifest(app, version);
  const sum = manifest.artifactChecksums?.[rel];
  if (!sum) throw new Error(`${app}@${version} lists no ${rel}: ${Object.keys(manifest.artifactChecksums ?? {}).join(", ")}`);
  const hex = sum.replace(/^sha256:/, "");
  const direct = path.join(WS, app, version, ...rel.split("/"));
  const blob = path.join(WS, ".blobs", hex.slice(0, 2), hex);
  const file = fs.existsSync(direct) ? direct : blob;
  if (!fs.existsSync(file)) throw new Error(`${app}@${version} ${rel}: neither ${direct} nor ${blob} exists`);
  const bytes = fs.readFileSync(file);
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== hex) throw new Error(`${app}@${version} ${rel}: the file hashes to ${actual}, the manifest says ${hex}`);
  return { checksum: hex, text: bytes.toString("utf8") };
}

// ===========================================================================
// Planting versions the way anyone who can write to the share can
// ===========================================================================

interface Signer {
  name: string;
  key: string;
  fingerprint: string;
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
}

/** A fresh Ed25519 key nobody authorised. */
function newSigner(name: string): Signer {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("plant: Node exported no raw Ed25519 public key");
  const key = Buffer.from(jwk.x, "base64url").toString("hex");
  if (key.length !== 64) throw new Error(`plant: expected a 32-byte key, got ${key}`);
  return { name, key, fingerprint: fingerprint(key), publicKey, privateKey };
}

/** Re-key a version manifest's TEXT to `signer` (key, display name, publishedBy), every other byte as Rust wrote it. */
function reKey(text: string, parsed: VersionManifestHead, signer: Signer): string {
  let out = text.replace(`"publisherKey": "${parsed.publisherKey}"`, `"publisherKey": "${signer.key}"`);
  out =
    parsed.publisherName !== undefined
      ? out.replace(/"publisherName": "[^"]*"/, `"publisherName": "${signer.name}"`)
      : out.replace(`"publisherKey": "${signer.key}"`, `"publisherKey": "${signer.key}",\n  "publisherName": "${signer.name}"`);
  if (parsed.publishedBy !== undefined) out = out.replace(/"publishedBy": "[^"]*"/, `"publishedBy": "${signer.name}"`);
  return out;
}

/** Write a manifest and its detached signature (lowercase hex, the format `calp::signing` writes). */
function writeSigned(dir: string, text: string, signer: Signer): void {
  const bytes = Buffer.from(text, "utf8");
  const signature = crypto.sign(null, bytes, signer.privateKey);
  if (!crypto.verify(null, bytes, signer.publicKey, signature)) throw new Error("plant: Node could not verify its own signature");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "version-manifest.json"), bytes);
  fs.writeFileSync(path.join(dir, "version-manifest.sig"), signature.toString("hex"));
}

/** Re-sign an existing version as `signer`. The signature is VALID; only the authorisation can refuse it. */
function resignVersionAs(app: string, version: string, signer: Signer): void {
  const dir = path.join(WS, app, version);
  const original = fs.readFileSync(path.join(dir, "version-manifest.json"), "utf8");
  const parsed = JSON.parse(original) as VersionManifestHead;
  const text = reKey(original, parsed, signer);
  const check = JSON.parse(text) as VersionManifestHead;
  if (check.publisherKey !== signer.key || check.publisherName !== signer.name) {
    throw new Error(`plant: re-signing ${app}@${version} did not land (key ${check.publisherKey}, name ${check.publisherName})`);
  }
  writeSigned(dir, text, signer);
}

/**
 * Plant a FIRST VERSION `rootVersion` below every real one: a copy of
 * `copyOf`'s manifest, re-keyed to `signer` and signed by it, listed first in
 * the (unsigned) application listing. It verifies under its own key, so the
 * workspace proves it as the application's root -- exactly what a share-writer
 * can do. Returns the genuine listing's bytes so it can be written back.
 */
function plantFirstVersion(app: string, copyOf: string, rootVersion: string, signer: Signer): { listingPath: string; listingBackup: Buffer } {
  const original = fs.readFileSync(path.join(WS, app, copyOf, "version-manifest.json"), "utf8");
  const parsed = JSON.parse(original) as VersionManifestHead;
  let text = original.replace(`"version": "${copyOf}"`, `"version": "${rootVersion}"`);
  text = reKey(text, parsed, signer);
  const check = JSON.parse(text) as VersionManifestHead;
  if (check.version !== rootVersion || check.publisherKey !== signer.key) {
    throw new Error(`plant: the ${rootVersion} manifest edit did not land (version ${check.version}, key ${check.publisherKey})`);
  }
  writeSigned(path.join(WS, app, rootVersion), text, signer);

  const listingPath = path.join(WS, app, "calp-manifest.json");
  const listingBackup = fs.readFileSync(listingPath);
  const listing = JSON.parse(listingBackup.toString("utf8")) as { versions: Array<Record<string, unknown>> };
  if (!Array.isArray(listing.versions) || listing.versions.length === 0) throw new Error(`plant: ${app}'s listing has no versions`);
  const entry: Record<string, unknown> = { ...listing.versions[0], version: rootVersion, publisherKey: signer.key, publishedBy: signer.name };
  delete entry.baseVersion;
  listing.versions.unshift(entry);
  fs.writeFileSync(listingPath, JSON.stringify(listing, null, 2));
  return { listingPath, listingBackup };
}

// ===========================================================================
// THE JOURNEY
// ===========================================================================

/** What M4-1 leaves for M4-2 (ii): one subscriber workbook, approved, its click proved. */
interface SubscriberState {
  app: string;
  sheetName: string;
  macroId: string;
  macroName: string;
  marker: string;
}

// ===========================================================================
// Developer > Macros... and the Macro Recorder's own source (M4-7)
// ===========================================================================

const RUNNER = "/src/api/objectScriptRunner.ts";
/** The Macro Recorder's code generator: the SAME function every recording ends in. */
const CODEGEN = "/extensions/MacroRecorder/lib/actionCodegen.ts";

/**
 * What the Macro Recorder saves for "type `value` into (row, col) of sheet
 * `sheetIdx`", object-script target, its defaults on (initial sheet activation,
 * one undo batch, the `if (!context.api)` scaffold) -- generated by the running
 * app, not written by hand, so M4-7 runs a RECORDED macro.
 */
async function recordedCellMacro(page: Page, name: string, sheetIdx: number, row: number, col: number, value: string): Promise<string> {
  const generated = await callModule<{ source: string; unsupported: string[] }>(page, CODEGEN, "generateMacroSource", [
    [{ seq: 1, sheetIndex: sheetIdx, event: { kind: "cellWrites", writes: [{ row, col, value, invariant: false }] } }],
    { target: "objectScript", wrapper: "objectScript", name, recordedAt: `e2e ${RUN}` },
  ]);
  expect(generated.unsupported, "the recorder could not express the recording").toEqual([]);
  return generated.source;
}

async function openMacrosDialog(page: Page, grid: GridHelper): Promise<Locator> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await grid.openMenu("Developer");
  const item = page.locator("button").filter({ hasText: /^Macros/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  const library = page.locator("[data-macro-library-dialog]");
  await expect(library, "Developer > Macros... did not open the macro library").toBeVisible({ timeout: 10_000 });
  return library;
}

/** Select `name` in the open library: it must be listed once and run as an OBJECT SCRIPT. */
async function selectInMacrosDialog(library: Locator, name: string): Promise<void> {
  const row = library.locator("[data-macro-library-item]").filter({ hasText: name });
  await expect(row, `the Macros dialog does not list "${name}" exactly once`).toHaveCount(1);
  await row.click();
  await expect(library.locator("[data-macro-run-route]"), `"${name}" would not run as an object script`).toHaveAttribute(
    "data-macro-run-route",
    "objectScript",
  );
}

/** Press Run on the selected macro; resolve with what the dialog then reports (error or output). */
async function pressRunInMacrosDialog(library: Locator, name: string): Promise<{ error: string; output: string }> {
  const run = library.locator("[data-macro-run-button]");
  await expect(run, `Run is not enabled for "${name}"`).toBeEnabled();
  await run.click();
  return eventually(
    async () => ({
      error: (await library.locator("[data-macro-error]").count()) > 0 ? await library.locator("[data-macro-error]").innerText() : "",
      output: (await library.locator("[data-macro-output]").count()) > 0 ? await library.locator("[data-macro-output]").innerText() : "",
    }),
    (o) => o.error !== "" || o.output !== "",
    `Run on "${name}" reported neither an outcome nor an error`,
    45_000,
  );
}

async function closeMacrosDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page
    .locator("[data-macro-library-dialog]")
    .waitFor({ state: "hidden", timeout: 10_000 })
    .catch(() => undefined);
}

/** Clear `ref` on every sheet that shows `marker`. */
async function clearMarker(page: Page, ref: string, marker: string): Promise<void> {
  for (const name of await sheetsShowing(page, ref, marker)) await setCells(page, await sheetIndex(page, name), [[ref, ""]]);
}

interface CellTypeEntry {
  row: number;
  col: number;
  typeId: string;
  params: Record<string, unknown> | null;
}

/** The cell-type assignments of one sheet, from the backend's own store. */
async function cellTypesOn(page: Page, sheetIdx: number): Promise<CellTypeEntry[]> {
  return invoke<CellTypeEntry[]>(page, "get_all_cell_types", { sheetIndex: sheetIdx });
}

/** Whether the object script `id` is mounted (a standing realm is live). */
async function scriptMounted(page: Page, id: string): Promise<boolean> {
  await installAppImport(page);
  return page.evaluate(async (scriptId) => {
    const m = (await (window as unknown as AppWindow).__appImport!("/src/api/index.ts")) as {
      ObjectScriptManager: { isScriptMounted: (id: string) => boolean };
    };
    return m.ObjectScriptManager.isScriptMounted(scriptId);
  }, id);
}

/**
 * A STANDING object script for a button that, when its button is clicked, tries
 * to start the macro `macroId` the only ways a restricted realm could: through
 * `context.api` (null at the restricted tier -- said loudly if it ever is not)
 * and by posting the broker call `api.runMacro` itself. It says `marker` FIRST,
 * so the attempt is proved to have happened whatever the host does with it.
 */
function standingRunMacroProbe(macroId: string, marker: string, hasApiMarker: string): string {
  return [
    "function setup(button) {",
    "  button.onClick(() => {",
    `    button.notify(${JSON.stringify(marker)}, "info");`,
    "    if (button.api) {",
    `      button.notify(${JSON.stringify(hasApiMarker)}, "error");`,
    `      return button.api.runMacro(${JSON.stringify(macroId)});`,
    "    }",
    "    try {",
    `      self.postMessage({ t: "call", callId: 990001, method: "api.runMacro", args: [${JSON.stringify(macroId)}] });`,
    "    } catch (e) {",
    "      // A realm that cannot post raw broker calls has nothing more to try.",
    "    }",
    "  });",
    "}",
    "",
  ].join("\n");
}

test.describe("calp macro buttons, live (M4: held links, consent, private sheets, include, developer anchor)", () => {
  test.beforeAll(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
  });

  test.afterAll(async ({ sharedPage: page }) => {
    // The anchors this run recorded in the REAL profile point at a temp
    // workspace; forget them so the profile does not accumulate them.
    for (const app of CREATED_APPS) {
      const r = await tryModule(page, COLLAB, "forgetDeveloperAnchor", [WS, app]);
      log(`cleanup: forget the developer anchor of ${app}: ${r.ok ? JSON.stringify(r.value) : r.error}`);
    }
    // File > New closes no task pane: whatever this spec opened must not
    // narrow the grid for the specs after it.
    await closeAuditLogPane(page).catch((e) => log(`cleanup: ${String(e)}`));
    await newFile(page).catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // M4-1 and M4-2 (ii) share ONE subscriber workbook: serial.
  // -------------------------------------------------------------------------
  test.describe.serial("M4-1 + M4-2 (ii): one subscriber workbook", () => {
    let subscriber: SubscriberState | null = null;

    test("M4-1: a subscribed button keeps its macro link HELD, the consent screen names it, a click before Allow writes nothing, and after Allow the click runs the application's macro with an application_code_run row naming the application, macro and button", async ({
      appPage: page,
      grid,
    }) => {
      test.setTimeout(480_000);
      const app = `m41-buttons-${RUN}`;
      const sheetName = `Btn${RUN}`;
      const macroId = `macro-m41-${RUN}`;
      const macroName = `Run report ${RUN}`;
      const caption = "Run report";
      const MARKER = `M41-RAN-${RUN}`;
      CREATED_APPS.push(app);

      await withScriptsEnabled(page, async () => {
        // ---- The publisher: a macro that writes J12, and a button LINKED to it.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await ensureRunMode(page);
        await saveModule(page, macroId, macroName, cellMacro(11, 9, MARKER));
        await createButton(page, { sheetIndex: pub, row: 1, col: 1, label: caption, macroRef: macroId });
        await revealControls(page, sheetName, [[1, 1]]);
        await clickButtonCell(page, grid, "B2");
        await eventually(
          () => readCell(page, pub, "J12").then((c) => c.display),
          (v) => v === MARKER,
          "POSITIVE CONTROL: the publisher's own linked button did not run its macro (J12), so every negative below would prove nothing",
          20_000,
        );
        await setCells(page, pub, [["J12", ""]]);
        expect((await publishNew(page, WS, app, "1.0.0")).version, `precondition: ${app} was published`).toBe("1.0.0");

        // ---- The subscriber.
        await newFile(page);
        const pulled = (await subscribe(page, WS, app)) as PullResult & { buttonLinksHeld?: number; buttonLinksRemoved?: string[] };
        expect(pulled.buttonLinksRemoved ?? [], "the subscribe removed the application's own link").toEqual([]);
        expect.soft(pulled.buttonLinksHeld ?? -1, "the subscribe did not count the held link").toBe(1);
        const sub = await sheetIndex(page, sheetName);

        // STATE: held, stamped, not live.
        const props = await controlAt(page, sub, 1, 1);
        expect(props, "the linked button did not arrive").toBeTruthy();
        expect(props!.macroRef, "the subscribed button carries a LIVE macroRef").toBeUndefined();
        expect(props!.heldMacroRef?.value, "the macro link is not in the held compartment").toBe(macroId);
        const stamp = heldStamp(props);
        expect(stamp?.application, "the held link is not stamped with its application").toBe(app);
        expect(stamp?.version).toBe("1.0.0");

        // DOM: the consent screen names the button under its macro.
        const prompt = await consentPromptFor(page, app);
        await expect(prompt.locator(`[data-consent-macro="${macroId}"]`), "the consent screen does not list the macro").toHaveCount(1);
        const listed = prompt.locator(`[data-consent-macro-buttons="${macroId}"]`);
        await expect(listed, "the consent screen names no button under the macro").toHaveCount(1);
        const listedText = (await listed.innerText()).replace(/\s+/g, " ");
        expect(listedText, "the consent screen does not name the button's cell").toContain(`${sheetName}!B2`);
        expect(listedText, "the consent screen does not name the button's caption").toContain(`"${caption}"`);

        // ---- NEGATIVE CONTROL: Block, then click. Nothing may be written.
        await prompt.getByRole("button", { name: "Block", exact: true }).click();
        await allowButton(page).waitFor({ state: "hidden", timeout: 10_000 });
        await activate(page, sheetName);
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1]]);
        expect((await readCell(page, sub, "J12")).display, "precondition: J12 is empty before any click").toBe("");
        const before = await auditRows(page);
        const refusedBefore = rowsOf(before, "application_code_refused", app).length;
        const ranBefore = rowsOf(before, "application_code_run", app).length;
        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, "B2");
        const voiced = await waitForToast(
          page,
          new RegExp(escapeRe(`"${macroName}"`)),
          "the click on the held link before Allow was not voiced (a refusal must never be silent)",
        );
        await page.waitForTimeout(1500);
        expect(await sheetsShowing(page, "J12", MARKER), "NEGATIVE CONTROL: before Allow, the click ran the application's macro").toEqual([]);
        const afterRefusal = await auditRows(page);
        expect(rowsOf(afterRefusal, "application_code_run", app).length, "a refused click left an application_code_run row").toBe(ranBefore);
        const newRefused = rowsOf(afterRefusal, "application_code_refused", app).slice(refusedBefore);
        const door =
          newRefused.length > 0
            ? `the Rust run gate (application_code_refused reason=${String(newRefused[0].reason)} surface=${String(newRefused[0].surface)})`
            : "the page, before Rust was asked (no application_code_refused row was written)";
        log(`M4-1 negative control: the click before Allow was refused by ${door}; toast: ${voiced.slice(0, 300)}`);
        test.info().annotations.push({ type: "M4-1 refusing door", description: door });
        if (newRefused.length > 0) {
          expect.soft(newRefused[0].reason, `the Rust refusal row: ${describeRows(newRefused)}`).toBe("notConsented");
          expect.soft(buttonOf(newRefused[0])?.cell, "the refusal row does not name the button").toBe(`${sheetName}!B2`);
        }

        // ---- Allow (the screen asked again by the same announcement a pull makes).
        await emitApp(page, "PACKAGE_UPDATED", { packageName: app, version: "1.0.0", kind: "subscribe", sheetsPulled: 0, scriptsPulled: 0 });
        await allowConsentFor(page, app);

        // ---- The click runs the application's macro.
        await activate(page, sheetName);
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1]]);
        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, "B2");
        await eventually(
          () => readCell(page, sub, "J12").then((c) => c.display),
          (v) => v === MARKER,
          `after Allow, the held link did not run the application's macro (J12); toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );

        // STATE: the always-on run row names the application, the macro and the button.
        const runs = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_run", app),
          (r) => r.some((x) => x.macroId === macroId),
          "no application_code_run row names the macro",
          15_000,
        );
        const run = runs.filter((x) => x.macroId === macroId).pop()!;
        const b = buttonOf(run);
        expect(b?.cell, `the run row does not name the button: ${describeRows([run])}`).toBe(`${sheetName}!B2`);
        expect(b?.caption, "the run row does not carry the button's caption").toBe(caption);
        expect(b?.held, "the run row does not say the link came with the application").toBe(true);
        expect(b?.application, "the run row's button is not attributed to the application").toBe(app);
        expect.soft(b?.kind).toBe("control");
        expect.soft(run.surface, "a module-runtime macro ran through another door").toBe("moduleRuntime");
        expect(run.description, "the run row's text names neither the macro nor the application").toContain(`'${macroId}' from the application '${app}'`);
        expect.soft(await auditViewerShows(page, "Application code ran"), "Collaboration > Audit Log does not show 'Application code ran'").toBe(true);

        subscriber = { app, sheetName, macroId, macroName, marker: MARKER };
      });
      // No File > New: M4-2 (ii) continues in this workbook.
    });

    test("M4-2 (ii): after admission, the application's macro replaced by a LOCAL one of the same id is refused on the click by requirePackage before anything runs (no marker, button_code_refused row); the local macro still runs from the user's own button", async ({
      appPage: page,
      grid,
    }) => {
      test.setTimeout(300_000);
      const s = subscriber;
      if (!s) throw new Error("M4-1 did not leave its subscriber workbook");
      const LOCAL = `M42-LOCAL-${RUN}`;
      const lookalike = `Local lookalike ${RUN}`;
      try {
        await withScriptsEnabled(page, async () => {
          // Preconditions: M4-1's workbook, the application's macro stamped.
          const theirs = await storedScript(page, s.macroId);
          expect(theirs.sourcePackage, "precondition: the macro is the application's (stamped)").toBe(s.app);
          const idx = await activate(page, s.sheetName);
          await setCells(page, idx, [["J12", ""]]);

          // ---- The confused deputy: a LOCAL macro under the application's id.
          await invoke(page, "delete_script", { id: s.macroId });
          await saveModule(page, s.macroId, lookalike, cellMacro(13, 9, LOCAL));
          const mine = await storedScript(page, s.macroId);
          expect(mine.sourcePackage ?? null, "precondition: the replacement is the user's own (no provenance)").toBeNull();
          expect(mine.source).toContain(LOCAL);
          const props = await controlAt(page, idx, 1, 1);
          expect(props?.heldMacroRef?.value, "precondition: the button still holds the application's link").toBe(s.macroId);
          expect(heldStamp(props)?.application).toBe(s.app);

          // ---- The click: refused on the page, nothing runs.
          const before = await auditRows(page);
          const rustRowsBefore = rowsOf(before, "application_code_run", s.app).length + rowsOf(before, "application_code_refused", s.app).length;
          await ensureRunMode(page);
          await revealControls(page, s.sheetName, [[1, 1]]);
          await dismissToasts(page);
          await startToastLog(page);
          await clickButtonCell(page, grid, "B2");
          const refusal = await waitForToast(
            page,
            new RegExp(escapeRe(`This button came with the application "${s.app}"`)),
            "the click on the application's button naming a LOCAL macro was not refused by name (requirePackage)",
          );
          expect(refusal, "the refusal does not say the macro is the user's own").toMatch(/is one of your own/);
          expect(refusal, "the refusal does not name the macro").toContain(`"${lookalike}"`);
          await page.waitForTimeout(1500);
          expect(await sheetsShowing(page, "J14", LOCAL), "the application's button ran the user's LOCAL macro (the confused deputy)").toEqual([]);
          expect(await sheetsShowing(page, "J12", s.marker), "something ran the application's old macro").toEqual([]);

          // STATE: the trail.
          const rows = await eventually(
            async () => rowsOf(await auditRows(page), "button_code_refused", s.app),
            (r) => r.some((x) => x.reason === "macroNotFromApplication"),
            "no button_code_refused (macroNotFromApplication) row",
            15_000,
          );
          const row = rows.filter((x) => x.reason === "macroNotFromApplication").pop()!;
          expect(row.kind, `the refusal row: ${describeRows([row])}`).toBe("control");
          expect(row.door).toBe("click");
          expect(row.cells as unknown[], "the refusal row does not name the button's cell").toContain(`${s.sheetName}!B2`);
          const after = await auditRows(page);
          const rustRowsAfter = rowsOf(after, "application_code_run", s.app).length + rowsOf(after, "application_code_refused", s.app).length;
          log(
            `M4-2 (ii): the click was refused by the page (requirePackage); Rust run-gate rows for this click: ${rustRowsAfter - rustRowsBefore}`,
          );
          test.info().annotations.push({ type: "M4-2 (ii) refusing door", description: "the page: requirePackage in the macro-run seam" });
          expect.soft(rustRowsAfter, "the page refused, yet a Rust run-gate row was written for this click").toBe(rustRowsBefore);

          // ---- POSITIVE CONTROL: the local macro runs from the user's OWN button.
          const s1 = await activate(page, "Sheet1");
          await createButton(page, { sheetIndex: s1, row: 1, col: 1, label: "Mine", macroRef: s.macroId });
          await revealControls(page, "Sheet1", [[1, 1]]);
          await clickButtonCell(page, grid, "B2");
          await eventually(
            () => readCell(page, s1, "J14").then((c) => c.display),
            (v) => v === LOCAL,
            "POSITIVE CONTROL: the user's own button did not run the local macro (J14), so the refusal above proves nothing",
            20_000,
          );
        });
      } finally {
        await newFile(page).catch(() => undefined);
      }
    });
  });

  // -------------------------------------------------------------------------
  // M4-2 (i): at admission.
  // -------------------------------------------------------------------------
  test("M4-2 (i): at admission, a subscriber who already owns the application's macro id keeps theirs, the Subscribe dialog names the removed link, no link is held, and the click never reaches the subscriber's macro", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(360_000);
    const app = `m42-clash-${RUN}`;
    const sheetName = `Clash${RUN}`;
    const macroId = `macro-m42-${RUN}`;
    const APP_MARKER = `M42-APP-${RUN}`;
    const LOCAL = `M42-MINE-${RUN}`;
    CREATED_APPS.push(app);
    try {
      await withScriptsEnabled(page, async () => {
        // ---- The publisher ships macroId and a button linking it.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await saveModule(page, macroId, `App macro ${RUN}`, cellMacro(11, 9, APP_MARKER));
        await createButton(page, { sheetIndex: pub, row: 1, col: 1, label: "Clash", macroRef: macroId });
        expect((await publishNew(page, WS, app, "1.0.0")).version, `precondition: ${app} was published`).toBe("1.0.0");

        // ---- The subscriber already owns macroId.
        await newFile(page);
        await saveModule(page, macroId, `My macro ${RUN}`, cellMacro(13, 9, LOCAL));

        // ---- Subscribe through the REAL dialog.
        const dialog = await subscribeThroughDialog(page, WS, app);
        const notice = dialog.locator('[data-testid="subscribe-button-links-removed"]');
        const shown = await notice
          .waitFor({ state: "visible", timeout: 60_000 })
          .then(
            () => true,
            () => false,
          );
        if (!shown) {
          throw new Error(`the Subscribe dialog shows no removed-link notice; it says: ${ascii(await dialog.innerText().catch(() => "")).slice(0, 1500)}`);
        }
        const noticeText = (await notice.innerText()).replace(/\s+/g, " ");
        expect(noticeText, "the notice does not name the button").toContain(`${sheetName}!B2`);
        expect(noticeText, "the notice does not name the macro").toContain(`"${macroId}"`);
        expect(noticeText, "the notice does not name the application").toContain(`'${app}'`);
        const consent = await answerConsentPrompts(page, "Block", 2500);
        log(`M4-2 (i): consent screens after the subscribe: ${JSON.stringify(consent)}`);
        await dialog.getByRole("button", { name: "Close" }).first().click();

        // STATE: no link held, the subscriber's macro untouched.
        const sub = await sheetIndex(page, sheetName);
        const props = await controlAt(page, sub, 1, 1);
        expect(props, "the button did not arrive").toBeTruthy();
        expect(props!.macroRef, "the removed link arrived LIVE").toBeUndefined();
        expect(props!.heldMacroRef, "a link to a macro this pull did not land was HELD").toBeUndefined();
        const mine = await storedScript(page, macroId);
        expect(mine.sourcePackage ?? null, "the pull replaced the subscriber's own macro").toBeNull();
        expect(mine.source).toContain(LOCAL);

        // ---- The click reaches nothing.
        await activate(page, sheetName);
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1]]);
        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, "B2");
        await page.waitForTimeout(2500);
        log(`M4-2 (i): toasts after the click: ${JSON.stringify(await toastTextsLogged(page))}`);
        expect(await sheetsShowing(page, "J14", LOCAL), "the application's button ran the subscriber's own macro (BUG-0260 class)").toEqual([]);
        expect(await sheetsShowing(page, "J12", APP_MARKER), "the application's macro ran although it never landed").toEqual([]);

        // ---- POSITIVE CONTROL: the subscriber's macro runs from their own button.
        const s1 = await activate(page, "Sheet1");
        await createButton(page, { sheetIndex: s1, row: 1, col: 1, label: "Mine", macroRef: macroId });
        await revealControls(page, "Sheet1", [[1, 1]]);
        await clickButtonCell(page, grid, "B2");
        await eventually(
          () => readCell(page, s1, "J14").then((c) => c.display),
          (v) => v === LOCAL,
          "POSITIVE CONTROL: the subscriber's own button did not run their macro (J14)",
          20_000,
        );
      });
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // M4-3: the working-copy private-sheet rule, on both doors, and its remedy.
  // -------------------------------------------------------------------------
  test("M4-3: a checkout beside the developer's own non-blank Sheet1 names it, refuses the application's macros on both doors (module runtime and one-off mount) with privateSheets rows, and 'Open it in a new workbook' opens the same version where both run", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);
    const app = `m43-private-${RUN}`;
    const sheetName = `Wc${RUN}`;
    const moduleId = `macro-m43-mod-${RUN}`;
    const moduleName = `Module macro ${RUN}`;
    const MOD_MARKER = `M43-MOD-${RUN}`;
    const objectId = `macro-m43-obj-${RUN}`;
    const objectName = `Object macro ${RUN}`;
    const OBJ_TOAST = `M43-OBJ-${RUN}`;
    CREATED_APPS.push(app);
    let dialog: Locator | null = null;
    try {
      drainNativeDialogs([UNSAVED_TITLE]);
      await withScriptsEnabled(page, async () => {
        // ---- The publisher: one macro per door, one button each, both proved.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await ensureRunMode(page);
        await saveModule(page, moduleId, moduleName, cellMacro(11, 9, MOD_MARKER));
        await saveModule(page, objectId, objectName, toastMacro(OBJ_TOAST), OBJECT_MACRO_DESC);
        await createButton(page, { sheetIndex: pub, row: 1, col: 1, label: "Module macro", macroRef: moduleId });
        await createButton(page, { sheetIndex: pub, row: 3, col: 1, label: "Object macro", macroRef: objectId });
        await revealControls(page, sheetName, [[1, 1], [3, 1]]);
        await clickButtonCell(page, grid, "B2");
        await eventually(
          () => readCell(page, pub, "J12").then((c) => c.display),
          (v) => v === MOD_MARKER,
          "POSITIVE CONTROL: the publisher's module-runtime macro did not write J12",
          20_000,
        );
        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, "B4");
        await waitForToast(page, new RegExp(escapeRe(OBJ_TOAST)), "POSITIVE CONTROL: the publisher's objectScript macro did not show its toast");
        await setCells(page, pub, [["J12", ""]]);
        expect((await publishNew(page, WS, app, "1.0.0")).version, `precondition: ${app} was published`).toBe("1.0.0");

        // ---- The developer: a workbook whose own Sheet1 is NOT blank.
        await newFile(page);
        await setCells(page, await sheetIndex(page, "Sheet1"), [["A1", `private ${RUN}`]]);
        dialog = await openCheckoutDialog(page);
        await chooseApplication(page, dialog, WS, app);
        await clickOpenForEditing(dialog);
        await waitForCheckoutResult(dialog);
        const privateBox = dialog.locator('[data-testid="checkout-private-sheets"]');
        await expect(privateBox, "the checkout does not say the developer's own sheet sits beside the application").toBeVisible({ timeout: 15_000 });
        expect(await privateBox.innerText(), "the private-sheets notice does not name Sheet1").toContain("Sheet1");
        await expect(dialog.locator('[data-testid="checkout-private-sheets-new-workbook"]'), "the remedy is not offered").toBeVisible();
        await allowConsentFor(page, app);
        expect((await workingCopy(page))?.packageName, "precondition: the workbook is the application's working copy").toBe(app);
        const dev = await sheetIndex(page, sheetName);
        expect((await readCell(page, dev, "J12")).display, "precondition: J12 is empty").toBe("");

        // ---- Both doors refuse beside Sheet1.
        await activate(page, sheetName);
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1], [3, 1]]);
        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, "B2");
        const modRefusal = await waitForToast(
          page,
          new RegExp(`${escapeRe(`"${moduleName}"`)} did not run: .*APPLICATION_CODE_BESIDE_PRIVATE_SHEETS`),
          "the module-runtime macro was not refused beside Sheet1 (distributed_run_gate)",
        );
        await page.waitForTimeout(1000);
        expect(await sheetsShowing(page, "J12", MOD_MARKER), "the module-runtime macro RAN beside the developer's own sheet").toEqual([]);

        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, "B4");
        const objRefusal = await waitForToast(
          page,
          new RegExp(`${escapeRe(`"${objectName}"`)} did not run: .*APPLICATION_CODE_BESIDE_PRIVATE_SHEETS`),
          "the objectScript macro was not refused beside Sheet1 (mount_run_gate)",
        );
        await page.waitForTimeout(1500);
        expect((await toastTextsLogged(page)).filter((t) => t.includes(OBJ_TOAST)), "the objectScript macro RAN beside the developer's own sheet").toEqual([]);
        log(`M4-3 refusals: module: ${modRefusal.slice(0, 200)} | object: ${objRefusal.slice(0, 200)}`);

        // STATE: one privateSheets row per door.
        const refused = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_refused", app).filter((r) => r.reason === "privateSheets"),
          (r) => r.some((x) => x.surface === "moduleRuntime") && r.some((x) => x.surface === "object-script"),
          "the two privateSheets rows (moduleRuntime and object-script) were not both written",
          15_000,
        );
        log(`M4-3 privateSheets rows: ${describeRows(refused)}`);
        const modRow = refused.find((x) => x.surface === "moduleRuntime")!;
        expect(modRow.macroId, `the module-runtime refusal row: ${describeRows([modRow])}`).toBe(moduleId);
        expect(modRow.privateSheets as unknown[], "the refusal row does not name Sheet1").toContain("Sheet1");
        expect.soft(buttonOf(modRow)?.cell).toBe(`${sheetName}!B2`);
        const objRow = refused.find((x) => x.surface === "object-script")!;
        expect.soft(objRow.macroId, `the mount refusal row: ${describeRows([objRow])}`).toBe(objectId);
        expect.soft(objRow.privateSheets as unknown[]).toContain("Sheet1");
        expect.soft(buttonOf(objRow)?.cell).toBe(`${sheetName}!B4`);
        test.info().annotations.push({
          type: "M4-3 refusing doors",
          description: `module runtime: ${String(modRow.surface)}; one-off mount: ${String(objRow.surface)}`,
        });

        // ---- THE REMEDY: the same version in a fresh workbook (asks first: native confirm).
        expect(await isDirty(page), "precondition: the workbook is modified, so the remedy must ask first").toBe(true);
        await dialog.locator('[data-testid="checkout-private-sheets-new-workbook"]').click();
        const verdict = answerNativeDialog(UNSAVED_TITLE, "ok");
        log(`M4-3 '${UNSAVED_TITLE}': ${verdict.clicked} ${verdict.text.slice(0, 160)}`);
        expect(verdict.clicked, "the 'Unsaved changes' question never appeared or was not answered").toMatch(/^CLICKED:/);
        await eventually(
          () => sheetNames(page),
          (n) => n.length === 2 && n.includes("Sheet1") && n.includes(sheetName),
          "the remedy did not open the application in a fresh workbook",
          60_000,
        );
        await allowConsentFor(page, app);
        await eventually(
          () => dialog!.locator('[data-testid="checkout-private-sheets"]').count(),
          (c) => c === 0,
          "the fresh workbook still reports private sheets",
          30_000,
        );
        await expect(dialog.locator('[data-testid="checkout-result"]'), "the dialog does not show the SAME version opened again").toContainText(
          `Opened ${app} v1.0.0 for editing`,
        );
        expect((await workingCopy(page))?.baseVersion, "the remedy opened a different version").toBe("1.0.0");
        expect((await readCell(page, await sheetIndex(page, "Sheet1"), "A1")).display, "the fresh workbook still holds the private cell").toBe("");

        // ---- Both run now.
        const dev2 = await activate(page, sheetName);
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1], [3, 1]]);
        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, "B2");
        await eventually(
          () => readCell(page, dev2, "J12").then((c) => c.display),
          (v) => v === MOD_MARKER,
          `in the fresh workbook the module-runtime macro did not run (J12); toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );
        await startToastLog(page);
        // DIAGNOSTIC (run 9, 2026-09-30: this click showed no toast AND no
        // refusal -- a silent non-run). On failure, say what the page and the
        // audit trail saw, so the next run explains itself.
        const consoleSeen: string[] = [];
        const onConsole = (m: { type: () => string; text: () => string }) => {
          consoleSeen.push(`${m.type()}: ${m.text().slice(0, 300)}`);
        };
        page.on("console", onConsole);
        await clickButtonCell(page, grid, "B4");
        try {
          await waitForToast(page, new RegExp(escapeRe(OBJ_TOAST)), "in the fresh workbook the objectScript macro did not run (no toast)");
        } catch (e) {
          const rows = (await auditRows(page).catch(() => [] as AuditRow[])).filter(
            (r) => JSON.stringify(r).includes(app),
          );
          const relevant = consoleSeen.filter((l) => /script|mount|consent|refus|macro|realm|error|warn|notify|toast/i.test(l));
          throw new Error(
            `${String(e)}\n-- audit rows naming ${app}: ${describeRows(rows).slice(0, 3000)}` +
              `\n-- page console during the click (${consoleSeen.length} lines, ${relevant.length} relevant):\n${relevant.slice(-60).join("\n")}`,
          );
        } finally {
          page.off("console", onConsole);
        }
        const runs = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_run", app),
          (r) => r.some((x) => x.macroId === moduleId),
          "no application_code_run row for the module-runtime macro in the fresh workbook",
          15_000,
        );
        log(`M4-3 run rows: ${describeRows(runs)}`);
        expect(buttonOf(runs.find((x) => x.macroId === moduleId))?.cell).toBe(`${sheetName}!B2`);
        expect.soft(runs.some((x) => x.surface === "object-script"), "no application_code_run row for the one-off mount").toBe(true);

        await closeCheckoutDialog(dialog);
        dialog = null;
      });
    } finally {
      if (dialog) await closeCheckoutDialog(dialog).catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // M4-4: Include in application, the dead-link refusal, and the stale tick.
  // -------------------------------------------------------------------------
  test("M4-4: a working copy's new macro linked by a new button refuses the push until 'Include in application' is ticked after reading its code; a macro edited after the tick refuses the push as changed; re-read, it ships and the subscriber's refreshed button runs it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(780_000);
    const app = `m44-include-${RUN}`;
    const sheetName = `Inc${RUN}`;
    const shippedId = `macro-m44-a-${RUN}`;
    const shippedName = `Shipped macro ${RUN}`;
    const A_MARKER = `M44-A-${RUN}`;
    const newId = `macro-m44-n-${RUN}`;
    const newName = `New macro ${RUN}`;
    const N_MARKER = `M44-N-${RUN}`;
    const EDIT_TAG = `edited-${RUN}`;
    const pubFile = path.join(WORK, `m44-publisher-${RUN}.cala`);
    const subFile = path.join(WORK, `m44-subscriber-${RUN}.cala`);
    const key = `link-moduleScript-${newId}`;
    CREATED_APPS.push(app);
    let dialog: Locator | null = null;
    try {
      await withScriptsEnabled(page, async () => {
        // ---- 1. The publisher: v1.0.0 with one linked button, saved.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await saveModule(page, shippedId, shippedName, cellMacro(11, 9, A_MARKER));
        await createButton(page, { sheetIndex: pub, row: 1, col: 1, label: "Shipped", macroRef: shippedId });
        expect((await publishNew(page, WS, app, "1.0.0")).version, `precondition: ${app} was published`).toBe("1.0.0");
        await saveAs(page, pubFile);

        // ---- 2. The subscriber: v1.0.0, approved, its button proved, saved.
        await newFile(page);
        await subscribe(page, WS, app);
        await allowConsentFor(page, app);
        const sub = await activate(page, sheetName);
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1]]);
        await clickButtonCell(page, grid, "B2");
        await eventually(
          () => readCell(page, sub, "J12").then((c) => c.display),
          (v) => v === A_MARKER,
          "POSITIVE CONTROL: the subscriber's v1.0.0 button did not run the application's macro (J12)",
          20_000,
        );
        await saveAs(page, subFile);

        // ---- 3. The working copy gains a NEW macro and a NEW button linking it.
        await openAt(page, pubFile);
        const straggler = await answerConsentPrompts(page, "Block", 1500);
        if (straggler.length) log(`M4-4: consent screens on reopening the publisher: ${JSON.stringify(straggler)}`);
        const wc = await workingCopy(page);
        expect(wc?.packageName, "precondition: the reopened publisher workbook is the application's working copy").toBe(app);
        expect(wc?.baseVersion).toBe("1.0.0");
        const wcIdx = await activate(page, sheetName);
        await saveModule(page, newId, newName, cellMacro(13, 9, N_MARKER));
        await createButton(page, { sheetIndex: wcIdx, row: 3, col: 1, label: "New", macroRef: newId });

        // 3a. THE BACKEND'S OWN GATE, asked the way the dialog asks it.
        const target = { registryPath: WS, packageName: app };
        const preview = await callModule<{
          defaultSheetIndices?: number[];
          report: {
            unshippedMacroLinks?: Array<{ cell: string; macroId: string; remedy: string }>;
            withheld?: Array<{ kind: string; id: string; includable?: boolean; contentHash?: string }>;
            buttonCode?: { unreviewed?: Array<{ hash: string; cell: string }> } | null;
          };
        }>(page, COLLAB, "publishPreview", [undefined, false, target, "report", []]);
        const link = (preview.report.unshippedMacroLinks ?? []).find((l) => l.cell === `${sheetName}!B4`);
        expect(link?.macroId, `the preview names no unshipped link at ${sheetName}!B4: ${JSON.stringify(preview.report.unshippedMacroLinks ?? [])}`).toBe(newId);
        expect(link?.remedy).toBe("include");
        const offered = (preview.report.withheld ?? []).find((w) => w.kind === "moduleScript" && w.id === newId);
        expect(offered?.includable, "the new macro is not offered for inclusion").toBe(true);
        expect(offered?.contentHash ?? "", "the new macro carries no Rust content hash").not.toBe("");
        const acks = (preview.report.buttonCode?.unreviewed ?? []).map((u) => u.hash);
        const refusedPush = await tryModule(page, COLLAB, "publishApplication", [
          {
            registryPath: WS,
            packageName: app,
            version: "1.0.1",
            kind: "report",
            sheetIndices: preview.defaultSheetIndices ?? [],
            publishedBy: "",
            includeComments: false,
            mode: "update",
            expectedBaseVersion: "1.0.0",
            changeSummary: `e2e M4-4 ${RUN}: no inclusion`,
            acknowledgedButtonCode: acks,
            includeInApplication: [],
          },
        ]);
        expect(refusedPush.ok, "a push whose new button runs a macro it does not publish was ACCEPTED").toBe(false);
        expect(refusedPush.error, "the refusal is not the dead-link gate").toContain("CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED");
        expect(refusedPush.error, "the refusal does not name the button").toContain(`${sheetName}!B4`);
        expect(fs.existsSync(path.join(WS, app, "1.0.1")), "the refused push wrote a version").toBe(false);
        expect
          .soft(rowsOf(await auditRows(page), "button_code_refused", app).some((r) => r.reason === "unshippedMacro"), "no button_code_refused (unshippedMacro) row")
          .toBe(true);

        // 3b. THE PUSH DIALOG names the button and gates the tick behind reading.
        dialog = await openPushDialog(page, app);
        const links = dialog.locator('[data-testid="unshipped-macro-links"]');
        await expect(links, "the push dialog does not list the button whose macro the push leaves out").toBeVisible({ timeout: 60_000 });
        await expect(dialog.locator(`[data-testid="unshipped-${sheetName}!B4"]`), "the unshipped row does not name the macro").toContainText(newName);
        const tick = dialog.locator(`[data-testid="include-tick-${key}"]`);
        await expect(tick, "'Include in application' can be ticked before the code was shown").toBeDisabled();
        await dialog.locator("textarea").first().fill(`e2e M4-4 ${RUN}: include ${newName}`);
        if (acks.length > 0) {
          await expect(dialog.locator('[data-testid="push-button-code-unreviewed"]'), "the new button's code is not offered for review").toBeVisible({
            timeout: 30_000,
          });
          await acknowledgeButtonCode(dialog);
        }
        await dialog.locator(`[data-testid="include-show-${key}"]`).click();
        await expect(dialog.locator(`[data-testid="include-code-${key}"]`), "Show code does not show the macro's code").toContainText(N_MARKER);
        await expect(tick, "the tick stays disabled after the code was shown").toBeEnabled();
        await tick.click();
        const added = dialog.locator('[data-testid="push-added-notice"]');
        await expect(added, "the push dialog does not say what it adds").toBeVisible({ timeout: 30_000 });
        await expect(added).toContainText(newName);
        await expect(links, "the button is still listed as unshipped after the include").toHaveCount(0, { timeout: 30_000 });
        await waitPushReady(dialog, "after the first include");

        // 3c. VARIANT: the macro changes after it was ticked.
        await saveModule(page, newId, newName, `// ${EDIT_TAG}\n${cellMacro(13, 9, N_MARKER)}`);
        await pushButton(dialog).click();
        const changedSaid = await eventually(
          () => dialog!.innerText(),
          (t) => /cannot be published as you reviewed them/.test(t) || /Pushed .* v1\.0\.1/.test(t),
          "the push of a macro edited after its tick was neither refused nor pushed",
          90_000,
        );
        expect(changedSaid, "the push shipped code nobody read after it changed (CALP_PUSH_INCLUDED_CHANGED)").toMatch(/cannot be published as you reviewed them/);
        expect(fs.existsSync(path.join(WS, app, "1.0.1")), "the refused push wrote a version").toBe(false);
        expect
          .soft(rowsOf(await auditRows(page), "button_code_refused", app).some((r) => r.reason === "includedChanged"), "no button_code_refused (includedChanged) row")
          .toBe(true);
        await expect(dialog.locator(`[data-testid="include-stale-${key}"]`), "the changed macro is not marked as changed since it was read").toBeVisible({
          timeout: 30_000,
        });
        await dialog.locator(`[data-testid="include-show-${key}"]`).click();
        await expect(dialog.locator(`[data-testid="include-code-${key}"]`), "Show code does not show the EDITED code").toContainText(EDIT_TAG);
        await dialog.locator(`[data-testid="include-tick-${key}"]`).click();
        await expect(added, "the re-read macro is not added").toBeVisible({ timeout: 30_000 });
        await waitPushReady(dialog, "after the re-read include");

        // 3d. The push ships it.
        await pushButton(dialog).click();
        await eventually(
          () => dialog!.innerText(),
          (t) => new RegExp(`Pushed ${escapeRe(app)} v1\\.0\\.1`).test(t),
          "the push with the re-read inclusion did not succeed",
          120_000,
        );
        await expect(dialog.locator('[data-testid="added-to-application"]').first(), "the push report does not name what was added").toContainText(newName);
        await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
        dialog = null;
        const v101 = versionManifest(app, "1.0.1");
        expect((v101.moduleScripts ?? []).map((m) => m.id), "v1.0.1 does not list the included macro").toContain(newId);
        const shipped = publishedArtifact(app, "1.0.1", `modules/${newId}.json`);
        expect(shipped.text, "v1.0.1 ships a DIFFERENT text than the one re-read and ticked").toContain(EDIT_TAG);

        // ---- 4. The subscriber refreshes, re-approves, and the new button runs.
        await openAt(page, subFile);
        const onOpen = await answerConsentPrompts(page, "Block", 2500);
        if (onOpen.length) log(`M4-4: consent screens on reopening the subscriber: ${JSON.stringify(onOpen)}`);
        const pv = await refreshPreview(page);
        const offer = pv.subscriptionPreviews.find((p) => p.packageName === app);
        expect(offer?.newVersion, "the subscriber is not offered v1.0.1").toBe("1.0.1");
        const applied = (await refreshApply(page, pv)) as { subscriptionsRefreshed: number; buttonLinksRemoved?: string[] };
        expect(applied.buttonLinksRemoved ?? [], "the refresh removed the new button's link although it brought the macro").toEqual([]);
        await allowConsentFor(page, app);
        const subIdx = await activate(page, sheetName);
        const b4 = await controlAt(page, subIdx, 3, 1);
        expect(b4?.heldMacroRef?.value, "the refreshed new button does not hold its link").toBe(newId);
        expect(heldStamp(b4)?.version, "the refreshed link is not stamped with v1.0.1").toBe("1.0.1");
        expect((await readCell(page, subIdx, "J14")).display, "precondition: J14 is empty before the click").toBe("");
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1], [3, 1]]);
        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, "B4");
        await eventually(
          () => readCell(page, subIdx, "J14").then((c) => c.display),
          (v) => v === N_MARKER,
          `the subscriber's refreshed new button did not run the included macro (J14); toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );
      });
    } finally {
      if (dialog) {
        await (dialog as Locator)
          .getByRole("button", { name: /^(Close|Cancel)$/ })
          .last()
          .click()
          .catch(() => undefined);
      }
      await page.keyboard.press("Escape").catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // M4-5: the developer anchor refuses a planted root; Forget, NO then YES.
  // -------------------------------------------------------------------------
  test("M4-5: the creator remembered at publish is matched on checkout; a planted Mallory root with a re-signed head is refused naming both fingerprints; Forget answered NO forgets nothing, answered YES forgets, audits and trusts Mallory on first use", async ({
    appPage: page,
  }) => {
    test.setTimeout(480_000);
    const app = `m45-anchor-${RUN}`;
    const sheetName = `Anch${RUN}`;
    const mallory = newSigner(`mallory-m45-${RUN}`);
    CREATED_APPS.push(app);
    let dialog: Locator | null = null;
    try {
      drainNativeDialogs([FORGET_TITLE]);

      // ---- The publisher (this computer's key): 1.0.0, then 1.1.0.
      await newFile(page);
      await renameSheetByName(page, "Sheet1", sheetName);
      const pub = await sheetIndex(page, sheetName);
      await setCells(page, pub, [["A1", "v1"]]);
      expect((await publishNew(page, WS, app, "1.0.0")).version).toBe("1.0.0");
      await setCells(page, pub, [["A1", "v2"]]);
      expect((await push(page, WS, app, "1.1.0")).version).toBe("1.1.0");
      const root = versionManifest(app, "1.0.0").publisherKey;
      const rootFp = fingerprint(root);
      expect(mallory.key).not.toBe(root);
      const afterPublish = await developerAnchors(page);
      expect(afterPublish.error, "the developer-anchor store cannot be read").toBe("");
      const published = anchorOf(afterPublish.anchors, app);
      log(`M4-5: after the publish this computer remembers: ${JSON.stringify(published ?? null)}`);
      expect.soft(published?.anchoredBy, "the publish did not record the creator").toBe("publish");

      // ---- 1. The first checkout: the remembered creator MATCHES.
      await newFile(page);
      dialog = await openCheckoutDialog(page);
      await chooseApplication(page, dialog, WS, app);
      await clickOpenForEditing(dialog);
      await waitForCheckoutResult(dialog);
      const firstLine = (await dialog.locator('[data-testid="checkout-anchor-line"]').innerText()).trim();
      log(`M4-5: first checkout's anchor line: ${firstLine}`);
      test.info().annotations.push({ type: "M4-5 first checkout anchor line", description: ascii(firstLine) });
      expect.soft(firstLine, "the first checkout does not match the creator recorded at publish").toMatch(/^Matches the creator this computer first saw on/);
      expect.soft(firstLine).toContain("when it was published or pushed from here");
      const remembered = anchorOf((await developerAnchors(page)).anchors, app);
      expect(remembered?.rootFingerprint, "this computer does not remember its own key as the creator").toBe(rootFp);
      await closeCheckoutDialog(dialog);
      dialog = null;

      // ---- 2. PLANT: a Mallory-signed 0.0.1 root, and the head re-signed by Mallory.
      plantFirstVersion(app, "1.0.0", "0.0.1", mallory);
      resignVersionAs(app, "1.1.0", mallory);

      // ---- 3. Open for Editing is refused as a CONTRADICTION.
      await newFile(page);
      const before = { names: await sheetNames(page), dirty: await isDirty(page) };
      dialog = await openCheckoutDialog(page);
      await chooseApplication(page, dialog, WS, app);
      await pickVersion(dialog, "1.1.0");
      await clickOpenForEditing(dialog);
      const refused = await checkoutOutcome(dialog, /CALP_|not an authorised publisher|cannot be established/i);
      expect(refused.kind, `the planted root was not refused as a contradiction; the dialog says: ${ascii(refused.text).slice(0, 1200)}`).toBe("anchorRemedy");
      const remedy = dialog.locator('[data-testid="checkout-anchor-remedy"]');
      expect((await remedy.locator('[data-testid="anchor-remembered-fingerprint"]').innerText()).trim(), "the remedy does not name the remembered creator").toBe(rootFp);
      expect((await remedy.locator('[data-testid="anchor-claimed-fingerprint"]').innerText()).trim(), "the remedy does not name the claimed creator").toBe(
        mallory.fingerprint,
      );
      expect(await dialog.locator('[data-testid="checkout-result"]').count(), "a refused checkout showed a result").toBe(0);
      expect(await sheetNames(page), "a refused checkout added sheets").toEqual(before.names);
      expect(await isDirty(page), "a refused checkout dirtied the document").toBe(before.dirty);
      expect(await workingCopy(page), "a refused checkout made the workbook a working copy").toBeNull();
      expect
        .soft(rowsOf(await auditRows(page), "signer_refused", app).some((r) => r.reason === "anchorContradicted"), "no signer_refused (anchorContradicted) row")
        .toBe(true);

      // ---- 4. Forget, answered NO: nothing forgotten.
      const forget = dialog.locator('[data-testid="checkout-forget-anchor"]');
      await forget.click();
      const no = answerNativeDialog(FORGET_TITLE, "cancel");
      log(`M4-5 Forget (NO): ${no.clicked}`);
      expect(no.clicked, "the Forget question never appeared or was not answered").toMatch(/^CLICKED:/);
      expect.soft(no.text, "the Forget question does not name the remembered key").toContain(rootFp);
      expect.soft(no.text, "the Forget question does not name the claimed key").toContain(mallory.fingerprint);
      await page.waitForTimeout(1500);
      const afterNo = anchorOf((await developerAnchors(page)).anchors, app);
      expect(afterNo?.rootFingerprint, "answering NO forgot the remembered creator").toBe(rootFp);
      await expect(remedy, "answering NO dropped the refusal").toBeVisible();
      expect(await dialog.locator('[data-testid="checkout-result"]').count(), "answering NO opened the planted version").toBe(0);
      expect(rowsOf(await auditRows(page), "developer_anchor_forgotten", app), "answering NO left a 'forgotten' audit row").toEqual([]);
      const panelRows = await codeInThisFileAnchorRows(page);
      expect(
        panelRows.some((r) => r.includes(app) && r.includes(rootFp)),
        `Code in This File does not show the remembered creator after NO: ${ascii(JSON.stringify(panelRows)).slice(0, 800)}`,
      ).toBe(true);

      // ---- 5. Forget, answered YES: forgotten, audited, and the retry trusts Mallory on first use.
      await forget.click();
      const yes = answerNativeDialog(FORGET_TITLE, "ok");
      log(`M4-5 Forget (YES): ${yes.clicked}`);
      expect(yes.clicked, "the Forget question never appeared the second time or was not answered").toMatch(/^CLICKED:/);
      await waitForCheckoutResult(dialog);
      expect((await dialog.locator('[data-testid="checkout-signer-fingerprint"]').innerText()).trim(), "the retry did not open Mallory's head").toBe(mallory.fingerprint);
      expect(await dialog.locator('[data-testid="checkout-signer-yours"]').count(), "Mallory's key is shown as this computer's").toBe(0);
      const retryLine = (await dialog.locator('[data-testid="checkout-anchor-line"]').innerText()).trim();
      expect(retryLine, "the retry does not say it recorded the new creator on first contact").toContain(
        `First time on this computer: the creator key (${mallory.fingerprint})`,
      );
      const now = anchorOf((await developerAnchors(page)).anchors, app);
      expect(now?.rootFingerprint, "after Forget + retry this computer does not remember Mallory").toBe(mallory.fingerprint);
      expect(now?.anchoredBy).toBe("checkout");
      expect(now?.rootVersion).toBe("0.0.1");
      const forgotten = rowsOf(await auditRows(page), "developer_anchor_forgotten", app);
      expect(forgotten.length, "the Forget left no developer_anchor_forgotten row").toBeGreaterThanOrEqual(1);
      expect(forgotten[forgotten.length - 1].rootFingerprint, "the forgotten row does not name the forgotten creator").toBe(rootFp);
      await closeCheckoutDialog(dialog);
      dialog = null;
    } finally {
      if (dialog) await closeCheckoutDialog(dialog).catch(() => undefined);
      answerNativeDialogRaw(FORGET_TITLE, "cancel", 1200);
      await callModule(page, API, "closePanel", [CODE_IN_FILE_PANEL]).catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // M4-6: BUG-0266 -- a checkout refused by the signer check records no anchor.
  // -------------------------------------------------------------------------
  test("M4-6 (BUG-0266): with no anchor remembered, a planted Mallory ROOT alone is refused by the signer check and records NO developer anchor; with the genuine listing back the checkout records THIS profile as creator on first contact", async ({
    appPage: page,
  }) => {
    test.setTimeout(360_000);
    const app = `m46-refused-${RUN}`;
    const sheetName = `Plant${RUN}`;
    const mallory = newSigner(`mallory-m46-${RUN}`);
    CREATED_APPS.push(app);
    let dialog: Locator | null = null;
    try {
      // ---- The publisher (this computer's key): 1.0.0 -- the publish records the creator.
      await newFile(page);
      await renameSheetByName(page, "Sheet1", sheetName);
      await setCells(page, await sheetIndex(page, sheetName), [["A1", "genuine"]]);
      expect((await publishNew(page, WS, app, "1.0.0")).version).toBe("1.0.0");
      const root = versionManifest(app, "1.0.0").publisherKey;
      const rootFp = fingerprint(root);
      log(`M4-6: after the publish this computer remembers: ${JSON.stringify(anchorOf((await developerAnchors(page)).anchors, app) ?? null)}`);

      // ---- Forget it, so the next contact is a FIRST contact.
      const forgot = await callModule<{ forgotten: number }>(page, COLLAB, "forgetDeveloperAnchor", [WS, app]);
      log(`M4-6: forgot ${forgot.forgotten} anchor(s) of ${app}`);
      const cleared = await developerAnchors(page);
      expect(cleared.error, "the developer-anchor store cannot be read").toBe("");
      expect(anchorOf(cleared.anchors, app), "precondition: this computer still remembers the creator after Forget").toBeUndefined();

      // ---- PLANT the ROOT ONLY: the head stays this computer's.
      const plant = plantFirstVersion(app, "1.0.0", "0.0.1", mallory);
      expect(versionManifest(app, "1.0.0").publisherKey, "precondition: the head is still signed by this computer").toBe(root);

      // ---- Open for Editing: refused by the SIGNER check, not the anchor.
      await newFile(page);
      const before = { names: await sheetNames(page), dirty: await isDirty(page) };
      dialog = await openCheckoutDialog(page);
      await chooseApplication(page, dialog, WS, app);
      await pickVersion(dialog, "1.0.0");
      await clickOpenForEditing(dialog);
      const refused = await checkoutOutcome(dialog, /not an authorised publisher|CALP_|cannot be established/i);
      log(`M4-6: the refusal: ${refused.kind}: ${refused.text.slice(0, 400)}`);
      expect(refused.kind, `the planted root was not refused by the signer check; the dialog says: ${ascii(refused.text).slice(0, 1200)}`).toBe("error");
      expect(refused.text, "the refusal is not the signer check").toMatch(/not an authorised publisher/i);
      expect(refused.text, "the refusal came from the ANCHOR, which remembers nothing here").not.toContain("CALP_ANCHOR_CONTRADICTED");
      expect(await dialog.locator('[data-testid="checkout-anchor-remedy"]').count(), "a signer refusal offered the anchor remedy").toBe(0);
      expect(await dialog.locator('[data-testid="checkout-result"]').count(), "a refused checkout showed a result").toBe(0);
      expect(await sheetNames(page), "a refused checkout added sheets").toEqual(before.names);
      expect(await isDirty(page), "a refused checkout dirtied the document").toBe(before.dirty);
      expect(await workingCopy(page), "a refused checkout made the workbook a working copy").toBeNull();
      expect
        .soft(rowsOf(await auditRows(page), "signer_refused", app).some((r) => r.reason === "signerNotAuthorized"), "no signer_refused (signerNotAuthorized) row")
        .toBe(true);

      // ---- THE BUG-0266 PROOF: the refused checkout remembered NOBODY.
      const afterRefusal = await developerAnchors(page);
      expect(afterRefusal.error, "the developer-anchor store cannot be read").toBe("");
      expect(
        anchorOf(afterRefusal.anchors, app),
        `BUG-0266: a checkout the signer check REFUSED recorded a developer anchor: ${JSON.stringify(anchorOf(afterRefusal.anchors, app) ?? null)}`,
      ).toBeUndefined();
      const panelRows = await codeInThisFileAnchorRows(page);
      expect.soft(
        panelRows.filter((r) => r.includes(app)),
        "BUG-0266: Code in This File lists a creator for the refused application",
      ).toEqual([]);

      // ---- The genuine listing written back: the checkout succeeds, FIRST contact, THIS profile.
      fs.writeFileSync(plant.listingPath, plant.listingBackup);
      await chooseApplication(page, dialog, WS, app);
      expect(await dialog.locator("label").filter({ hasText: "v0.0.1" }).count(), "precondition: the planted version is no longer listed").toBe(0);
      await pickVersion(dialog, "1.0.0");
      await clickOpenForEditing(dialog);
      const opened = await checkoutOutcome(dialog, /not an authorised publisher|CALP_|cannot be established/i);
      expect(opened.kind, `the genuine application did not open once the plant was gone; the dialog says: ${ascii(opened.text).slice(0, 1200)}`).toBe("result");
      expect((await dialog.locator('[data-testid="checkout-signer-fingerprint"]').innerText()).trim()).toBe(rootFp);
      await expect(dialog.locator('[data-testid="checkout-signer-yours"]'), "the root key is this computer's").toBeVisible();
      const line = (await dialog.locator('[data-testid="checkout-anchor-line"]').innerText()).trim();
      expect(line, "the genuine checkout is not a FIRST contact recording this computer's key").toContain(
        `First time on this computer: the creator key (${rootFp})`,
      );
      const recorded = anchorOf((await developerAnchors(page)).anchors, app);
      expect(recorded?.rootFingerprint, "the genuine checkout did not record THIS profile as the creator").toBe(rootFp);
      expect(recorded?.anchoredBy).toBe("checkout");
      expect(recorded?.rootVersion).toBe("1.0.0");
      await closeCheckoutDialog(dialog);
      dialog = null;
    } finally {
      if (dialog) await closeCheckoutDialog(dialog).catch(() => undefined);
      await callModule(page, API, "closePanel", [CODE_IN_FILE_PANEL]).catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // M4-7: owner decision B -- YOUR run of an application's recorded macro.
  // -------------------------------------------------------------------------
  test("M4-7 (owner B): an application's RECORDED object-script macro writes its cell when you run it from Developer > Macros > Run, click its button control or button cell, or type `run` at the command line, after Allow; the same macro started by a script -- one-off or a STANDING restricted one -- writes nothing; the application's MODULE macro runs from the command line and a script's runMacro of it is refused and recorded; a recording that also formats is refused before it runs; a recording that throws after two writes is taken back whole", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(780_000);
    const app = `m47-ownerb-${RUN}`;
    const sheetName = `OwnerB${RUN}`;
    const cellsId = `macro-m47-cells-${RUN}`;
    const cellsName = `Owner B cells ${RUN}`;
    const formatsId = `macro-m47-formats-${RUN}`;
    const formatsName = `Owner B formats ${RUN}`;
    const probeId = `m47-standing-probe-${RUN}`;
    const MARKER = `M47-OWNER-B-${RUN}`;
    const NO_API = `M47-NO-API-${RUN}`;
    const PROBED = `M47-STANDING-PROBED-${RUN}`;
    const PROBE_HAS_API = `M47-STANDING-HAS-API-${RUN}`;
    const REF = "K7";
    const ROW = 6;
    const COL = 10;
    // The application's MODULE-runtime macro (owner B, F10): it writes L7.
    const moduleId = `macro-m47-module-${RUN}`;
    const moduleName = `Owner B module ${RUN}`;
    const MODULE_MARKER = `M47-MODULE-${RUN}`;
    const MODULE_REF = "L7";
    // A recording of TWO cells that throws before its commit (owner B, F9):
    // a run with cell access that stops part-way is taken back whole.
    const throwsId = `macro-m47-throws-${RUN}`;
    const throwsName = `Owner B throws ${RUN}`;
    const THROWS_MARKER = `M47-THROWS-${RUN}`;
    const THROWS_ERROR = `M47 stopped on purpose after two writes ${RUN}`;
    const THROWS_ROW = 8;
    const THROWS_REF = "K9";
    const THROWS_REF2 = "K10";
    // The application's three buttons on its sheet: a floating button control
    // LINKING the recording (B2), a button CELL running it (D2), and a probe
    // button (F2) whose STANDING restricted object script tries to start it.
    const LINKED = { ref: "B2", row: 1, col: 1, caption: `Owner B link ${RUN}` };
    const CELL = { ref: "D2", row: 1, col: 3, caption: `Owner B cell ${RUN}` };
    const PROBE = { ref: "F2", row: 1, col: 5, caption: `Owner B probe ${RUN}` };
    CREATED_APPS.push(app);
    try {
      await withScriptsEnabled(page, async () => {
        // ---- The publisher: two RECORDED object-script macros.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await setCells(page, pub, [["A1", "owner B"]]);
        const cellsSource = await recordedCellMacro(page, cellsName, pub, ROW, COL, MARKER);
        expect(cellsSource, "the recording is not the scaffold that needs context.api").toContain("if (!context.api) {");
        expect(cellsSource, "the recording's scaffold does not throw without cell access (F12)").toContain(
          "needs cell access, and this run has none",
        );
        // The same recording, plus one formatting call -- outside cell access.
        const formatsSource = cellsSource.replace(
          /(await api\.(?:setCellValue|updateCellsBatch)\([^\n]*\n)/,
          `$1    await api.setRangeFormat(${ROW}, ${COL}, ${ROW}, ${COL}, { bold: true });\n`,
        );
        expect(formatsSource, "precondition: the formatting variant differs from the recording").not.toBe(cellsSource);
        await saveModule(page, cellsId, cellsName, cellsSource, OBJECT_MACRO_DESC);
        await saveModule(page, formatsId, formatsName, formatsSource, OBJECT_MACRO_DESC);
        // ...and a recording that writes K9, then K10, then THROWS before its
        // commit (owner B, follow-up F9).
        const throwsFirst = await recordedCellMacro(page, throwsName, pub, THROWS_ROW, COL, THROWS_MARKER);
        const throwsSource = throwsFirst.replace(
          "await api.commitBatch();",
          `await api.setCellValue(${THROWS_ROW + 1}, ${COL}, ${JSON.stringify(THROWS_MARKER)});\n` +
            `    throw new Error(${JSON.stringify(THROWS_ERROR)});\n` +
            "    await api.commitBatch();",
        );
        expect(throwsSource, "precondition: the throwing variant differs from the recording").not.toBe(throwsFirst);
        await saveModule(page, throwsId, throwsName, throwsSource, OBJECT_MACRO_DESC);
        // ...and a MODULE-runtime macro of the same application (no runtime marker).
        await saveModule(page, moduleId, moduleName, cellMacro(ROW, COL + 1, MODULE_MARKER));

        // The application's buttons for the recording (owner decision B,
        // follow-ups F1 + F6), and the probe with its standing script.
        await ensureRunMode(page);
        await createButton(page, { sheetIndex: pub, row: LINKED.row, col: LINKED.col, label: LINKED.caption, macroRef: cellsId });
        await callModule(page, CELL_TYPES, "setCellType", [
          CELL.row,
          CELL.col,
          "calcula.button",
          { label: CELL.caption, action: { kind: "script", scriptId: cellsId } },
        ]);
        const probe = await createButton(page, { sheetIndex: pub, row: PROBE.row, col: PROBE.col, label: PROBE.caption });
        await invoke(page, "save_object_script", {
          script: {
            id: probeId,
            name: `Owner B standing probe ${RUN}`,
            objectType: "button",
            instanceId: probe.instanceId,
            source: standingRunMacroProbe(cellsId, PROBED, PROBE_HAS_API),
            accessLevel: "restricted",
            description: null,
            provenance: null,
            packageName: null,
            packageVersion: null,
          },
        });

        // POSITIVE CONTROL for each button: as the publisher's OWN code the
        // recording writes its cell from the linked control AND from the button
        // cell (F6: the door hands a button cell's object-script macro to the
        // macro seam; it used to refuse it) -- so an empty cell below is the
        // decision, not a broken button.
        await revealControls(page, sheetName, [[LINKED.row, LINKED.col]]);
        await clickButtonCell(page, grid, LINKED.ref);
        await eventually(
          () => sheetsShowing(page, REF, MARKER),
          (s) => s.length === 1,
          "POSITIVE CONTROL: the publisher's own button control linking the recording wrote nothing",
          20_000,
        );
        await clearMarker(page, REF, MARKER);
        await revisit(page, sheetName);
        await callModule(page, CELL_TYPES, "refreshCellTypeAssignments");
        await grid.clickCell(CELL.ref);
        await eventually(
          () => sheetsShowing(page, REF, MARKER),
          (s) => s.length === 1,
          "POSITIVE CONTROL: the publisher's own button CELL running the recording wrote nothing (F6)",
          20_000,
        );
        await clearMarker(page, REF, MARKER);

        // POSITIVE CONTROL: as the publisher's OWN code the recording writes its
        // cell -- so a cell left empty below is the decision, not a broken macro.
        let library = await openMacrosDialog(page, grid);
        await selectInMacrosDialog(library, cellsName);
        const own = await pressRunInMacrosDialog(library, cellsName);
        await closeMacrosDialog(page);
        expect(own.error, "POSITIVE CONTROL: the recorded macro failed as the publisher's own code").toBe("");
        await eventually(
          () => sheetsShowing(page, REF, MARKER),
          (s) => s.length === 1,
          "POSITIVE CONTROL: the publisher's own run of the recording wrote nothing",
          20_000,
        );
        await clearMarker(page, REF, MARKER);
        expect((await publishNew(page, WS, app, "1.0.0")).version, `precondition: ${app} was published`).toBe("1.0.0");

        // ---- The subscriber: pull, then Allow the application's code.
        await newFile(page);
        await subscribe(page, WS, app);
        const theirs = await storedScript(page, cellsId);
        expect(theirs.sourcePackage, "precondition: the subscriber's macro is the application's (stamped)").toBe(app);
        expect((await storedScript(page, moduleId)).sourcePackage, "precondition: the module macro is the application's").toBe(app);
        expect(theirs.source, "precondition: the subscriber holds the recording byte for byte").toBe(cellsSource);
        const sub = await sheetIndex(page, sheetName);
        const linked = await controlAt(page, sub, LINKED.row, LINKED.col);
        expect(linked?.heldMacroRef?.value, "precondition: the button control's link to the recording arrived HELD").toBe(cellsId);
        expect(heldStamp(linked)?.application, "precondition: the held link is stamped with its application").toBe(app);
        const cellButton = (await cellTypesOn(page, sub)).find((c) => c.row === CELL.row && c.col === CELL.col);
        expect(cellButton?.params?.action, "precondition: the button cell kept its action naming the application's macro").toEqual({
          kind: "script",
          scriptId: cellsId,
        });
        const stampedCell = cellButton?.params?.fromApplication as { application?: string } | undefined;
        expect(stampedCell?.application, "precondition: the button cell is stamped with its application").toBe(app);
        const pulledScripts = await invoke<Array<{ id: string; packageName?: string | null }>>(page, "list_object_scripts");
        expect(
          pulledScripts.some((s) => s.id === probeId),
          "precondition: the application's standing probe script did not travel",
        ).toBe(true);
        // F4: the approval screen says what an application's macro WRITTEN AS AN
        // OBJECT SCRIPT may do when YOU run it -- and that a part-way run is undone.
        const consent = await consentPromptFor(page, app);
        const objectScriptReach = consent.locator("[data-consent-object-script-macros]");
        await expect(
          objectScriptReach,
          "the approval screen does not say what a macro written as an object script may do when you run it (F4)",
        ).toContainText(/may also read and change the cells of any sheet/);
        await expect(objectScriptReach).toContainText(/every change it made is undone/);
        await allowConsentFor(page, app);
        expect(await sheetsShowing(page, REF, MARKER), "precondition: no sheet shows the marker before any run").toEqual([]);

        // ---- 1. YOU run it: Developer > Macros > Run writes the cell.
        const runRowsBefore = rowsOf(await auditRows(page), "application_code_run", app).filter((r) => r.macroId === cellsId).length;
        await dismissToasts(page);
        await startToastLog(page);
        library = await openMacrosDialog(page, grid);
        await selectInMacrosDialog(library, cellsName);
        await expect(
          library.locator("[data-macro-provenance]"),
          "the Macros dialog does not say what running an application's macro here allows",
        ).toContainText(/read and\s+change cells on any sheet/);
        const yours = await pressRunInMacrosDialog(library, cellsName);
        await closeMacrosDialog(page);
        expect(yours.error, `owner B: your run of the approved application's recorded macro failed`).toBe("");
        const marked = await eventually(
          () => sheetsShowing(page, REF, MARKER),
          (s) => s.length === 1,
          `owner B: your run of the approved application's recorded macro wrote nothing; toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );
        expect(
          (await toastTextsLogged(page)).filter((t) => /needs cell access/.test(t)),
          "your run was mounted without cell access (the recording bailed out)",
        ).toEqual([]);
        const runs = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_run", app).filter((r) => r.macroId === cellsId),
          (r) => r.length > runRowsBefore,
          "no application_code_run row names the macro you ran",
          15_000,
        );
        expect.soft(runs[runs.length - 1].surface, `the run row: ${describeRows(runs.slice(-1))}`).toBe("object-script");
        expect(runs[runs.length - 1].description, "the run row names neither the macro nor the application").toContain(
          `'${cellsId}' from the application '${app}'`,
        );
        // F3: Rust co-decided the grant and NAMED it on the always-on run row.
        const yoursRow = runs[runs.length - 1];
        expect(yoursRow.cellAccess, `the run row does not say your run had cell access: ${ascii(JSON.stringify(yoursRow))}`).toBe(
          true,
        );
        expect.soft(yoursRow.door, "the run row does not name Developer > Macros > Run").toBe("macrosDialog");
        expect.soft(yoursRow.startedBy, "the run row does not say you started it").toBe("you");
        expect(typeof yoursRow.grantId, "the run row names no grant").toBe("number");
        // F15: what the run wrote is on the persistent trail -- one row per
        // sheet, the module runtime's shape, against that grant.
        const yourWrites = await eventually(
          async () =>
            rowsOf(await auditRows(page), "script_executed", app).filter(
              (r) => r.surfaceId === cellsId && r.grantId === yoursRow.grantId,
            ),
          (r) => r.length > 0,
          "no script_executed row says which cells your run of the recording changed (F15)",
          15_000,
        );
        expect(yourWrites, `the write rows: ${ascii(JSON.stringify(yourWrites))}`).toHaveLength(1);
        expect(yourWrites[0]).toMatchObject({
          surface: "object-script",
          door: "macrosDialog",
          cellsModified: 1,
          firstRow: ROW,
          lastRow: ROW,
          firstCol: COL,
          lastCol: COL,
        });
        // The sheet the marker landed on (the recording addresses sheets by index).
        const markedSheet = (await sheets(page)).sheets.find((x) => x.name === (marked[0] ?? ""))?.index;
        expect.soft(yourWrites[0].sheet, "the write row names another sheet than the one the run wrote").toBe(markedSheet);
        await clearMarker(page, REF, MARKER);
        expect(await sheetsShowing(page, REF, MARKER), "precondition: the marker was cleared").toEqual([]);

        // ---- 1b. YOU click its BUTTON CONTROL (follow-up F1): the release
        // inside the button mints the pass; the held link runs the recording
        // with cell access, and the run row names the button.
        const runsBeforeLink = rowsOf(await auditRows(page), "application_code_run", app).filter((r) => r.macroId === cellsId).length;
        await activate(page, sheetName);
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[LINKED.row, LINKED.col], [PROBE.row, PROBE.col]]);
        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, LINKED.ref);
        await eventually(
          () => sheetsShowing(page, REF, MARKER),
          (s) => s.length === 1,
          `owner B: your click on the application's button control wrote nothing; toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );
        expect(
          (await toastTextsLogged(page)).filter((t) => /needs cell access/.test(t)),
          "your click ran the recording without cell access (it bailed out)",
        ).toEqual([]);
        const linkRuns = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_run", app).filter((r) => r.macroId === cellsId),
          (r) => r.length > runsBeforeLink,
          "no application_code_run row for your click on the button control",
          15_000,
        );
        const linkRun = linkRuns[linkRuns.length - 1];
        expect(buttonOf(linkRun)?.cell, `the run row does not name the button control: ${describeRows([linkRun])}`).toBe(
          `${sheetName}!${LINKED.ref}`,
        );
        expect.soft(buttonOf(linkRun)?.kind, "the run row's button is not a control").toBe("control");
        expect.soft(buttonOf(linkRun)?.held, "the run row does not say the link is the application's").toBe(true);
        expect.soft(linkRun.surface, "the recording ran through another door").toBe("object-script");
        expect.soft(linkRun.cellAccess, "the button's run row does not say it had cell access (F3)").toBe(true);
        expect.soft(linkRun.door, "the button's run row does not name its button as the door (F3)").toBe("button");
        await clearMarker(page, REF, MARKER);
        expect(await sheetsShowing(page, REF, MARKER), "precondition: the marker was cleared").toEqual([]);

        // ---- 1c. YOU click its BUTTON CELL (follow-up F6): the Rust door
        // answers `macro`, the page runs the recording through the macro seam
        // with the cell as its trigger and the click's pass.
        const runsBeforeCell = rowsOf(await auditRows(page), "application_code_run", app).filter((r) => r.macroId === cellsId).length;
        await revisit(page, sheetName);
        await callModule(page, CELL_TYPES, "refreshCellTypeAssignments");
        await ensureRunMode(page);
        await dismissToasts(page);
        await startToastLog(page);
        await grid.clickCell(CELL.ref);
        await eventually(
          () => sheetsShowing(page, REF, MARKER),
          (s) => s.length === 1,
          `owner B (F6): your click on the application's button CELL wrote nothing; toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );
        expect(
          (await toastTextsLogged(page)).filter((t) => /needs cell access|cannot run it|runs as an object script/.test(t)),
          "the button cell refused the recording, or ran it without cell access",
        ).toEqual([]);
        const cellRuns = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_run", app).filter((r) => r.macroId === cellsId),
          (r) => r.length > runsBeforeCell,
          "no application_code_run row for your click on the button cell",
          15_000,
        );
        const cellRun = cellRuns[cellRuns.length - 1];
        expect(buttonOf(cellRun)?.cell, `the run row does not name the button cell: ${describeRows([cellRun])}`).toBe(
          `${sheetName}!${CELL.ref}`,
        );
        expect.soft(buttonOf(cellRun)?.kind, "the run row's button is not a cell").toBe("cell");
        expect.soft(buttonOf(cellRun)?.application, "the run row's button cell is not the application's").toBe(app);
        expect.soft(cellRun.door, "the button cell's run row does not name the button door (F3)").toBe("button");
        await clearMarker(page, REF, MARKER);
        expect(await sheetsShowing(page, REF, MARKER), "precondition: the marker was cleared").toEqual([]);

        // ---- 1d. YOU type `run` at the COMMAND LINE (follow-up F2): the typed
        // line mints the pass after it resolved the macro and printed whose
        // code it is. The recording writes K7 (cell access); the application's
        // MODULE macro writes L7 (the module runtime, which a script could not
        // start -- step 2d). Neither run row names a button.
        const runsBeforeCli = rowsOf(await auditRows(page), "application_code_run", app).filter(
          (r) => r.macroId === cellsId || r.macroId === moduleId,
        ).length;
        await dismissToasts(page);
        await startToastLog(page);
        const cli = await openCommandLine(page);
        try {
          const recorded = await typeAtCommandLine(page, cli, `run ${cellsId}`, /ran \(|failed:|did not run/);
          expect(
            recorded.some((l) => l.includes(`arrived in the application "${app}"`)),
            `the command line did not say whose code it was before running it: ${ascii(JSON.stringify(recorded))}`,
          ).toBe(true);
          expect(
            recorded.some((l) => /ran \(from application/.test(l)),
            `owner B (F2): your typed run of the recording did not run: ${ascii(JSON.stringify(recorded))}`,
          ).toBe(true);
          await eventually(
            () => sheetsShowing(page, REF, MARKER),
            (sh) => sh.length === 1,
            `owner B (F2): your typed run of the recording wrote nothing; toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
            20_000,
          );
          const moduleLines = await typeAtCommandLine(page, cli, `run ${moduleId}`, /ran \(|failed:|did not run/);
          expect(
            moduleLines.some((l) => /ran \(from application/.test(l)),
            `owner B (F2/F10): your typed run of the application's MODULE macro did not run: ${ascii(JSON.stringify(moduleLines))}`,
          ).toBe(true);
          await eventually(
            () => sheetsShowing(page, MODULE_REF, MODULE_MARKER),
            (sh) => sh.length === 1,
            "owner B (F10 POSITIVE CONTROL): your typed run of the module macro wrote nothing",
            20_000,
          );
        } finally {
          await closeCommandLine(page);
        }
        const cliRuns = await eventually(
          async () =>
            rowsOf(await auditRows(page), "application_code_run", app).filter(
              (r) => r.macroId === cellsId || r.macroId === moduleId,
            ),
          (r) => r.length >= runsBeforeCli + 2,
          "the command line's two runs did not each leave an application_code_run row",
          15_000,
        );
        const newCliRuns = cliRuns.slice(runsBeforeCli);
        expect(newCliRuns.map((r) => r.macroId).sort(), `the run rows: ${describeRows(newCliRuns)}`).toEqual(
          [cellsId, moduleId].sort(),
        );
        expect(newCliRuns.filter((r) => buttonOf(r) !== null), "a typed run's row names a button").toEqual([]);
        // F3: both runtimes' rows name the command line as the door; only the
        // object-script run is about cell access (the module runtime has its own reach).
        for (const r of newCliRuns) {
          expect.soft(r.door, `a typed run's row does not name the command line: ${ascii(JSON.stringify(r))}`).toBe("commandLine");
          expect.soft(r.startedBy, "a typed run's row does not say you started it").toBe("you");
        }
        expect.soft(newCliRuns.find((r) => r.macroId === cellsId)?.cellAccess, "the typed recording's row lacks cellAccess").toBe(true);
        await clearMarker(page, REF, MARKER);
        await clearMarker(page, MODULE_REF, MODULE_MARKER);
        expect(await sheetsShowing(page, REF, MARKER), "precondition: the marker was cleared").toEqual([]);
        expect(await sheetsShowing(page, MODULE_REF, MODULE_MARKER), "precondition: the module marker was cleared").toEqual([]);

        // ---- 1e. ALL OR NOTHING (owner B, follow-up F9): YOUR run of a recording
        // that writes TWO cells and then throws is taken back whole -- neither
        // cell keeps its value -- and the Macros dialog says it stopped and that
        // nothing was changed. The trail says it wrote two cells and was undone.
        await dismissToasts(page);
        library = await openMacrosDialog(page, grid);
        await selectInMacrosDialog(library, throwsName);
        const stopped = await pressRunInMacrosDialog(library, throwsName);
        await closeMacrosDialog(page);
        expect(stopped.error, `the failed run does not say it stopped: ${ascii(stopped.error)}`).toMatch(/stopped before it finished/);
        expect(stopped.error, "the failed run does not say nothing was changed").toMatch(
          /Every change it had made was undone, so nothing was changed\./,
        );
        expect(stopped.error, "the failed run does not say why it stopped").toContain(THROWS_ERROR);
        expect(await sheetsShowing(page, THROWS_REF, THROWS_MARKER), "the failed run's FIRST write was kept").toEqual([]);
        expect(await sheetsShowing(page, THROWS_REF2, THROWS_MARKER), "the failed run's SECOND write was kept").toEqual([]);
        // POSITIVE CONTROL, on the trail: the run DID write both cells -- then
        // both were taken back.
        const undoneRows = await eventually(
          async () => rowsOf(await auditRows(page), "script_executed", app).filter((r) => r.surfaceId === throwsId),
          (r) => r.length > 0,
          "no script_executed row records the failed run's two writes (F15 + F9)",
          15_000,
        );
        expect(undoneRows[0], `the write row: ${ascii(JSON.stringify(undoneRows[0]))}`).toMatchObject({
          completed: false,
          rolledBack: true,
          cellsModified: 2,
          firstRow: THROWS_ROW,
          lastRow: THROWS_ROW + 1,
        });
        expect.soft(String(undoneRows[0].description)).toContain("every change it made was undone");

        // ---- 2a. A SCRIPT starts it: the user's own unlocked one-off calls
        // context.api.runMacro on the same macro. It runs -- restricted -- and
        // its recorded scaffold THROWS for want of cell access (F12), so the
        // script's runMacro fails saying how to get it, instead of "ran".
        const before2a = await auditRows(page);
        const runRowsBefore2a = rowsOf(before2a, "application_code_run", app).filter((r) => r.macroId === cellsId).length;
        const writeRowsBefore2a = rowsOf(before2a, "script_executed", app).filter((r) => r.surfaceId === cellsId).length;
        await dismissToasts(page);
        await startToastLog(page);
        const driver = await tryModule(page, RUNNER, "runObjectScriptOnce", [
          {
            name: `Owner B driver ${RUN}`,
            source: `function setup(context) { return context.api.runMacro(${JSON.stringify(cellsId)}); }\n`,
          },
        ]);
        expect(driver.ok, "owner B: a script's runMacro of the recording reported success").toBe(false);
        expect(
          driver.error,
          "the macro a script started did not run restricted (its recorded scaffold never reported a missing context.api)",
        ).toMatch(/needs cell access/);
        await page.waitForTimeout(1500);
        expect(await sheetsShowing(page, REF, MARKER), "owner B: a run a SCRIPT started got cell access").toEqual([]);
        // F3: its run row says it ran restricted, and nobody vouched for a door;
        // F15: no write row (nothing was granted, nothing written).
        const after2a = await auditRows(page);
        const scriptRun = rowsOf(after2a, "application_code_run", app)
          .filter((r) => r.macroId === cellsId)
          .slice(runRowsBefore2a)
          .pop();
        expect(scriptRun, "the script-started run left no run row (it ran, restricted)").toBeDefined();
        expect(scriptRun?.cellAccess, `the script-started run's row: ${ascii(JSON.stringify(scriptRun))}`).toBe(false);
        expect.soft(scriptRun?.startedBy, "the script-started run's row says you started it").toBe("script");
        expect(
          rowsOf(after2a, "script_executed", app).filter((r) => r.surfaceId === cellsId).length,
          "a script-started run left a write row",
        ).toBe(writeRowsBefore2a);

        // ---- 2b. A RESTRICTED script has no context.api to start it with at all.
        await dismissToasts(page);
        await startToastLog(page);
        await callModule(page, RUNNER, "runObjectScriptOnce", [
          {
            name: `Owner B restricted driver ${RUN}`,
            accessLevel: "restricted",
            source:
              "function setup(context) {\n" +
              `  if (!context.api) { context.notify(${JSON.stringify(NO_API)}, "info"); return; }\n` +
              `  return context.api.runMacro(${JSON.stringify(cellsId)});\n` +
              "}\n",
          },
        ]);
        await waitForToast(page, new RegExp(escapeRe(NO_API)), "a RESTRICTED script was handed context.api");
        await page.waitForTimeout(1000);
        expect(await sheetsShowing(page, REF, MARKER), "owner B: a restricted script's attempt changed the cell").toEqual([]);

        // ---- 2c. A STANDING restricted script -- the application's own, on its
        // probe button, approved with everything else -- tries api.runMacro on
        // the recording when its button is clicked: through context.api (null)
        // and by posting the broker call itself. It runs (its notice), and the
        // recording does not: no cell, no run row. The click on the probe is a
        // person's, but the probe links no macro, so its pass is never minted --
        // and a standing realm is never granted one.
        await eventually(() => scriptMounted(page, probeId), (v) => v, "the application's standing probe script never mounted after Allow", 20_000);
        const runsBeforeProbe = rowsOf(await auditRows(page), "application_code_run", app).filter((r) => r.macroId === cellsId).length;
        await activate(page, sheetName);
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[PROBE.row, PROBE.col]]);
        await dismissToasts(page);
        await startToastLog(page);
        await clickButtonCell(page, grid, PROBE.ref);
        await waitForToast(page, new RegExp(escapeRe(PROBED)), "the standing probe's onClick never ran (so its attempt proves nothing)");
        await page.waitForTimeout(2000);
        expect(
          (await toastTextsLogged(page)).filter((t) => t.includes(PROBE_HAS_API)),
          "owner B: a STANDING application script was handed context.api",
        ).toEqual([]);
        expect(await sheetsShowing(page, REF, MARKER), "owner B: a STANDING restricted script started the recording with cell access").toEqual([]);
        expect(
          rowsOf(await auditRows(page), "application_code_run", app).filter((r) => r.macroId === cellsId).length,
          "owner B: a STANDING restricted script started the recording at all (a run row was written)",
        ).toBe(runsBeforeProbe);

        // ---- 2d. A SCRIPT starts the application's MODULE macro (follow-up
        // F10): the module runtime has no tiers, so the Rust gate refuses it
        // outright -- the script is told it did not run, nothing is written,
        // and an application_code_refused row says why. (Step 1d is the
        // positive control: you ran the very same macro from the command line.)
        const refusedBefore = rowsOf(await auditRows(page), "application_code_refused", app).length;
        const moduleDriver = await tryModule(page, RUNNER, "runObjectScriptOnce", [
          {
            name: `Owner B module driver ${RUN}`,
            source: `function setup(context) { return context.api.runMacro(${JSON.stringify(moduleId)}); }\n`,
          },
        ]);
        expect(moduleDriver.ok, "owner B (F10): a script started the application's MODULE macro").toBe(false);
        expect(moduleDriver.error, "the script was not told the module macro did not run").toMatch(
          /did not run: APPLICATION_MACRO_NOT_STARTED_BY_YOU/,
        );
        await page.waitForTimeout(1000);
        expect(
          await sheetsShowing(page, MODULE_REF, MODULE_MARKER),
          "owner B (F10): a run a SCRIPT started of the application's MODULE macro changed a cell",
        ).toEqual([]);
        const moduleRefusals = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_refused", app).slice(refusedBefore),
          (r) => r.some((x) => x.macroId === moduleId),
          "no application_code_refused row for the script-started module macro",
          15_000,
        );
        const moduleRefusal = moduleRefusals.find((x) => x.macroId === moduleId)!;
        expect(moduleRefusal.reason, `the refusal row: ${describeRows([moduleRefusal])}`).toBe("notStartedByYou");
        expect.soft(moduleRefusal.startedBy, "the refusal row does not say a script started it").toBe("script");
        expect.soft(moduleRefusal.surface, "the refusal came from another door").toBe("moduleRuntime");

        // ---- 3. A recording that also FORMATS is refused before it runs.
        library = await openMacrosDialog(page, grid);
        await selectInMacrosDialog(library, formatsName);
        const formats = await pressRunInMacrosDialog(library, formatsName);
        await closeMacrosDialog(page);
        expect(formats.error, "the formatting recording was not refused").toContain("api.setRangeFormat");
        expect(formats.error, "the refusal does not say nothing was changed").toContain("Nothing was changed");
        await page.waitForTimeout(1000);
        expect(await sheetsShowing(page, REF, MARKER), "a refused recording still wrote its cell (a half-run)").toEqual([]);
        expect(formats.error, "the refusal says it could not be put on the audit trail").not.toContain("could not be recorded");
        // F8: the refusal -- made before the mount gate was ever asked -- is on
        // the persistent trail, the application read from the module store.
        const outside = await eventually(
          async () =>
            rowsOf(await auditRows(page), "application_code_refused", app).filter(
              (r) => r.macroId === formatsId && r.reason === "outsideCellAccess",
            ),
          (r) => r.length > 0,
          "no application_code_refused (outsideCellAccess) row for the formatting recording (F8)",
          15_000,
        );
        expect(outside[0].methods, `the refusal row: ${ascii(JSON.stringify(outside[0]))}`).toContain("api.setRangeFormat");
        expect.soft(outside[0].surface, "the refusal row names another surface").toBe("object-script");
      });
    } finally {
      await closeMacrosDialog(page).catch(() => undefined);
      await closeCommandLine(page).catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });
});
