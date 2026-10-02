/**
 * CALP INLINE BUTTONS, LIVE -- plan_M6's own journey, written short (owner
 * question 30, 2026-10-02): the three security claims of phase 4 of BUG-0257
 * that had no live proof. Since M6 an application's STATIC inline button code
 * (`onSelect`) travels: a subscribe HOLDS it (`heldOnSelect` + `heldFrom`), the
 * approval screen shows its exact bytes (`[data-consent-button-action]`), and
 * only the Rust button door (`run_control_action`) runs it, after an approval
 * of exactly those bytes (`buttonAction:<sha256>`) sealed to THIS computer.
 *
 * WRITTEN AND TYPE-CHECKED ONLY (tsconfig.e2e.json); the main loop runs it, on
 * a freshly LINKED app (global-setup's printed binary build time later than the
 * last src-tauri edit). Expect 3 passed (M6-2, M6-3, M6-7; independent tests,
 * each with its own application, so one failing does not skip the others).
 *
 *   M6-2  THE CONFUSED DEPUTY BY NAME. The application ships the module
 *         `Report<run>` (marker A, J12) and two buttons whose inline code is a
 *         bare call: B2 `Report<run>()` and B4 `Mine<run>()`. The subscriber
 *         already owns LOCAL modules of BOTH names (B -> J14, C -> J16), saved
 *         before subscribing and under a DIFFERENT id from the application's --
 *         with the same id the pull skips the application's module (the M4-2 (i)
 *         clash) and the step would test nothing. The approval screen says B2
 *         runs the application's macro and says nothing of the kind for B4.
 *         Before Allow the click on B2 is REFUSED (notConsented, an
 *         `application_code_refused` row naming the button) and nothing runs:
 *         neither A nor the local B. After Allow B2 writes the APPLICATION's A,
 *         never B, and its run row names the application's module and the hash
 *         of the application's bytes. B4, which no module of the application
 *         answers, runs its held bytes AS THEMSELVES -- `plan_held_inline`
 *         never wraps the user's modules around held code -- so `Mine<run>` is
 *         not defined there, C is never written, and the run row's sourceHash is
 *         the hash of `Mine<run>()` itself. POSITIVE CONTROL: the user's OWN
 *         button calling both names writes B and C ("local wins" for the user's
 *         own code), so both negatives have teeth.
 *   M6-3  A HANDED-OVER FILE / ANOTHER COMPUTER'S APPROVAL. A subscriber
 *         approves the application's held inline code and saves. POSITIVE
 *         CONTROL first: reopened untouched, no approval screen comes for it and
 *         the click runs -- the sealed approval survives save and open on this
 *         computer. Then the saved `.cala` is rewritten through the file system
 *         (fflate) twice: (i) the application's record RE-SEALED under a key
 *         generated here and thrown away -- what another computer writes -- and
 *         (ii) a version-1 file whose record carries no seal (a hand-built
 *         pre-approval). On each reopen `list_script_consents` counts no
 *         approval for the application and reports the record as
 *         `otherComputer` / `unsealed`; the approval screen comes back WITH its
 *         "made on another computer" line (`[data-consent-approval-elsewhere]`);
 *         after Block the click is refused (notConsented, recorded) and writes
 *         nothing. (i) then Allow: the click runs, and this computer's record is
 *         written BESIDE the other computer's, which stays ignored. Last, the
 *         page cannot plant an approval: `create_virtual_file` on the consent
 *         file -- with the bytes THIS computer sealed, the one record that
 *         would verify -- is refused under two spellings, the file is unchanged
 *         and nothing is approved. POSITIVE CONTROL: an ordinary path is
 *         accepted.
 *   M6-7  THE BACKSTOP. An approved application's held inline code (two lines,
 *         over 40 characters: specific enough to be matched INSIDE a longer
 *         source too) runs from its own button (POSITIVE CONTROL). The user's
 *         own AD-HOC run of the same bytes through the module-runtime door
 *         (`run_script`, where an ad-hoc source lands) is refused --
 *         `APPLICATION_CODE_OUTSIDE_ITS_BUTTON`, naming the button, the
 *         application and the fix ("save it as a script of your own first") --
 *         with an `application_code_refused` row (heldCodeOutsideButton, the
 *         button) and writes nothing; so is the same code with ONE byte added.
 *         POSITIVE CONTROLS: an ad-hoc run of other code of the user's own runs,
 *         and after the named fix (the bytes saved as a script of the user's
 *         own) the very same ad-hoc run of the held bytes runs.
 *
 * NOT HERE, on purpose (owner question 30 scoped this spec to the three claims
 * above): M6-1, M6-4 and M6-5 -- the approval screen listing held inline code,
 * the click refused before Allow and run after, a working copy, "Make this my
 * own" -- are `owner-followups.spec.ts`'s BUG-0257 test; M6-6 (own code through
 * the door) and M6-8 (own code delegating to an application macro) stay proved
 * in the unit tier only (open-items.md section 2.af, M6 follow-ups (k)).
 *
 * STATE AND DOM, NEVER PIXELS. The goldens are stale after the owner's UI
 * changes and this machine runs at DPR 2, so nothing here compares a
 * screenshot: assertions read control metadata (`get_all_controls`), stored
 * scripts (`get_script`), cells (`get_watch_cells`), the workbook's audit log
 * (`getAuditLog`, always-on rows), the approvals as Rust verifies them
 * (`list_script_consents`) and as the workbook carries them
 * (`read_virtual_file`, and the saved `.cala`'s own bytes), toasts, and the
 * approval screen's own data attributes.
 *
 * THE REAL PROFILE. E2E runs use the real profile and the real Windows
 * Credential Manager:
 *   - the first approval on a computer that never approved anything MINTS the
 *     approvals key, the generic credential `Calcula:consent-seal`
 *     (app/src-tauri/src/consent_seal.rs). This spec never reads, replaces or
 *     deletes it: production never deletes it, and deleting it would void every
 *     approval this Windows user ever made. "Another computer" is a key
 *     generated in Node for the one record it seals, then zeroed.
 *   - every publish records a developer anchor in the profile; `afterAll`
 *     forgets them (CREATED_APPS).
 *   - the first subscribe pins the publisher for the temp workspace. A pin
 *     cannot be removed from the page, so application names carry a per-run
 *     suffix and the workspace folder is removed at the next run's start: no
 *     pin from an earlier run can answer for this one.
 *   - Script Security is set to "enabled" for each test and put back in
 *     `finally`.
 *   - no native dialog is raised (no driver, no Win32), and no task pane is
 *     opened on purpose; `afterAll` still closes any that is open, Blocks any
 *     approval screen left standing (its overlay would swallow the next spec's
 *     first click) and dismisses the toasts.
 *
 * LIVE SABOTAGES for the main loop (NOT performed here). A Rust sabotage needs
 * a rebuild BETWEEN runs, never during one; a TypeScript one a fresh run.
 * Confirm the sabotaged build really changes behaviour before counting it, and
 * restore byte-identical by sha256 with a fresh mtime.
 *   M6-2: let `plan_held_inline` resolve a name among the user's own modules
 *         too -- the candidate filter at app/src-tauri/src/scripting/
 *         control_action.rs:624 becomes `(m.application() == Some(application)
 *         || !m.is_distributed()) && ...` -> after Allow B4 runs the local
 *         `Mine<run>` and writes C (red), and B2 has two answers and is refused
 *         as ambiguous, so A never comes (red).
 *   M6-3: make `consent_seal::verify` accept any record that parses -- skip the
 *         unsealed check (consent_seal.rs:751), the key-id check (:770) and the
 *         seal check (:779) -> the other computer's record counts here: no
 *         approval screen comes back for (i) and the click runs (red at "no
 *         approval screen for ... appeared"). TypeScript: drop
 *         `approvalMadeElsewhereFor(ignored, pkg) ||` at
 *         app/extensions/ScriptableObjects/index.ts:591 -> the screen asks
 *         without its "another computer" line (red at
 *         `[data-consent-approval-elsewhere]`).
 *   M6-7: "exact match only" -- reduce app/src-tauri/src/scripting/
 *         application_code_gate.rs:737 to `whole == code` -> the one-byte-added
 *         run writes J14/J15 (red); drop the backstop call at :918 -> the exact
 *         ad-hoc run writes them too (red).
 *
 * SELF-CLEANING. One temp folder, removed first; application names and markers
 * carry a per-run suffix; every test ends in the app's own File > New; the
 * rewritten `.cala` copies live in that folder and go with it.
 */
import type { Locator, Page } from "@playwright/test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";
import {
  COLLAB,
  activate,
  bounded,
  callModule,
  dismissToasts,
  emitApp,
  eventually,
  installAppImport,
  invoke,
  newFile,
  openAt,
  readCell,
  renameSheetByName,
  saveAs,
  setCells,
  sheetIndex,
  sheets,
  tryInvoke,
  tryModule,
  type AppWindow,
} from "../helpers/calp-harness";
import { publishNew, subscribe } from "../helpers/calp-collab";
import { escapeRe, startToastLog, toastLog } from "../helpers/pivot-live";

const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), "calcula-calp-inline-buttons");
const WS = path.join(WORK, "workspace");

const BUTTONS = "/src/api/buttonControlService.ts";
const DESIGN_MODE = "/src/api/designMode.ts";
const FLOATING_STORE = "/extensions/Controls/lib/floatingStore.ts";
/** The task-pane store the appPage fixture resets (app/src/shell/TaskPane/useTaskPaneStore.ts). */
const TASK_PANE_STORE = "/src/shell/TaskPane/useTaskPaneStore.ts";

/** A stored macro with no runtime marker runs in the MODULE runtime (the interpreter a button hands code to). */
const MODULE_MACRO_DESC = "e2e calp-inline-buttons (module runtime)";

/** `SCRIPT_CONSENT_FILE` (app/src-tauri/src/consent_seal.rs): the workbook's approvals, a user file. */
const CONSENT_FILE = ".calcula/script-consent.json";
/** Where a saved `.cala` keeps that user file (core/calcula-format/src/zip_io.rs writes user files under `files/`). */
const CONSENT_ENTRY = `files/${CONSENT_FILE}`;
/** `SEAL_TAG` (consent_seal.rs): the first field of the bytes a seal covers. */
const SEAL_TAG = "calcula-consent-seal/2";
/** `BUTTON_ACTION_CONSENT_PREFIX` (app/src-tauri/src/scripting/control_action.rs). */
const BUTTON_ACTION_PREFIX = "buttonAction:";

/** Every application this run publishes; `afterAll` forgets their developer anchors. */
const CREATED_APPS: string[] = [];

// ===========================================================================
// Plumbing: output, hashes, scripts, buttons, run mode, toasts, markers
// ===========================================================================

/** Plain ASCII for the terminal (CLAUDE.md "Clean Output"). */
function ascii(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

function log(message: string): void {
  console.log(`[calp-inline-buttons] ${ascii(message)}`);
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** The approval id of button code with these exact bytes (`button_action_consent_id`). */
function buttonActionId(code: string): string {
  return `${BUTTON_ACTION_PREFIX}${sha256Hex(code)}`;
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

/** A module script in the workbook's library, with no provenance (the user's own). */
async function saveModule(page: Page, id: string, name: string, source: string): Promise<void> {
  await invoke(page, "save_script", { script: { id, name, description: MODULE_MACRO_DESC, source, scope: { type: "workbook" } } });
}

/** A module-runtime macro body that writes `marker` into (row, col) of the sheet on screen. */
function cellMacro(row: number, col: number, marker: string): string {
  return `Calcula.setCellValue(${row}, ${col}, '${marker}');\n`;
}

interface StoredScript {
  id: string;
  name: string;
  source: string;
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
  req: { sheetIndex: number; row: number; col: number; label: string; onSelect?: string },
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

/** The subscriber's precondition: the button arrived with `code` HELD and stamped, nothing live. */
async function expectHeld(page: Page, sheetIdx: number, row: number, col: number, code: string, app: string, label: string): Promise<void> {
  const props = await controlAt(page, sheetIdx, row, col);
  expect(props, `${label}: the button did not arrive`).toBeTruthy();
  expect(props!.onSelect, `${label}: the subscribed button carries LIVE onSelect code`).toBeUndefined();
  expect(props!.heldOnSelect?.value, `${label}: the inline code is not in the held compartment, byte for byte`).toBe(code);
  expect(heldStamp(props)?.application, `${label}: the held code is not stamped with its application`).toBe(app);
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
 * a pulled or reopened button can be absent until a tab switch (fixall-calp C4).
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

/** Run mode, the buttons in the floating store, a fresh toast log -- then the click. */
async function clickButtonOn(page: Page, grid: GridHelper, sheetName: string, anchors: Array<[number, number]>, ref: string): Promise<void> {
  await activate(page, sheetName);
  await ensureRunMode(page);
  await revealControls(page, sheetName, anchors);
  await dismissToasts(page);
  await startToastLog(page);
  await clickButtonCell(page, grid, ref);
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
// The workbook's audit trail (always-on rows; extras are flattened on the entry)
// ===========================================================================

interface AuditRow {
  event: string;
  description: string;
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

function buttonOf(row: AuditRow | undefined): ButtonOnRow | null {
  const b = row?.button;
  return b && typeof b === "object" ? (b as ButtonOnRow) : null;
}

/** The always-on rows of `event` for `app`, optionally only those naming the button at `cell`. */
function rowsOf(rows: AuditRow[], event: string, app: string, cell?: string): AuditRow[] {
  return rows.filter((r) => r.event === event && r.application === app && (cell === undefined || buttonOf(r)?.cell === cell));
}

function artifactIdsOf(row: AuditRow): string[] {
  return Array.isArray(row.artifactIds) ? (row.artifactIds as unknown[]).map(String) : [];
}

function describeRows(rows: AuditRow[]): string {
  return ascii(
    JSON.stringify(
      rows.map((r) => ({
        event: r.event,
        reason: r.reason,
        surface: r.surface,
        macroId: r.macroId,
        artifactIds: r.artifactIds,
        sourceHash: r.sourceHash,
        application: r.application,
        button: r.button,
      })),
    ),
  ).slice(0, 2500);
}

// ===========================================================================
// The approval screen (ScriptableObjects' ScriptConsentDialog)
// ===========================================================================

function allowButton(page: Page): Locator {
  return page.getByRole("button", { name: "Allow Scripts", exact: true }).first();
}

/** The approval screen's box: the deepest element holding both its header and its Allow button. */
function consentDialog(page: Page): Locator {
  return page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: "Allow Scripts", exact: true }) })
    .filter({ hasText: "Script Security" })
    .last();
}

/**
 * Wait for the approval screen of `app`. A screen left over for ANOTHER
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
    log(`an approval screen for another application was open; refusing it: ${text.slice(0, 160)}`);
    await box.getByRole("button", { name: "Block", exact: true }).click();
    await page.waitForTimeout(600);
  }
  throw new Error(`no approval screen for "${app}" appeared`);
}

/**
 * Whether an approval screen for `app` appears within `ms`: its text, or null.
 * A screen for another application is refused and the wait goes on. Answers
 * nothing for `app` itself -- the caller decides.
 */
async function consentScreenAppearsFor(page: Page, app: string, ms: number): Promise<string | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const shown = await allowButton(page)
      .waitFor({ state: "visible", timeout: Math.max(500, deadline - Date.now()) })
      .then(
        () => true,
        () => false,
      );
    if (!shown) return null;
    const box = consentDialog(page);
    const text = await box.innerText().catch(() => "");
    if (text.includes(`"${app}"`)) return text;
    log(`an approval screen for another application was open; refusing it: ${text.slice(0, 160)}`);
    await box.getByRole("button", { name: "Block", exact: true }).click();
    await page.waitForTimeout(600);
  }
  return null;
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

/** Block the standing approval screen of `app` and wait until it is gone. */
async function blockConsent(prompt: Locator, page: Page): Promise<void> {
  await prompt.getByRole("button", { name: "Block", exact: true }).click();
  await allowButton(page).waitFor({ state: "hidden", timeout: 10_000 });
}

/** Ask the approval screen of `app` again, the way a pull announces itself. */
async function reaskConsent(page: Page, app: string): Promise<void> {
  await emitApp(page, "PACKAGE_UPDATED", { packageName: app, version: "1.0.0", kind: "subscribe", sheetsPulled: 0, scriptsPulled: 0 });
}

/** Answer any approval screen that appears (stragglers), up to four. */
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
// The approvals: as Rust verifies them, as the workbook and the file carry them
// ===========================================================================

interface ConsentScriptJson {
  id: string;
  sourceHash: string;
  source?: string;
}

interface ConsentGrantJson {
  capability: string;
  origins?: string[];
}

/** One record of `.calcula/script-consent.json` (Rust `StoredConsentRecord`, camelCase). */
interface ConsentRecordJson {
  packageName: string;
  scripts: ConsentScriptJson[];
  grantedCapabilities?: ConsentGrantJson[];
  grantedAt: string;
  keyId?: string;
  seal?: string;
}

interface ConsentFileJson {
  version: number;
  consents: ConsentRecordJson[];
}

/** `list_script_consents`' answer (Rust `ScriptConsentList`): what counts here, and what does not and why. */
interface ConsentListing {
  consents: Array<{ packageName: string; scripts: Array<{ id: string }> }>;
  ignored: Array<{ packageName: string; reason: string }>;
}

async function listConsents(page: Page): Promise<ConsentListing> {
  return invoke<ConsentListing>(page, "list_script_consents");
}

function approvedHere(listing: ConsentListing, app: string): boolean {
  return listing.consents.some((c) => c.packageName === app);
}

function ignoredReasons(listing: ConsentListing, app: string): string[] {
  return listing.ignored.filter((i) => i.packageName === app).map((i) => i.reason);
}

/** The consent file as the OPEN workbook carries it (the virtual file system's own read). */
async function consentFileInWorkbook(page: Page): Promise<ConsentFileJson> {
  return JSON.parse(await invoke<string>(page, "read_virtual_file", { path: CONSENT_FILE })) as ConsentFileJson;
}

function recordFor(file: ConsentFileJson, app: string): ConsentRecordJson {
  const found = file.consents.filter((r) => r.packageName === app);
  if (found.length !== 1) {
    throw new Error(`expected one approval record for "${app}", found ${found.length}: ${ascii(JSON.stringify(file)).slice(0, 1200)}`);
  }
  return found[0];
}

/** Every entry of a saved `.cala` (a ZIP of JSON). */
function calaEntries(file: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(fs.readFileSync(file)));
}

/** The consent file inside a saved `.cala`, from its own bytes. */
function consentFileInCala(file: string): ConsentFileJson {
  const entries = calaEntries(file);
  const bytes = entries[CONSENT_ENTRY];
  if (!bytes) throw new Error(`${file} carries no ${CONSENT_ENTRY}; its entries are: ${Object.keys(entries).join(", ")}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as ConsentFileJson;
}

/**
 * Write `to` as a copy of the saved workbook `from` whose consent file is
 * `consent` -- through the file system, as anyone holding the file can -- and
 * read it back: the rewrite landed, and no other entry was lost.
 */
function writeCalaWithConsent(from: string, to: string, consent: ConsentFileJson): void {
  const entries = calaEntries(from);
  if (!entries[CONSENT_ENTRY]) throw new Error(`${from} carries no ${CONSENT_ENTRY} to rewrite`);
  const out: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    out[name] = name === CONSENT_ENTRY ? new TextEncoder().encode(JSON.stringify(consent, null, 2)) : bytes;
  }
  fs.writeFileSync(to, zipSync(out));
  const back = calaEntries(to);
  const names = (r: Record<string, Uint8Array>): string => JSON.stringify(Object.keys(r).sort());
  if (names(back) !== names(out)) throw new Error(`the rewritten ${to} lost or gained entries: ${names(back)} vs ${names(out)}`);
  const landed = JSON.parse(new TextDecoder().decode(back[CONSENT_ENTRY])) as ConsentFileJson;
  if (JSON.stringify(landed) !== JSON.stringify(consent)) throw new Error(`the rewritten consent file in ${to} is not the one written`);
}

/** u64 little-endian, the length / count prefix of `canonical_bytes`. */
function u64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function lengthPrefixed(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([u64le(bytes.length), bytes]);
}

/** Byte order, as Rust's `&str` ordering compares. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function compareLists(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = byteCompare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/**
 * The bytes a seal covers, rebuilt from `consent_seal::canonical_bytes`: the
 * tag, packageName, grantedAt, the (id, sourceHash) pairs sorted, then the
 * capability grants sorted with their origins sorted -- every field and count
 * u64-LE length-prefixed.
 */
function canonicalBytes(record: ConsentRecordJson): Buffer {
  const parts: Buffer[] = [lengthPrefixed(SEAL_TAG), lengthPrefixed(record.packageName), lengthPrefixed(record.grantedAt)];
  const pairs = record.scripts
    .map((s) => [s.id, s.sourceHash] as const)
    .sort((a, b) => byteCompare(a[0], b[0]) || byteCompare(a[1], b[1]));
  parts.push(u64le(pairs.length));
  for (const [id, hash] of pairs) parts.push(lengthPrefixed(id), lengthPrefixed(hash));
  const caps = (record.grantedCapabilities ?? [])
    .map((g) => [g.capability, [...(g.origins ?? [])].sort(byteCompare)] as const)
    .sort((a, b) => byteCompare(a[0], b[0]) || compareLists(a[1], b[1]));
  parts.push(u64le(caps.length));
  for (const [capability, origins] of caps) {
    parts.push(lengthPrefixed(capability), u64le(origins.length));
    for (const origin of origins) parts.push(lengthPrefixed(origin));
  }
  return Buffer.concat(parts);
}

/**
 * The consent file as ANOTHER COMPUTER would have written it: `app`'s record
 * sealed under a key that exists only here, for this one record, then zeroed
 * (keyId = the first 16 hex of its sha256, seal = HMAC-SHA256 over the
 * canonical bytes, as `seal_record` does). The verifier answers
 * `otherComputer` from the key id BEFORE it reads the seal, so the outcome does
 * not rest on this file's rebuild of the canonical bytes.
 */
function resealedOnAnotherComputer(file: ConsentFileJson, app: string): { file: ConsentFileJson; keyId: string } {
  const key = crypto.randomBytes(32);
  const keyId = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  try {
    const consents = file.consents.map((r) => {
      if (r.packageName !== app) return r;
      const resealed: ConsentRecordJson = { ...r, keyId, seal: "" };
      resealed.seal = crypto.createHmac("sha256", key).update(canonicalBytes(resealed)).digest("hex");
      return resealed;
    });
    return { file: { version: file.version, consents }, keyId };
  } finally {
    key.fill(0);
  }
}

/** A version-1 file whose record for `app` carries no key id and no seal: a hand-built pre-approval. */
function unsealedVersion1(file: ConsentFileJson, app: string): ConsentFileJson {
  return {
    version: 1,
    consents: file.consents
      .filter((r) => r.packageName === app)
      .map(({ keyId: _keyId, seal: _seal, ...rest }) => rest),
  };
}

// ===========================================================================
// Task panes (afterAll)
// ===========================================================================

/** Close every task pane through the REAL store -- the appPage fixture's route -- and say what was open. */
async function closeTaskPanes(page: Page): Promise<{ isOpen: boolean; openPanes: number }> {
  await installAppImport(page);
  return bounded(
    "closeTaskPanes",
    page.evaluate(async (mod) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        useTaskPaneStore: { getState: () => { reset: () => void; isOpen?: boolean; openPanes?: unknown[] } };
      };
      m.useTaskPaneStore.getState().reset();
      const s = m.useTaskPaneStore.getState();
      return { isOpen: Boolean(s.isOpen), openPanes: Array.isArray(s.openPanes) ? s.openPanes.length : -1 };
    }, TASK_PANE_STORE),
  );
}

// ===========================================================================
// THE JOURNEY
// ===========================================================================

test.describe("calp inline buttons, live (M6: the confused deputy by name, a handed-over approval, the backstop)", () => {
  test.beforeAll(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
  });

  test.afterAll(async ({ sharedPage: page }) => {
    // The anchors this run's publishes recorded in the REAL profile point at a
    // temp workspace; forget them so the profile does not accumulate them.
    for (const app of CREATED_APPS) {
      const r = await tryModule(page, COLLAB, "forgetDeveloperAnchor", [WS, app]);
      log(`cleanup: forget the developer anchor of ${app}: ${r.ok ? JSON.stringify(r.value) : r.error}`);
    }
    // An approval screen left standing would swallow the next spec's first
    // click (its overlay Blocks on a click).
    const left = await answerConsentPrompts(page, "Block", 1500).catch(() => [] as string[]);
    if (left.length > 0) log(`cleanup: Blocked approval screens left standing: ${JSON.stringify(left)}`);
    // File > New closes no task pane: whatever is open must not narrow the
    // grid for the specs after this one.
    const panes = await closeTaskPanes(page).catch((e: unknown) => ({ isOpen: true, openPanes: -1, error: String(e) }));
    log(`cleanup: task panes after the reset: ${JSON.stringify(panes)}`);
    await dismissToasts(page).catch(() => undefined);
    await newFile(page).catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // M6-2: the confused deputy by NAME.
  // -------------------------------------------------------------------------
  test("M6-2: an application's button calling a name the subscriber also owns locally is refused before Allow (recorded, nothing runs) and after Allow runs only the APPLICATION's module; a name only a local module answers is never reached (the held bytes run as themselves); the user's own button still reaches both local modules", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(540_000);
    const app = `m62-deputy-${RUN}`;
    const sheetName = `Deputy${RUN}`;
    const REPORT = `Report${RUN}`;
    const MINE = `Mine${RUN}`;
    const appReportId = `app-report-${RUN}`;
    const localReportId = `local-report-${RUN}`;
    const localMineId = `local-mine-${RUN}`;
    const A = `M62-APP-${RUN}`;
    const B = `M62-LOCAL-${RUN}`;
    const C = `M62-MINE-${RUN}`;
    const appSource = cellMacro(11, 9, A);
    const callReport = `${REPORT}()`;
    const callMine = `${MINE}()`;
    const cellB2 = `${sheetName}!B2`;
    const cellB4 = `${sheetName}!B4`;
    const anchors: Array<[number, number]> = [
      [1, 1],
      [3, 1],
    ];
    CREATED_APPS.push(app);
    try {
      await withScriptsEnabled(page, async () => {
        // ---- The publisher: the module and two bare-call buttons.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await ensureRunMode(page);
        await saveModule(page, appReportId, REPORT, appSource);
        await createButton(page, { sheetIndex: pub, row: 1, col: 1, label: "Report", onSelect: callReport });
        await createButton(page, { sheetIndex: pub, row: 3, col: 1, label: "Mine", onSelect: callMine });
        await clickButtonOn(page, grid, sheetName, anchors, "B2");
        await eventually(
          () => readCell(page, pub, "J12").then((c) => c.display),
          (v) => v === A,
          "POSITIVE CONTROL: the publisher's own Report() button did not run its module (J12), so the negatives below would prove nothing",
          20_000,
        );
        await setCells(page, pub, [["J12", ""]]);
        expect((await publishNew(page, WS, app, "1.0.0")).version, `precondition: ${app} was published`).toBe("1.0.0");

        // ---- The subscriber: LOCAL modules of both names, BEFORE subscribing.
        await newFile(page);
        await saveModule(page, localReportId, REPORT, cellMacro(13, 9, B));
        await saveModule(page, localMineId, MINE, cellMacro(15, 9, C));
        await subscribe(page, WS, app);
        const sub = await sheetIndex(page, sheetName);

        // STATE: the application's module landed BESIDE the local one of the
        // same name (a different id), and both buttons arrived held.
        const theirs = await storedScript(page, appReportId);
        expect(theirs.sourcePackage, "precondition: the application's Report did not land as the application's").toBe(app);
        expect(theirs.name).toBe(REPORT);
        expect(theirs.source, "precondition: the application's Report does not write A").toContain(A);
        const mine = await storedScript(page, localReportId);
        expect(mine.sourcePackage ?? null, "precondition: the subscriber's Report is not the user's own").toBeNull();
        expect(mine.name, "precondition: the two modules do not share a name").toBe(REPORT);
        expect((await storedScript(page, localMineId)).sourcePackage ?? null).toBeNull();
        await expectHeld(page, sub, 1, 1, callReport, app, "B2");
        await expectHeld(page, sub, 3, 1, callMine, app, "B4");

        // DOM: the approval screen shows both calls verbatim; B2's says it runs
        // the APPLICATION's macro, and nothing says B4 runs anything.
        const prompt = await consentPromptFor(page, app);
        const codes = (await prompt.locator("[data-consent-button-action]").allInnerTexts()).map((t) => t.trim());
        expect(codes, "the approval screen does not show both held calls, byte for byte").toEqual(expect.arrayContaining([callReport, callMine]));
        await expect(
          prompt.locator(`[data-consent-button-action-runs="${sha256Hex(callReport)}"]`),
          "the approval screen does not say B2 runs the application's macro",
        ).toContainText(`Runs the application's macro ${REPORT}.`);
        await expect(
          prompt.locator(`[data-consent-button-action-runs="${sha256Hex(callMine)}"]`),
          "the approval screen says B4's call runs a macro -- no module of the application answers it",
        ).toHaveCount(0);

        // ---- BEFORE Allow: refused, recorded, nothing runs.
        await blockConsent(prompt, page);
        const before = await auditRows(page);
        const refusedBefore = rowsOf(before, "application_code_refused", app, cellB2).length;
        const ranBefore = rowsOf(before, "application_code_run", app).length;
        await clickButtonOn(page, grid, sheetName, anchors, "B2");
        const said = await waitForToast(
          page,
          new RegExp(`came with the application '${escapeRe(app)}'`),
          "the click on B2 before Allow was not refused in the door's words",
        );
        expect(said, "the refusal does not say the code is unapproved").toMatch(/you have not approved its code/);
        await page.waitForTimeout(1500);
        expect(await sheetsShowing(page, "J12", A), "before Allow, the application's module ran").toEqual([]);
        expect(await sheetsShowing(page, "J14", B), "before Allow, the subscriber's LOCAL Report ran (the confused deputy)").toEqual([]);
        const refused = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_refused", app, cellB2),
          (r) => r.length > refusedBefore,
          "no application_code_refused row names B2",
          15_000,
        );
        const refusal = refused[refused.length - 1];
        expect(refusal.reason, `the refusal row: ${describeRows([refusal])}`).toBe("notConsented");
        expect(refusal.macroId, "the refusal row does not name the held bytes' approval id").toBe(buttonActionId(callReport));
        expect(buttonOf(refusal)?.held, "the refusal row does not say the code is held for the application").toBe(true);
        expect(rowsOf(await auditRows(page), "application_code_run", app).length, "a refused click left a run row").toBe(ranBefore);

        // ---- Allow.
        await reaskConsent(page, app);
        await allowConsentFor(page, app);

        // ---- B2 after Allow: the APPLICATION's module, never the local one.
        await clickButtonOn(page, grid, sheetName, anchors, "B2");
        await eventually(
          () => readCell(page, sub, "J12").then((c) => c.display),
          (v) => v === A,
          `after Allow, B2 did not run the application's Report (J12); toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );
        await page.waitForTimeout(1000);
        expect(await sheetsShowing(page, "J14", B), "the application's Report() ran the subscriber's LOCAL Report (the confused deputy by name)").toEqual([]);
        const reportRuns = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_run", app, cellB2),
          (r) => r.length > 0,
          "no application_code_run row names B2",
          15_000,
        );
        const reportRun = reportRuns[reportRuns.length - 1];
        log(`M6-2 B2 run row: ${describeRows([reportRun])}`);
        expect(reportRun.macroId, "the run row does not lead with the held bytes' approval id").toBe(buttonActionId(callReport));
        expect(artifactIdsOf(reportRun), "the run row does not name the application's module").toContain(appReportId);
        expect(artifactIdsOf(reportRun), "the run row names the subscriber's LOCAL module").not.toContain(localReportId);
        expect(reportRun.sourceHash, "what ran is not the application's stored module, byte for byte").toBe(sha256Hex(theirs.source));
        expect.soft(reportRun.surface, "the run did not come through the button door").toBe("button");
        expect.soft(reportRun.door).toBe("button");
        expect.soft(buttonOf(reportRun)?.held).toBe(true);

        // ---- B4 after Allow: no module of the application answers Mine(), so
        // the held bytes run as themselves -- and the local Mine is not there.
        await clickButtonOn(page, grid, sheetName, anchors, "B4");
        const mineRuns = await eventually(
          async () => rowsOf(await auditRows(page), "application_code_run", app, cellB4),
          (r) => r.length > 0,
          "no application_code_run row names B4",
          15_000,
        );
        const mineRun = mineRuns[mineRuns.length - 1];
        log(`M6-2 B4 run row: ${describeRows([mineRun])}`);
        expect(mineRun.macroId).toBe(buttonActionId(callMine));
        expect(mineRun.sourceHash, "B4 did not run its held bytes as themselves (something was wrapped around them)").toBe(sha256Hex(callMine));
        expect(artifactIdsOf(mineRun), "B4's run row names a module").toEqual([]);
        const failed = await waitForToast(page, /couldn't run/, "B4's run did not say it stopped", 15_000).catch((e: unknown) => `NO TOAST: ${String(e)}`);
        log(`M6-2 B4 said: ${failed.slice(0, 300)}`);
        expect.soft(failed, "B4's run did not stop on the undefined name").toMatch(/not defined/);
        await page.waitForTimeout(1000);
        expect(await sheetsShowing(page, "J16", C), "the application's Mine() ran the subscriber's LOCAL Mine (the confused deputy by name)").toEqual([]);

        // ---- POSITIVE CONTROL: the user's OWN button reaches both local modules.
        const s1 = await activate(page, "Sheet1");
        await createButton(page, { sheetIndex: s1, row: 1, col: 1, label: "Mine", onSelect: `${callReport}; ${callMine};` });
        await clickButtonOn(page, grid, "Sheet1", [[1, 1]], "B2");
        await eventually(
          () => readCell(page, s1, "J14").then((c) => c.display),
          (v) => v === B,
          "POSITIVE CONTROL: the user's own button did not run the local Report (J14), so 'never B' proves nothing",
          20_000,
        );
        await eventually(
          () => readCell(page, s1, "J16").then((c) => c.display),
          (v) => v === C,
          "POSITIVE CONTROL: the user's own button did not run the local Mine (J16), so 'never C' proves nothing",
          20_000,
        );
      });
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // M6-3: a handed-over file, another computer's approval.
  // -------------------------------------------------------------------------
  test("M6-3: an approval reopened on this computer still counts; one sealed on another computer, or never sealed, counts for nothing -- the approval screen asks again saying why, the click is refused before Allow, and the page cannot plant one", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(720_000);
    const app = `m63-handed-${RUN}`;
    const sheetName = `Hand${RUN}`;
    const MARK = `M63-RAN-${RUN}`;
    const CODE = `Calcula.setCellValue(9, 9, '${MARK}');`;
    const cellB2 = `${sheetName}!B2`;
    const anchors: Array<[number, number]> = [[1, 1]];
    const approvedFile = path.join(WORK, `m63-approved-${RUN}.cala`);
    const otherFile = path.join(WORK, `m63-other-computer-${RUN}.cala`);
    const unsealedFile = path.join(WORK, `m63-unsealed-${RUN}.cala`);
    CREATED_APPS.push(app);

    /** Reopened from a handed-over file: asked again, saying why; refused before Allow. */
    const expectAskedAgainAndRefused = async (reason: "otherComputer" | "unsealed"): Promise<void> => {
      // STATE: Rust counts no approval for the application, and says why.
      const listing = await listConsents(page);
      expect(approvedHere(listing, app), `${reason}: an approval the workbook carries counted on this computer`).toBe(false);
      expect(ignoredReasons(listing, app), `${reason}: list_script_consents does not report the carried record`).toContain(reason);

      // DOM: the approval screen comes back, with its "another computer" line.
      const prompt = await consentPromptFor(page, app);
      await expect(
        prompt.locator("[data-consent-approval-elsewhere]"),
        `${reason}: the approval screen does not say the workbook's approval was made elsewhere`,
      ).toBeVisible();
      expect(
        (await prompt.locator("[data-consent-button-action]").allInnerTexts()).map((t) => t.trim()),
        `${reason}: the approval screen does not show the held code`,
      ).toContain(CODE);
      await blockConsent(prompt, page);

      // NOTHING RUNS BEFORE ALLOW, and the refusal is recorded.
      const sub = await sheetIndex(page, sheetName);
      expect((await readCell(page, sub, "J10")).display, `${reason}: precondition: J10 is empty`).toBe("");
      const before = await auditRows(page);
      const refusedBefore = rowsOf(before, "application_code_refused", app, cellB2).length;
      const ranBefore = rowsOf(before, "application_code_run", app).length;
      await clickButtonOn(page, grid, sheetName, anchors, "B2");
      const said = await waitForToast(
        page,
        new RegExp(`came with the application '${escapeRe(app)}'`),
        `${reason}: the click before Allow was not refused in the door's words`,
      );
      expect(said, `${reason}: the refusal does not say the code is unapproved`).toMatch(/you have not approved its code/);
      await page.waitForTimeout(1500);
      expect(await sheetsShowing(page, "J10", MARK), `${reason}: the handed-over approval ran the application's code`).toEqual([]);
      const refused = await eventually(
        async () => rowsOf(await auditRows(page), "application_code_refused", app, cellB2),
        (r) => r.length > refusedBefore,
        `${reason}: no application_code_refused row names B2`,
        15_000,
      );
      expect(refused[refused.length - 1].reason, `${reason}: the refusal row: ${describeRows(refused.slice(-1))}`).toBe("notConsented");
      expect(rowsOf(await auditRows(page), "application_code_run", app).length, `${reason}: a refused click left a run row`).toBe(ranBefore);
    };

    try {
      await withScriptsEnabled(page, async () => {
        // ---- The publisher: one inline-code button, proved.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await ensureRunMode(page);
        await createButton(page, { sheetIndex: pub, row: 1, col: 1, label: "Handed", onSelect: CODE });
        await clickButtonOn(page, grid, sheetName, anchors, "B2");
        await eventually(
          () => readCell(page, pub, "J10").then((c) => c.display),
          (v) => v === MARK,
          "POSITIVE CONTROL: the publisher's own inline button did not write J10",
          20_000,
        );
        await setCells(page, pub, [["J10", ""]]);
        expect((await publishNew(page, WS, app, "1.0.0")).version, `precondition: ${app} was published`).toBe("1.0.0");

        // ---- The subscriber approves, proves the click, and saves.
        await newFile(page);
        await subscribe(page, WS, app);
        const sub = await sheetIndex(page, sheetName);
        await expectHeld(page, sub, 1, 1, CODE, app, "B2");
        await allowConsentFor(page, app);
        await clickButtonOn(page, grid, sheetName, anchors, "B2");
        await eventually(
          () => readCell(page, sub, "J10").then((c) => c.display),
          (v) => v === MARK,
          `precondition: after Allow the held inline button did not run (J10); toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );
        await setCells(page, sub, [["J10", ""]]);
        const sealed = await consentFileInWorkbook(page);
        const mineRecord = recordFor(sealed, app);
        expect(sealed.version, "precondition: the approvals file is not a sealed (version 2) file").toBe(2);
        expect(mineRecord.keyId ?? "", "precondition: this computer's record carries no key id").toMatch(/^[0-9a-f]{16}$/);
        expect(mineRecord.seal ?? "", "precondition: this computer's record carries no seal").toMatch(/^[0-9a-f]{64}$/);
        expect(mineRecord.scripts.map((s) => s.id), "precondition: the record does not approve the held bytes").toContain(buttonActionId(CODE));
        expect(approvedHere(await listConsents(page), app), "precondition: the approval does not count here").toBe(true);
        await saveAs(page, approvedFile);
        const savedConsent = consentFileInCala(approvedFile);
        expect(recordFor(savedConsent, app).keyId, "the saved .cala does not carry this computer's approval").toBe(mineRecord.keyId);

        // ---- POSITIVE CONTROL: reopened untouched, on this computer.
        await openAt(page, approvedFile);
        const askedUntouched = await consentScreenAppearsFor(page, app, 8000);
        expect(askedUntouched, "the reopened, UNTOUCHED workbook asked again: this computer's own approval did not survive save and open").toBeNull();
        const reopened = await listConsents(page);
        expect(approvedHere(reopened, app), "the reopened approval does not count on the computer that made it").toBe(true);
        expect(ignoredReasons(reopened, app), "the reopened approval is reported as ignored").toEqual([]);
        const subReopened = await sheetIndex(page, sheetName);
        await clickButtonOn(page, grid, sheetName, anchors, "B2");
        await eventually(
          () => readCell(page, subReopened, "J10").then((c) => c.display),
          (v) => v === MARK,
          `POSITIVE CONTROL: the reopened, approved button did not run (J10), so the refusals below would prove nothing; toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );

        // ---- (i) ANOTHER COMPUTER'S APPROVAL.
        const foreign = resealedOnAnotherComputer(savedConsent, app);
        expect(foreign.keyId, "the simulated computer drew this computer's key id").not.toBe(mineRecord.keyId);
        writeCalaWithConsent(approvedFile, otherFile, foreign.file);
        await openAt(page, otherFile);
        expect(recordFor(await consentFileInWorkbook(page), app).keyId, "the reopened workbook does not carry the other computer's record").toBe(
          foreign.keyId,
        );
        await expectAskedAgainAndRefused("otherComputer");
        // ...and the screen is the remedy: Allow, and it runs. This computer's
        // record is written BESIDE the other computer's, which stays ignored.
        await reaskConsent(page, app);
        await allowConsentFor(page, app);
        const subOther = await sheetIndex(page, sheetName);
        await clickButtonOn(page, grid, sheetName, anchors, "B2");
        await eventually(
          () => readCell(page, subOther, "J10").then((c) => c.display),
          (v) => v === MARK,
          `after Allow on this computer, the button did not run (J10); toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );
        const besides = await listConsents(page);
        expect(approvedHere(besides, app), "this computer's new approval does not count").toBe(true);
        expect.soft(ignoredReasons(besides, app), "the other computer's record was not kept beside (still ignored here)").toContain("otherComputer");
        expect
          .soft(
            (await consentFileInWorkbook(page)).consents.filter((r) => r.packageName === app).map((r) => r.keyId),
            "the file does not hold both computers' records",
          )
          .toEqual(expect.arrayContaining([foreign.keyId, mineRecord.keyId]));

        // ---- (ii) A HAND-BUILT, UNSEALED PRE-APPROVAL (a version-1 file).
        writeCalaWithConsent(approvedFile, unsealedFile, unsealedVersion1(savedConsent, app));
        await openAt(page, unsealedFile);
        const carried = await consentFileInWorkbook(page);
        expect(carried.version, "the reopened workbook does not carry the version-1 file").toBe(1);
        expect(recordFor(carried, app).seal, "the reopened record is sealed after all").toBeUndefined();
        await expectAskedAgainAndRefused("unsealed");

        // ---- THE PAGE CANNOT PLANT AN APPROVAL. The bytes are the ones THIS
        // computer sealed -- the one record that WOULD verify here.
        const planted = JSON.stringify(savedConsent, null, 2);
        const fileBefore = JSON.stringify(await consentFileInWorkbook(page));
        for (const spelling of [CONSENT_FILE, "./.calcula/SCRIPT-CONSENT.json"]) {
          const r = await tryInvoke(page, "create_virtual_file", { path: spelling, content: planted });
          expect(r.ok, `create_virtual_file wrote the approvals file as "${spelling}"`).toBe(false);
          expect(r.error, `the refusal of "${spelling}" is not the approvals-file guard`).toContain("holds this workbook's approvals of application code");
        }
        expect(JSON.stringify(await consentFileInWorkbook(page)), "a refused write changed the approvals file").toBe(fileBefore);
        expect(approvedHere(await listConsents(page), app), "a refused write approved the application").toBe(false);
        // POSITIVE CONTROL: the virtual file system takes an ordinary file.
        const ordinary = `e2e-m63-${RUN}.txt`;
        const wrote = await tryInvoke(page, "create_virtual_file", { path: ordinary, content: MARK });
        expect(wrote.ok, `POSITIVE CONTROL: create_virtual_file refused an ordinary path: ${wrote.error}`).toBe(true);
        expect(await invoke<string>(page, "read_virtual_file", { path: ordinary })).toBe(MARK);
        await tryInvoke(page, "delete_virtual_file", { path: ordinary });
      });
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await answerConsentPrompts(page, "Block", 1000).catch(() => [] as string[]);
      await newFile(page).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // M6-7: the backstop.
  // -------------------------------------------------------------------------
  test("M6-7: an approved application's held inline code runs from its own button, but the user's own ad-hoc run of the same bytes -- or of them with one byte added -- is refused naming the button and the fix, recorded, and runs nothing; other ad-hoc code runs, and after the named fix so do those bytes", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(480_000);
    const app = `m67-backstop-${RUN}`;
    const sheetName = `Back${RUN}`;
    const MA = `M67-A-${RUN}`;
    const MB = `M67-B-${RUN}`;
    const OWN = `M67-OWN-${RUN}`;
    const HELD = `Calcula.setCellValue(13, 9, '${MA}');\nCalcula.setCellValue(14, 9, '${MB}');`;
    const cellB2 = `${sheetName}!B2`;
    const anchors: Array<[number, number]> = [[1, 1]];
    CREATED_APPS.push(app);
    // HELD_CODE_SUBSTRING_MIN_CHARS (40) and _MIN_LINES (2),
    // app/src-tauri/src/scripting/application_code_gate.rs: only code this
    // specific is refused INSIDE a longer source, which the one-byte variant needs.
    expect(
      HELD.trim().length >= 40 && HELD.split("\n").filter((l) => l.trim() !== "").length >= 2,
      "precondition: the held code is specific enough for the backstop's substring match",
    ).toBe(true);

    /** The backstop's refusal of an ad-hoc `source`: said, recorded, nothing written. */
    const expectRefusedAdHoc = async (source: string, label: string): Promise<void> => {
      const before = rowsOf(await auditRows(page), "application_code_refused", app).filter((r) => r.reason === "heldCodeOutsideButton").length;
      const r = await tryInvoke(page, "run_script", { request: { source, filename: `m67-adhoc-${RUN}.js` } });
      log(`M6-7 ${label}: ${r.ok ? `RAN ${JSON.stringify(r.value).slice(0, 300)}` : r.error.slice(0, 400)}`);
      expect(r.ok, `${label}: the ad-hoc run of the application's held button code RAN`).toBe(false);
      expect(r.error, `${label}: not refused by the backstop`).toContain("APPLICATION_CODE_OUTSIDE_ITS_BUTTON");
      expect(r.error, `${label}: the refusal does not name the button`).toContain(cellB2);
      expect(r.error, `${label}: the refusal does not name the application`).toContain(`'${app}'`);
      expect(r.error, `${label}: the refusal does not name the fix`).toMatch(/save it as a script of your own first/);
      await page.waitForTimeout(800);
      expect(await sheetsShowing(page, "J14", MA), `${label}: the refused run wrote J14`).toEqual([]);
      expect(await sheetsShowing(page, "J15", MB), `${label}: the refused run wrote J15`).toEqual([]);
      const rows = await eventually(
        async () => rowsOf(await auditRows(page), "application_code_refused", app).filter((x) => x.reason === "heldCodeOutsideButton"),
        (x) => x.length > before,
        `${label}: no application_code_refused (heldCodeOutsideButton) row`,
        15_000,
      );
      const row = rows[rows.length - 1];
      expect(row.surface, `${label}: the refusal row: ${describeRows([row])}`).toBe("moduleRuntime");
      expect(row.macroId, `${label}: the refusal row does not name the held bytes' approval id`).toBe(buttonActionId(HELD));
      expect(row.sourceHash, `${label}: the refusal row does not carry the hash of what was asked to run`).toBe(sha256Hex(source));
      expect(buttonOf(row)?.cell, `${label}: the refusal row does not name the button`).toBe(cellB2);
    };

    try {
      await withScriptsEnabled(page, async () => {
        // ---- The publisher: one two-line inline button, proved.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await ensureRunMode(page);
        await createButton(page, { sheetIndex: pub, row: 1, col: 1, label: "Held", onSelect: HELD });
        await clickButtonOn(page, grid, sheetName, anchors, "B2");
        await eventually(
          () => readCell(page, pub, "J15").then((c) => c.display),
          (v) => v === MB,
          "POSITIVE CONTROL: the publisher's own two-line button did not write J15",
          20_000,
        );
        await setCells(page, pub, [
          ["J14", ""],
          ["J15", ""],
        ]);
        expect((await publishNew(page, WS, app, "1.0.0")).version, `precondition: ${app} was published`).toBe("1.0.0");

        // ---- The subscriber approves; the held code runs from ITS button.
        await newFile(page);
        await subscribe(page, WS, app);
        const sub = await sheetIndex(page, sheetName);
        await expectHeld(page, sub, 1, 1, HELD, app, "B2");
        await allowConsentFor(page, app);
        await clickButtonOn(page, grid, sheetName, anchors, "B2");
        await eventually(
          () => readCell(page, sub, "J15").then((c) => c.display),
          (v) => v === MB,
          `POSITIVE CONTROL: the approved held code did not run from its own button (J15); toasts: ${JSON.stringify(await toastTextsLogged(page))}`,
          20_000,
        );
        expect((await readCell(page, sub, "J14")).display).toBe(MA);
        await setCells(page, sub, [
          ["J14", ""],
          ["J15", ""],
        ]);

        // ---- The user's own AD-HOC run of the same bytes, approved or not.
        await expectRefusedAdHoc(HELD, "exact bytes");
        await expectRefusedAdHoc(`${HELD};`, "one byte added");

        // ---- POSITIVE CONTROL: other ad-hoc code of the user's own runs.
        const own = await tryInvoke(page, "run_script", { request: { source: cellMacro(16, 9, OWN), filename: `m67-own-${RUN}.js` } });
        expect(own.ok, `POSITIVE CONTROL: the user's own ad-hoc code was refused: ${own.error}`).toBe(true);
        await eventually(() => sheetsShowing(page, "J17", OWN), (s) => s.length > 0, "POSITIVE CONTROL: the user's own ad-hoc code did not write J17", 15_000);

        // ---- THE NAMED FIX: the bytes saved as a script of the user's own,
        // and the same ad-hoc run goes through.
        const refusalsBeforeFix = rowsOf(await auditRows(page), "application_code_refused", app).filter((r) => r.reason === "heldCodeOutsideButton").length;
        await saveModule(page, `own-copy-${RUN}`, `My copy ${RUN}`, HELD);
        const fixed = await tryInvoke(page, "run_script", { request: { source: HELD, filename: `m67-fixed-${RUN}.js` } });
        expect(fixed.ok, `after the named fix the ad-hoc run was still refused: ${fixed.error}`).toBe(true);
        await eventually(() => sheetsShowing(page, "J15", MB), (s) => s.length > 0, "after the named fix the ad-hoc run did not write J15", 15_000);
        expect(
          rowsOf(await auditRows(page), "application_code_refused", app).filter((r) => r.reason === "heldCodeOutsideButton").length,
          "the run after the named fix was recorded as refused",
        ).toBe(refusalsBeforeFix);
      });
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });
});
