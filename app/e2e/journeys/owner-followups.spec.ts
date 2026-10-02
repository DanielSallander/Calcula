/**
 * OWNER FOLLOW-UPS, LIVE: button code in Collaboration and the timeline's
 * range drag -- the approved design "Button Code and Moving Objects".
 *
 *   1. BUG-0257 (phase 1) -- a working copy HOLDS its application's button
 *      code: checkout moves `onSelect` / `macroRef` into the held keys, and an
 *      untouched push republishes `controls.json` byte for byte. Since phase 4
 *      every click goes through the Rust button door: the approval screen lists
 *      the held INLINE code, a click on it before Allow is REFUSED in the door's
 *      words (naming the approval) and writes nothing, and after Allow the same
 *      click runs it; a held macro LINK runs the approved macro (phase 3).
 *      After the push, "Make this my own" in the Properties pane (M6 S12):
 *      the native confirm shows the code; Cancel changes nothing; "Make it my
 *      own" MOVES it into the live slot with an always-on audit row, the next
 *      click runs it as the developer's OWN code (no application run row), and
 *      Ctrl+Z brings the application's held code back -- in the pane too.
 *   2. BUG-0260 (phase 2) -- a subscribed button CELL whose action names the
 *      subscriber's own `macro-report` (the application's same-id macro is
 *      skipped on the clash) is disarmed with a notice, and a click never
 *      writes that macro's marker; a button naming a macro the application
 *      ships keeps its action.
 *   3. BUG-0262 -- Open for Editing refuses a head version re-signed by a key
 *      the application never authorised, naming the signer and its
 *      fingerprint, and changes nothing; the authorised version opens and the
 *      Checkout dialog shows its signer.
 *   4. BUG-0258 (phase 1) -- a drag across month tiles selects a range from
 *      the FIRST press on an unselected timeline, never moves it, and is ONE
 *      undo step; the header still moves it; a LOCKED timeline still filters.
 *
 * STATE, NEVER PIXELS. Every assertion reads the backend (control metadata,
 * cell-type params, cells, the undo depth, timeline geometry), the published
 * files in the temp workspace (checksums re-verified here), or the DOM (the
 * Checkout dialog's panel, toasts). No golden screenshot is compared: the
 * goldens are stale after the owner's UI changes.
 *
 * POSITIVE CONTROLS. Each negative has one, so a no-op cannot pass: the armed
 * buttons DO write their markers with a click before they are published; the
 * user's own button cell DOES run `macro-report`; the authorised version DOES
 * open; the timeline's header DOES move it while unlocked.
 *
 * ROUTES. Publish, push and subscribe through the @api/collaboration calls the
 * dialogs make (helpers/calp-collab.ts); checkout through the REAL dialog
 * (Collaboration > Open Application for Editing...); clicks and drags with
 * the real pointer at points computed from the extensions' own geometry.
 *
 * WHAT IS NOT LIVE HERE (covered by Rust tests only): the checkout refusal of
 * an UNSIGNED first version and the push-merge signer check (BUG-0262), a
 * forged held slot refused at push, and Shift+click range extension (phase 2
 * of BUG-0258, not built).
 *
 * SELF-CLEANING. Every test ends in the app's own File > New. The workspace
 * lives under one temp folder removed first; application names carry a
 * per-run suffix, so no TOFU pin from an earlier run answers for this one.
 */
import type { Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import {
  COLLAB,
  activate,
  addCanvas,
  bounded,
  callModule,
  dismissToasts,
  emitApp,
  eventually,
  installAppImport,
  invoke,
  isDirty,
  newFile,
  pressUndo,
  readCell,
  renameSheetByName,
  setCells,
  sheetIndex,
  sheetNames,
  sheets,
  undoState,
  type AppWindow,
} from "../helpers/calp-harness";
import { publishNew, push, subscribe, workingCopy, type PublishResult, type PullResult } from "../helpers/calp-collab";
import {
  cellAt,
  clickRibbonTestId,
  configurePivot,
  createRangePivot,
  escapeRe,
  pivotView,
  startToastLog,
  toastLog,
  viewText,
  writeTable,
} from "../helpers/pivot-live";
import { humanClick, objects } from "../helpers/canvas-live";

const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), "calcula-owner-followups");
const WS = path.join(WORK, "workspace");

const BUTTONS = "/src/api/buttonControlService.ts";
const CELL_TYPES = "/src/api/cellTypes.ts";
const DESIGN_MODE = "/src/api/designMode.ts";
const FLOATING_STORE = "/extensions/Controls/lib/floatingStore.ts";
const TL = {
  STORE: "/extensions/TimelineSlicer/lib/timelineSlicerStore.ts",
  GEO: "/extensions/TimelineSlicer/lib/timelineCanvasGeometry.ts",
  VIEW: "/extensions/TimelineSlicer/lib/timelineView.ts",
  ZONES: "/extensions/TimelineSlicer/lib/timelineZones.ts",
  SELECTED: "/extensions/TimelineSlicer/lib/timelineSelectedIds.ts",
  GRID: "/src/api/grid.ts",
} as const;
const UI = "/src/api/ui.ts";
/** `PROPERTIES_PANE_ID`, app/extensions/Controls/index.ts. */
const CONTROL_PROPERTIES_PANE = "control-properties";

// ===========================================================================
// Native confirms (confirmAsync -> tauri-plugin-dialog -> Win32 TaskDialog),
// driven from outside: Tauri's IPC cannot be stubbed from the page.
// ===========================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_DRIVER = path.join(HERE, "..", "answer-native-dialog.ps1");
/** The title "Make this my own" gives its confirm (HeldCodeSection.requestHeldAdoption). */
const ADOPT_TITLE = "Make the application";
/** Its two buttons: the plugin's OkCancelCustom(okLabel, "Cancel"). */
const ADOPT_YES = "Make it my own";
const ADOPT_NO = "Cancel";

interface ConfirmVerdict {
  raw: string;
  text: string;
  buttons: string[];
  sent: string | null;
  gone: boolean;
}

/**
 * Press the button labelled exactly `label` on the native confirm whose title
 * contains `titleLike`. The CALLER must already have AWAITED the gesture that
 * raises it: this call blocks Node's event loop, so an unawaited page call
 * before it is never sent.
 */
function answerConfirm(titleLike: string, label: string, waitMs = 20_000): ConfirmVerdict {
  if (!fs.existsSync(DIALOG_DRIVER)) {
    throw new Error(`the native-dialog driver is missing at ${DIALOG_DRIVER}: "no dialog appeared" could not be told from "nothing looked"`);
  }
  let raw: string;
  try {
    raw = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        DIALOG_DRIVER,
        "-TitleLike",
        titleLike,
        "-Action",
        "button",
        "-Button",
        label,
        "-TimeoutMs",
        String(waitMs),
      ],
      { encoding: "utf-8", timeout: waitMs + 30_000, windowsHide: true },
    );
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    raw = typeof out === "string" && out.length > 0 ? out : `DRIVERERROR:${String(e)}`;
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const buttonsLine = lines.find((l) => l.startsWith("BUTTONS:"));
  return {
    raw: lines.join(" | "),
    text: lines.filter((l) => l.startsWith("TEXT:")).map((l) => l.slice(5)).join(" "),
    buttons: buttonsLine ? buttonsLine.slice("BUTTONS:".length).split("|").filter(Boolean) : [],
    sent: lines.find((l) => l.startsWith("CLICKED:")) ?? null,
    gone: lines.includes("GONE"),
  };
}

/** Dismiss a leftover confirm from a crashed run, so the driver never answers one this test did not raise. */
function drainConfirms(titleLike: string): void {
  for (let i = 0; i < 3; i++) {
    if (!answerConfirm(titleLike, ADOPT_NO, 1200).sent) break;
  }
}

interface AuditRow {
  event: string;
  application?: unknown;
  cell?: unknown;
  button?: unknown;
  [key: string]: unknown;
}

async function auditRows(page: Page): Promise<AuditRow[]> {
  const logged = await callModule<{ entries?: AuditRow[] }>(page, COLLAB, "getAuditLog");
  return logged.entries ?? [];
}

/** The always-on rows of `event` for `app`, optionally only those naming the button at `cell`. */
function rowsOf(rows: AuditRow[], event: string, app: string, cell?: string): AuditRow[] {
  return rows.filter((r) => {
    if (r.event !== event || r.application !== app) return false;
    if (cell === undefined) return true;
    const button = r.button && typeof r.button === "object" ? (r.button as { cell?: unknown }) : null;
    return r.cell === cell || button?.cell === cell;
  });
}

// ===========================================================================
// Plumbing: scripts, buttons, run mode, consent, toasts
// ===========================================================================

async function withScriptsEnabled<T>(page: Page, body: () => Promise<T>): Promise<T> {
  const previous = await invoke<string>(page, "get_script_security_level").catch(() => "prompt");
  await invoke(page, "set_script_security_level", { level: "enabled" });
  try {
    return await body();
  } finally {
    await invoke(page, "set_script_security_level", { level: previous }).catch(() => undefined);
  }
}

/** A module script in the workbook's library (what Developer > Macros lists). */
async function saveModule(page: Page, id: string, name: string, source: string, description = "e2e owner-followups"): Promise<void> {
  await invoke(page, "save_script", { script: { id, name, description, source, scope: { type: "workbook" } } });
}

interface ButtonHandle {
  instanceId: string;
  sheetIndex: number;
  row: number;
  col: number;
}

/** A real, clickable floating button through the @api seam (the Controls recipe). */
async function createButton(
  page: Page,
  req: { sheetIndex: number; row: number; col: number; label: string; onSelect?: string; macroRef?: string },
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
interface ControlMeta {
  controlType: string;
  properties: Record<string, StoredProp>;
}

async function controlMeta(page: Page, sheetIdx: number, row: number, col: number): Promise<ControlMeta | null> {
  return invoke<ControlMeta | null>(page, "get_control_metadata", { sheetIndex: sheetIdx, row, col });
}

/** Run mode: a click on a button RUNS it (Design Mode would select it instead). */
async function ensureRunMode(page: Page): Promise<void> {
  const design = await callModule<boolean>(page, DESIGN_MODE, "getDesignMode");
  if (design) await callModule(page, DESIGN_MODE, "setDesignMode", [false]);
  expect(await callModule<boolean>(page, DESIGN_MODE, "getDesignMode"), "precondition: Design Mode is off").toBe(false);
}

/** Leave the sheet and come back: the tab strip's route, which reloads its controls and cell types. */
async function revisit(page: Page, name: string): Promise<number> {
  const other = (await sheets(page)).sheets.find((s) => s.name !== name);
  if (other) await activate(page, other.name);
  return activate(page, name);
}

/**
 * Make sure the floating buttons anchored at `anchors` are in the Controls
 * extension's floating store for `sheetName` (what paints and hit-tests them).
 * fixall-calp C4 found a pulled button absent until a tab switch, so a
 * missing one is fetched the user's way: leave the sheet and come back.
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
 * Answer the Script Security consent prompt an application's scripts raise, if
 * one appears (it is queued asynchronously after a pull or a checkout). Keyed
 * on its "Allow Scripts" button, which nothing else on screen carries.
 */
async function answerConsentPrompts(page: Page, choice: "Allow Scripts" | "Block", firstWaitMs = 4000): Promise<string[]> {
  const answered: string[] = [];
  let wait = firstWaitMs;
  for (let i = 0; i < 4; i++) {
    const allow = page.getByRole("button", { name: "Allow Scripts", exact: true }).first();
    const shown = await allow.waitFor({ state: "visible", timeout: wait }).then(
      () => true,
      () => false,
    );
    if (!shown) break;
    await page.getByRole("button", { name: choice, exact: true }).first().click();
    answered.push(choice);
    await page.waitForTimeout(500);
    wait = 1500;
  }
  return answered;
}

async function waitForToast(page: Page, pattern: RegExp, label: string, ms = 15_000): Promise<string> {
  const log = await eventually(() => toastLog(page), (t) => t.some((x) => pattern.test(x.text)), label, ms);
  return log.find((x) => pattern.test(x.text))!.text;
}

// ===========================================================================
// Published files (read from the temp workspace, checksum re-verified)
// ===========================================================================

interface Artifact {
  checksum: string;
  text: string;
}

interface VersionManifestHead {
  version: string;
  publisherKey: string;
  publisherName?: string;
  publishedBy?: string;
  artifactChecksums?: Record<string, string>;
}

function versionManifest(app: string, version: string): VersionManifestHead {
  return JSON.parse(fs.readFileSync(path.join(WS, app, version, "version-manifest.json"), "utf8")) as VersionManifestHead;
}

/**
 * One published artifact of a version, located the way the workspace reads it
 * (a file in the version folder, else the content-addressed blob its signed
 * manifest names), and its sha256 checked against that manifest here -- so the
 * bytes compared are the bytes a subscriber would verify.
 */
function publishedArtifact(app: string, version: string, rel: string): Artifact {
  const manifest = versionManifest(app, version);
  const sum = manifest.artifactChecksums?.[rel];
  if (!sum) {
    throw new Error(`${app}@${version} lists no ${rel}: ${Object.keys(manifest.artifactChecksums ?? {}).join(", ")}`);
  }
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

interface SavedControlEntry {
  row: number;
  col: number;
  controlType?: string;
  properties?: Record<string, StoredProp>;
}
interface SavedSheetControlsJson {
  sheetId: string;
  controls?: SavedControlEntry[];
}

/** Every non-empty code slot in a controls.json, as "row,col slot=valueType:value". */
function codeSlots(json: string): string[] {
  const out: string[] = [];
  for (const sheet of JSON.parse(json) as SavedSheetControlsJson[]) {
    for (const c of sheet.controls ?? []) {
      for (const slot of ["onSelect", "macroRef"]) {
        const p = c.properties?.[slot];
        if (p && p.value !== "") out.push(`${c.row},${c.col} ${slot}=${p.valueType}:${p.value}`);
      }
    }
  }
  return out.sort();
}

/** Which properties of which controls differ between two controls.json texts (for a failure message). */
function diffControls(before: string, after: string): string {
  const index = (json: string): Map<string, Record<string, StoredProp>> => {
    const m = new Map<string, Record<string, StoredProp>>();
    for (const sheet of JSON.parse(json) as SavedSheetControlsJson[]) {
      for (const c of sheet.controls ?? []) m.set(`${sheet.sheetId}@${c.row},${c.col}`, c.properties ?? {});
    }
    return m;
  };
  const a = index(before);
  const b = index(after);
  const lines: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const pa = a.get(key);
    const pb = b.get(key);
    if (!pa || !pb) {
      lines.push(`${key}: ${pa ? "removed" : "added"}`);
      continue;
    }
    for (const p of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      const va = JSON.stringify(pa[p] ?? null);
      const vb = JSON.stringify(pb[p] ?? null);
      if (va !== vb) lines.push(`${key}.${p}: ${va} -> ${vb}`);
    }
  }
  return lines.length > 0 ? lines.join("; ").slice(0, 1500) : "(no property differs: the bytes differ in order or formatting)";
}

/**
 * PLANT A VERSION the way anyone who can write to the share can: re-sign an
 * existing version's manifest with a fresh Ed25519 key that the application
 * never authorised. The signature is VALID (Node signs the exact bytes on disk,
 * the same detached-hex format `calp::signing` writes), so only the
 * authorisation check can refuse it. Only the version's own manifest and
 * signature change -- the listing is an unverified mirror, and its artifacts
 * stay the published ones.
 */
function plantResignedVersion(app: string, version: string, signerName: string): { key: string; fingerprint: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("plant: Node exported no raw Ed25519 public key");
  const key = Buffer.from(jwk.x, "base64url").toString("hex");
  if (key.length !== 64) throw new Error(`plant: expected a 32-byte key, got ${key}`);

  const dir = path.join(WS, app, version);
  const manifestPath = path.join(dir, "version-manifest.json");
  const original = fs.readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(original) as VersionManifestHead;
  // TEXTUAL edits, so every other byte stays exactly as Rust wrote it.
  let text = original.replace(`"publisherKey": "${parsed.publisherKey}"`, `"publisherKey": "${key}"`);
  text =
    parsed.publisherName !== undefined
      ? text.replace(/"publisherName": "[^"]*"/, `"publisherName": "${signerName}"`)
      : text.replace(`"publisherKey": "${key}"`, `"publisherKey": "${key}",\n  "publisherName": "${signerName}"`);
  if (parsed.publishedBy !== undefined) text = text.replace(/"publishedBy": "[^"]*"/, `"publishedBy": "${signerName}"`);
  const check = JSON.parse(text) as VersionManifestHead;
  if (check.publisherKey !== key || check.publisherName !== signerName) {
    throw new Error(`plant: the manifest edit did not land (key ${check.publisherKey}, name ${check.publisherName})`);
  }
  const bytes = Buffer.from(text, "utf8");
  const signature = crypto.sign(null, bytes, privateKey);
  if (!crypto.verify(null, bytes, publicKey, signature)) throw new Error("plant: Node could not verify its own signature");
  fs.writeFileSync(manifestPath, bytes);
  fs.writeFileSync(path.join(dir, "version-manifest.sig"), signature.toString("hex"));
  return { key, fingerprint: `${key.slice(0, 16)}...` };
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

/** Type the workspace, list its applications, pick `app` (its newest version is pre-selected). */
async function chooseApplication(page: Page, dialog: Locator, workspace: string, app: string): Promise<void> {
  await dialog.getByPlaceholder("C:\\shared\\workspace", { exact: true }).fill(workspace);
  await dialog.getByRole("button", { name: "List applications", exact: true }).click();
  const select = dialog.locator("select").filter({ has: page.locator(`option[value="${app}"]`) }).first();
  await select.waitFor({ state: "visible", timeout: 30_000 });
  await select.selectOption(app);
  await dialog.locator('input[type="radio"][name="checkout-version"]').first().waitFor({ state: "visible", timeout: 15_000 });
}

async function clickOpenForEditing(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Open for Editing", exact: true }).click();
}

async function waitForCheckoutResult(dialog: Locator): Promise<void> {
  const ok = await dialog
    .locator('[data-testid="checkout-result"]')
    .waitFor({ state: "visible", timeout: 60_000 })
    .then(
      () => true,
      () => false,
    );
  if (!ok) {
    const said = await dialog.innerText().catch(() => "(unreadable)");
    throw new Error(`the checkout never showed its result; the dialog says: ${said.slice(0, 1500)}`);
  }
}

// ===========================================================================
// 1-3. COLLABORATION
// ===========================================================================

test.describe("owner follow-ups, live: button code in Collaboration (BUG-0257 / 0260 / 0262)", () => {
  test.beforeAll(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
  });

  test("BUG-0257: a checkout HOLDS the application's button code, the approval screen lists the held inline code, a click on it is refused before Allow (naming the approval) and runs after Allow (phase 4), a held macro link runs the approved macro (phase 3), an untouched push republishes controls.json byte for byte, and Make this my own moves the held code into the live slot after a confirm that showed it (audited, one undo step) so it runs as the developer's own", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(540_000);
    const app = `followups-held-${RUN}`;
    const sheetName = `Dash${RUN}`;
    const macroId = `macro-held-${RUN}`;
    const inlineMarker = `INLINE-RAN-${RUN}`;
    const macroMarker = `MACRO-RAN-${RUN}`;
    // Inline code writes J10; the linked macro writes J12 -- of the active sheet.
    const INLINE = `Calcula.setCellValue(9, 9, '${inlineMarker}');`;
    try {
      await withScriptsEnabled(page, async () => {
        // ---- The publisher: two ARMED buttons, each proved to run by a click.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await ensureRunMode(page);

        await createButton(page, { sheetIndex: pub, row: 1, col: 1, label: "Inline", onSelect: INLINE });
        await revealControls(page, sheetName, [[1, 1]]);
        await grid.clickCell("B2");
        await eventually(
          () => readCell(page, pub, "J10").then((c) => c.display),
          (v) => v === inlineMarker,
          "POSITIVE CONTROL: clicking the ARMED inline button did not write J10, so the working-copy negative below would prove nothing",
          20_000,
        );

        // A MODULE-runtime macro (Calcula.*): the phase-3 proof is that an APPROVED
        // application macro runs from its held link. A recorder-shaped macro
        // (runtime=objectScript, context.api) cannot write cells as application
        // code at all -- context.api exists only at the unlocked tier, which
        // distributed code never gets (contextShims.ts) -- a separate, owner-level
        // question recorded in docs/design/open-items.md (run 9b, 2026-09-30).
        await saveModule(page, macroId, "Held macro", `Calcula.setCellValue(11, 9, '${macroMarker}');\n`);
        await createButton(page, { sheetIndex: pub, row: 5, col: 1, label: "Linked", macroRef: macroId });
        await revealControls(page, sheetName, [[1, 1], [5, 1]]);
        await grid.clickCell("B6");
        await eventually(
          () => readCell(page, pub, "J12").then((c) => c.display),
          (v) => v === macroMarker,
          "POSITIVE CONTROL: clicking the ARMED macro-linked button did not run its macro (J12)",
          20_000,
        );
        await setCells(page, pub, [["J10", ""], ["J12", ""]]);

        const published = await publishNew(page, WS, app, "1.0.0");
        expect(published.version, `precondition: ${app} was published`).toBe("1.0.0");
        const base = publishedArtifact(app, "1.0.0", "controls.json");
        const baseCode = codeSlots(base.text);
        expect(baseCode, "precondition: v1.0.0 publishes both buttons' code").toEqual([`1,1 onSelect=static:${INLINE}`, `5,1 macroRef=static:${macroId}`].sort());

        // ---- The developer: Collaboration > Open Application for Editing, in a fresh workbook.
        await newFile(page);
        const dialog = await openCheckoutDialog(page);
        await chooseApplication(page, dialog, WS, app);
        await clickOpenForEditing(dialog);
        await waitForCheckoutResult(dialog);
        const heldBox = (await dialog.locator('[data-testid="checkout-button-code-held"]').innerText()).trim();
        expect(heldBox, "the Checkout dialog does not say the application's button code was held").toMatch(/2 button code slots came with this application/);
        // PHASE 4: the approval screen lists the held INLINE code by its exact
        // bytes (Task C), beside the application's macro. BLOCK it first, so the
        // click below proves the door refuses unapproved code; Allow comes after.
        await page
          .getByRole("button", { name: "Allow Scripts", exact: true })
          .first()
          .waitFor({ state: "visible", timeout: 20_000 });
        const listedCode = page.locator("[data-consent-button-action]");
        await expect(listedCode.first(), "the approval screen does not list the held inline code").toBeVisible();
        expect(await listedCode.allInnerTexts(), "the approval screen does not show the inline code's exact text").toContain(INLINE);
        const blocked = await answerConsentPrompts(page, "Block");
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
        blocked.push(...(await answerConsentPrompts(page, "Block", 1500)));
        console.log(`[owner-followups] checkout consent prompts answered: ${JSON.stringify(blocked)}`);
        expect(blocked.length, "precondition: the checkout raised an approval screen to Block").toBeGreaterThan(0);

        const dev = await sheetIndex(page, sheetName);
        const inline = await controlMeta(page, dev, 1, 1);
        const linked = await controlMeta(page, dev, 5, 1);
        expect(inline, "the inline button did not arrive in the working copy").toBeTruthy();
        expect(linked, "the macro-linked button did not arrive in the working copy").toBeTruthy();
        expect(inline!.properties.onSelect, "the working copy's inline button carries LIVE onSelect code").toBeUndefined();
        expect(inline!.properties.heldOnSelect?.value, "the inline code is not in the held compartment").toBe(INLINE);
        const stamp = JSON.parse(inline!.properties.heldFrom?.value ?? "null") as { application?: string; version?: string } | null;
        expect(stamp?.application, "the held code is not stamped with its application").toBe(app);
        expect(stamp?.version).toBe("1.0.0");
        expect(linked!.properties.macroRef, "the working copy's button carries a LIVE macroRef").toBeUndefined();
        expect(linked!.properties.heldMacroRef?.value, "the macro link is not in the held compartment").toBe(macroId);
        expect(linked!.properties.onSelect?.value ?? "", "the recipe's empty onSelect is not code and stays empty").toBe("");

        // ---- PHASE 4, NEGATIVE: a click on the held INLINE button before Allow.
        // The Rust button door refuses it in its own words -- naming the
        // application and the approval it waits for -- and nothing runs.
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1], [5, 1]]);
        await dismissToasts(page);
        await page.waitForTimeout(300);
        await startToastLog(page);
        await grid.clickCell("B2");
        const notice = await waitForToast(
          page,
          new RegExp(`came with the application '${escapeRe(app)}'`),
          "clicking the held inline button (B2) before Allow showed no refusal naming the application",
        );
        expect(notice, "the refusal does not say the code is unapproved").toMatch(/you have not approved its code/);
        expect(notice, "the refusal does not point at the approval screen").toMatch(/approval screen/);
        expect(notice, "the page's old held sentence is back (the door no longer answers the click)").not.toMatch(
          /does not run in a working copy/,
        );
        await page.waitForTimeout(1500);
        expect((await readCell(page, dev, "J10")).display, "NEGATIVE: before Allow, the HELD inline button ran its code (J10)").toBe("");

        // ---- Allow: the screen asked again by the same announcement a pull makes.
        await emitApp(page, "PACKAGE_UPDATED", { packageName: app, version: "1.0.0", kind: "subscribe", sheetsPulled: 0, scriptsPulled: 0 });
        const allowed = await answerConsentPrompts(page, "Allow Scripts", 20_000);
        console.log(`[owner-followups] re-asked consent prompts answered: ${JSON.stringify(allowed)}`);
        expect(allowed.length, "the approval screen did not come back to Allow").toBeGreaterThan(0);

        // ---- PHASE 4, POSITIVE: the same click now runs the approved bytes.
        // This fresh workbook holds no sheet of the developer's beside the
        // application, so the working-copy private-sheet rule lets it run.
        await activate(page, sheetName);
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1], [5, 1]]);
        await dismissToasts(page);
        await startToastLog(page);
        await grid.clickCell("B2");
        await eventually(
          () => readCell(page, dev, "J10").then((c) => c.display),
          (v) => v === inlineMarker,
          `after Allow, clicking the held inline button did not run its approved code (J10); toasts: ${JSON.stringify(await toastLog(page))}`,
          20_000,
        );
        // REVIEW OF M6b: the button door's run row names its door, like the
        // module runtime's and the mount door's -- an application's held inline
        // code runs with the module runtime's full reach, so a reader filtering
        // the trail by `door` / `startedBy` must see this run.
        // LIVE SABOTAGE: pass `None` for the access in `record_button_run`
        // (scripting/application_code_gate.rs) -> both soft checks go red.
        {
          const inlineRuns = rowsOf(await auditRows(page), "application_code_run", app, `${sheetName}!B2`);
          expect(inlineRuns.length, "the approved held inline run left no application_code_run row").toBeGreaterThan(0);
          const lastRun = inlineRuns[inlineRuns.length - 1];
          expect.soft(lastRun.startedBy, `the button door's run row: ${JSON.stringify(lastRun)}`).toBe("you");
          expect.soft(lastRun.door, `the button door's run row: ${JSON.stringify(lastRun)}`).toBe("button");
        }

        // ---- PHASE 3 OF BUG-0257: a held macro LINK is not inert. The
        // application's macro was APPROVED above, so a click runs it -- as the
        // application's macro, through the Rust run gate.
        await dismissToasts(page);
        await grid.clickCell("B6");
        await eventually(
          () => readCell(page, dev, "J12").then((c) => c.display),
          (v) => v === macroMarker,
          "clicking the held macro-LINKED button did not run the application's approved macro (J12)",
          20_000,
        );
        // Back to the base's state, so the push below is still untouched.
        await setCells(page, dev, [["J10", ""], ["J12", ""]]);

        // ---- Push untouched: the new version's controls are the base's, byte for byte.
        const wc = await workingCopy(page);
        expect(wc?.packageName, "precondition: the workbook is the application's working copy").toBe(app);
        expect(wc?.baseVersion).toBe("1.0.0");
        const pushed = (await push(page, WS, app, "1.0.1")) as PublishResult & {
          report?: { buttonCode?: { restored?: unknown[]; refused?: unknown[]; unreviewed?: unknown[] } };
        };
        expect(pushed.version).toBe("1.0.1");
        expect
          .soft(pushed.report?.buttonCode?.restored?.length ?? -1, `the push report's button code: ${JSON.stringify(pushed.report?.buttonCode ?? null).slice(0, 800)}`)
          .toBe(2);
        const next = publishedArtifact(app, "1.0.1", "controls.json");
        expect(codeSlots(next.text), "the untouched push lost or changed the application's button code (BUG-0257)").toEqual(baseCode);
        expect(next.text, "a held key reached the published controls.json").not.toMatch(/"held(OnSelect|MacroRef|From)"/);
        expect(next.checksum, `an untouched push changed controls.json: ${diffControls(base.text, next.text)}`).toBe(base.checksum);

        // The push publishes the code; it never re-arms the working copy.
        const after = await controlMeta(page, dev, 1, 1);
        expect(after?.properties.onSelect, "the push re-armed the working copy's button").toBeUndefined();
        expect(after?.properties.heldOnSelect?.value).toBe(INLINE);

        // ---- PHASE 4, "MAKE THIS MY OWN" (M6 S12): the one way an application's
        // button code becomes the developer's own. AFTER the push, so the push
        // above stays untouched. The real route: Design Mode, click the button,
        // the Properties pane shows the held code and says what a click does
        // with it; the NATIVE confirm shows the code; Cancel changes nothing;
        // "Make it my own" MOVES it into the live slot (Rust
        // adopt_held_button_code) with an always-on audit row; Ctrl+Z brings
        // the application's code back -- in the store AND in the open pane.
        const heldSection = page.locator("[data-held-code-section]");
        const paneTitle = page.getByText("Button Properties", { exact: true });
        const openPropertiesOnB2 = async (label: string): Promise<void> => {
          await callModule(page, DESIGN_MODE, "setDesignMode", [true]);
          await activate(page, sheetName);
          await revealControls(page, sheetName, [[1, 1]]);
          await grid.clickCell("B2");
          const opened = await heldSection
            .or(paneTitle)
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(
              () => true,
              () => false,
            );
          expect.soft(opened, `${label}: clicking the button in Design Mode did not open its Properties pane`).toBe(true);
          if (!opened) {
            await callModule(page, UI, "openTaskPane", [
              CONTROL_PROPERTIES_PANE,
              { row: 1, col: 1, sheetIndex: dev, controlType: "button" },
            ]);
          }
        };
        await openPropertiesOnB2("before Make this my own");
        await heldSection.waitFor({ state: "visible", timeout: 20_000 });
        expect((await page.locator("[data-held-code='onSelect']").innerText()).trim(), "the pane does not show the held inline code verbatim").toBe(INLINE);
        expect(
          (await page.locator("[data-held-code-note='onSelect']").innerText()).trim(),
          "the pane does not say the held inline code runs after approval",
        ).toBe("Runs when clicked, after you approve the application's code.");
        const adoptStep = page.locator("[data-held-adopt]");
        await expect(adoptStep, "the pane offers no Make this my own step").toBeVisible();
        drainConfirms(ADOPT_TITLE);
        const adoptedRowsBefore = rowsOf(await auditRows(page), "button_code_adopted", app).length;

        // NEGATIVE: Cancel.
        await adoptStep.click();
        const no = answerConfirm(ADOPT_TITLE, ADOPT_NO);
        console.log(`[owner-followups] Make this my own (Cancel): ${no.raw.slice(0, 300)}`);
        expect(no.sent, `the Make this my own confirm never appeared or was not answered: ${no.raw.slice(0, 600)}`).toMatch(/^CLICKED:/);
        expect.soft(no.buttons, "the confirm does not offer exactly the two answers").toEqual(expect.arrayContaining([ADOPT_YES, ADOPT_NO]));
        expect(no.text, "the confirm does not show the code it asks about").toContain(INLINE);
        expect.soft(no.text, "the confirm does not say the code becomes yours").toContain("becomes YOUR code");
        await page.waitForTimeout(1500);
        const afterNo = await controlMeta(page, dev, 1, 1);
        expect(afterNo?.properties.onSelect, "NEGATIVE: Cancel made the application's code the developer's own").toBeUndefined();
        expect(afterNo?.properties.heldOnSelect?.value, "NEGATIVE: Cancel touched the held code").toBe(INLINE);
        expect(rowsOf(await auditRows(page), "button_code_adopted", app).length, "NEGATIVE: Cancel wrote an adoption row").toBe(adoptedRowsBefore);

        // POSITIVE: Make it my own.
        await adoptStep.click();
        const yes = answerConfirm(ADOPT_TITLE, ADOPT_YES);
        console.log(`[owner-followups] Make this my own (yes): ${yes.raw.slice(0, 300)}`);
        expect(yes.sent, `the Make this my own confirm never appeared the second time or was not answered: ${yes.raw.slice(0, 600)}`).toMatch(/^CLICKED:/);
        const adopted = await eventually(
          () => controlMeta(page, dev, 1, 1),
          (m) => m?.properties.onSelect?.value === INLINE,
          "Make this my own did not move the held code into the button's own OnSelect",
          20_000,
        );
        expect(adopted?.properties.onSelect?.valueType, "the adopted code lost its type").toBe("static");
        expect(adopted?.properties.heldOnSelect, "the held twin was left behind (a copy, not a move)").toBeUndefined();
        expect(adopted?.properties.heldFrom, "the application's stamp was left behind").toBeUndefined();
        await expect(heldSection, "the pane still shows the held view after Make this my own").toHaveCount(0, { timeout: 10_000 });
        const adoptedRows = rowsOf(await auditRows(page), "button_code_adopted", app);
        expect(adoptedRows.length, "Make this my own left no always-on button_code_adopted row").toBe(adoptedRowsBefore + 1);
        expect(adoptedRows[adoptedRows.length - 1].cell, "the adoption row does not name the button").toBe(`${sheetName}!B2`);

        // Ctrl+Z: ONE step brings the application's held code back.
        await pressUndo(page);
        const undone = await eventually(
          () => controlMeta(page, dev, 1, 1),
          (m) => m?.properties.heldOnSelect?.value === INLINE && m?.properties.onSelect === undefined,
          "Ctrl+Z after Make this my own did not bring the application's held code back",
          15_000,
        );
        expect(
          (JSON.parse(undone?.properties.heldFrom?.value ?? "null") as { application?: string } | null)?.application,
          "Ctrl+Z did not restore the held code's stamp",
        ).toBe(app);
        if ((await paneTitle.count()) > 0) {
          await expect(heldSection, "the open Properties pane did not re-read after Ctrl+Z (it still offers the code as yours)").toBeVisible({
            timeout: 10_000,
          });
        } else {
          console.log("[owner-followups] the Properties pane closed on Ctrl+Z: nothing stale to show");
        }

        // Make it the developer's own again, and click: it runs as OWN code --
        // the marker, and no application run row for this button.
        if ((await heldSection.count()) === 0) await openPropertiesOnB2("after Ctrl+Z");
        await heldSection.waitFor({ state: "visible", timeout: 20_000 });
        await page.locator("[data-held-adopt]").click();
        const again = answerConfirm(ADOPT_TITLE, ADOPT_YES);
        expect(again.sent, `the second Make this my own was not answered: ${again.raw.slice(0, 600)}`).toMatch(/^CLICKED:/);
        await eventually(
          () => controlMeta(page, dev, 1, 1),
          (m) => m?.properties.onSelect?.value === INLINE && m?.properties.heldOnSelect === undefined,
          "the second Make this my own did not move the held code",
          20_000,
        );
        const appRunsBefore = rowsOf(await auditRows(page), "application_code_run", app, `${sheetName}!B2`).length;
        await ensureRunMode(page);
        await revealControls(page, sheetName, [[1, 1]]);
        await dismissToasts(page);
        await startToastLog(page);
        await grid.clickCell("B2");
        await eventually(
          () => readCell(page, dev, "J10").then((c) => c.display),
          (v) => v === inlineMarker,
          `after Make this my own, clicking the button did not run its (now own) code (J10); toasts: ${JSON.stringify(await toastLog(page))}`,
          20_000,
        );
        expect(
          rowsOf(await auditRows(page), "application_code_run", app, `${sheetName}!B2`).length,
          "the adopted code still ran as the APPLICATION's code (an application_code_run row for the button)",
        ).toBe(appRunsBefore);
      });
    } finally {
      // A confirm left open blocks every IPC call, File > New included.
      drainConfirms(ADOPT_TITLE);
      await callModule(page, DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });

  test("BUG-0260: a subscribed button cell naming the subscriber's own macro-report is disarmed with a notice and a click never writes its marker; a button naming a macro the application ships keeps its action", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(360_000);
    const app = `followups-cells-${RUN}`;
    const sheetName = `Btns${RUN}`;
    const appMacro = `macro-app-${RUN}`;
    const MARKER = `PWNED-${RUN}`;
    try {
      await withScriptsEnabled(page, async () => {
        // ---- The publisher: two button cells. B2 names macro-report; B4 names
        // the application's own macro. The application SHIPS a macro-report of
        // its own: since M4 a push REFUSES a button whose macro it does not
        // publish (CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED), so an honest publish can
        // no longer carry a dead link. The confused deputy is the id CLASH: the
        // subscriber already owns macro-report, the subscribe keeps theirs and
        // skips the application's, and B2 must not reach the subscriber's.
        await newFile(page);
        await renameSheetByName(page, "Sheet1", sheetName);
        const pub = await activate(page, sheetName);
        await saveModule(page, appMacro, "App macro", `Calcula.setCellValue(51, 25, 'APP-RAN-${RUN}');`);
        await saveModule(page, "macro-report", "Report", `Calcula.setCellValue(53, 25, 'APP-REPORT-${RUN}');`);
        await callModule(page, CELL_TYPES, "setCellType", [1, 1, "calcula.button", { label: "Theirs", action: { kind: "script", scriptId: "macro-report" } }]);
        await callModule(page, CELL_TYPES, "setCellType", [3, 1, "calcula.button", { label: "Ours", action: { kind: "script", scriptId: appMacro } }]);
        const own = await cellTypesOn(page, pub);
        expect(
          own.filter((c) => c.typeId === "calcula.button" && c.params?.action).map((c) => `${c.row},${c.col}`),
          "precondition: the publisher's two button cells carry their actions",
        ).toEqual(["1,1", "3,1"]);
        const published = await publishNew(page, WS, app, "1.0.0");
        expect(published.version, `precondition: ${app} was published`).toBe("1.0.0");

        // ---- The subscriber owns a macro-report that writes a marker (Z50).
        await newFile(page);
        await saveModule(page, "macro-report", "Report", `Calcula.setCellValue(49, 25, '${MARKER}');`);
        const pulled = (await subscribe(page, WS, app)) as PullResult & { buttonActionsRemoved?: string[]; buttonActionsHeld?: string[] };
        const consent = await answerConsentPrompts(page, "Block");
        console.log(`[owner-followups] subscribe consent prompts answered: ${JSON.stringify(consent)}`);

        // The notice: the subscribe says which action it removed, and why.
        const removed = pulled.buttonActionsRemoved ?? [];
        expect(
          removed.some((s) => s.includes(`${sheetName}!B2`) && s.includes("macro-report")),
          `the subscribe did not report removing B2's macro-report action: ${JSON.stringify(removed)}`,
        ).toBe(true);
        expect(removed.filter((s) => s.includes(`${sheetName}!B4`)), "the button naming the application's OWN macro was removed").toEqual([]);

        // The stored params: B2 disarmed and stamped, B4 kept and stamped.
        const sub = await sheetIndex(page, sheetName);
        const cells = await cellTypesOn(page, sub);
        const theirs = cells.find((c) => c.row === 1 && c.col === 1);
        const ours = cells.find((c) => c.row === 3 && c.col === 1);
        expect(theirs?.typeId, "B2's button cell did not arrive").toBe("calcula.button");
        expect(theirs?.params?.action, "B2 arrived ARMED with an action naming the subscriber's own macro-report").toBeUndefined();
        expect(theirs?.params?.heldAction, "a subscribe must remove, never hold").toBeUndefined();
        expect(stampedApplication(theirs?.params), "B2 is not stamped with its application").toBe(app);
        expect(ours?.params?.action, "POSITIVE CONTROL: the action naming the application's own macro was not kept").toEqual({ kind: "script", scriptId: appMacro });
        expect(stampedApplication(ours?.params), "B4 is not stamped with its application").toBe(app);

        // ---- The click: a notice, and the subscriber's macro never runs.
        await revisit(page, sheetName);
        await callModule(page, CELL_TYPES, "refreshCellTypeAssignments");
        await ensureRunMode(page);
        await dismissToasts(page);
        await startToastLog(page);
        await grid.clickCell("B2");
        await waitForToast(
          page,
          new RegExp(`came with the application '${escapeRe(app)}' and has no action`),
          "clicking the disarmed button cell showed no notice naming its application",
        );
        await page.waitForTimeout(1500);
        const markers: string[] = [];
        for (const s of (await sheets(page)).sheets) {
          if ((await readCell(page, s.index, "Z50")).display === MARKER) markers.push(s.name);
        }
        expect(markers, "clicking the application's button ran the subscriber's own macro-report (BUG-0260)").toEqual([]);

        // ---- POSITIVE CONTROL: the SAME click route on the user's own button
        // cell does run macro-report, so the negative above has teeth.
        const s1 = await activate(page, "Sheet1");
        await callModule(page, CELL_TYPES, "setCellType", [3, 3, "calcula.button", { label: "Mine", action: { kind: "script", scriptId: "macro-report" } }]);
        await page.waitForTimeout(300);
        await grid.clickCell("D4");
        await eventually(
          () => readCell(page, s1, "Z50").then((c) => c.display),
          (v) => v === MARKER,
          "POSITIVE CONTROL: the user's own button cell naming macro-report did not write the marker",
          20_000,
        );
      });
    } finally {
      await newFile(page).catch(() => undefined);
    }
  });

  test("BUG-0262: Open for Editing refuses a head version re-signed by an unauthorised key, naming the signer and its fingerprint, and changes nothing; the authorised v1.0.0 opens and the dialog shows its signer and fingerprint", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    const app = `followups-signer-${RUN}`;
    const sheetName = `Signed${RUN}`;
    const malloryName = `mallory-e2e-${RUN}`;
    try {
      // ---- The publisher (this machine's key, the application's root): 1.0.0, then 1.1.0.
      await newFile(page);
      await renameSheetByName(page, "Sheet1", sheetName);
      const pub = await sheetIndex(page, sheetName);
      await setCells(page, pub, [["A1", "v1"]]);
      expect((await publishNew(page, WS, app, "1.0.0")).version).toBe("1.0.0");
      const wc = await workingCopy(page);
      expect(wc?.packageName, "precondition: the first publish made this workbook the application's working copy").toBe(app);
      await setCells(page, pub, [["A1", "v2"]]);
      expect((await push(page, WS, app, "1.1.0")).version).toBe("1.1.0");
      const root = versionManifest(app, "1.0.0");
      expect(versionManifest(app, "1.1.0").publisherKey, "precondition: 1.1.0 is signed by the root").toBe(root.publisherKey);

      // ---- Plant: 1.1.0 (the head) re-signed by a key nobody authorised.
      const mallory = plantResignedVersion(app, "1.1.0", malloryName);
      expect(mallory.key).not.toBe(root.publisherKey);

      // ---- A developer opens the head for editing.
      await newFile(page);
      const before = { names: await sheetNames(page), dirty: await isDirty(page) };
      const dialog = await openCheckoutDialog(page);
      await chooseApplication(page, dialog, WS, app);
      const newest = dialog.locator("label").filter({ hasText: "v1.1.0" }).locator('input[type="radio"]');
      await expect(newest, "precondition: the dialog pre-selects the head (the planted 1.1.0)").toBeChecked();
      await clickOpenForEditing(dialog);
      const said = await eventually(
        () => dialog.innerText(),
        (t) => /not an authorised publisher/i.test(t),
        "Open for Editing did not refuse a head signed by a key the application never authorised (BUG-0262)",
        30_000,
      );
      expect(said, "the refusal does not name the signer").toContain(malloryName);
      expect(said, "the refusal does not name the signer's key fingerprint").toContain(mallory.fingerprint);
      expect(said, "the refusal does not name the version").toContain(`${app}@1.1.0`);
      expect(await dialog.locator('[data-testid="checkout-result"]').count(), "a refused checkout showed a result panel").toBe(0);
      expect(await dialog.locator('[data-testid="checkout-collision-remedy"]').count(), "a signer refusal offered the collision remedy").toBe(0);
      // Nothing was written anywhere.
      expect(await sheetNames(page), "a refused checkout added sheets").toEqual(before.names);
      expect(await isDirty(page), "a refused checkout dirtied the document").toBe(before.dirty);
      expect(await workingCopy(page), "a refused checkout made the workbook a working copy").toBeNull();
      const audit = await callModule<{ entries: Array<{ event: string; description: string }> }>(page, COLLAB, "getAuditLog");
      expect
        .soft(
          audit.entries.some((e) => e.event === "signer_refused"),
          `no signer_refused audit row: ${JSON.stringify(audit.entries.map((e) => e.event))}`,
        )
        .toBe(true);

      // ---- POSITIVE CONTROL: the authorised v1.0.0 opens, and the panel shows who signed it.
      await dialog.locator("label").filter({ hasText: "v1.0.0" }).locator('input[type="radio"]').check();
      await clickOpenForEditing(dialog);
      await waitForCheckoutResult(dialog);
      const rootFingerprint = `${root.publisherKey.slice(0, 16)}...`;
      const shownName = (await dialog.locator('[data-testid="checkout-signer-name"]').innerText()).trim();
      const shownFingerprint = (await dialog.locator('[data-testid="checkout-signer-fingerprint"]').innerText()).trim();
      expect(shownName, "the signer panel does not name the version's signer").toBe(root.publisherName || "an unnamed publisher");
      expect(shownFingerprint, "the signer panel does not show the signer's key fingerprint").toBe(rootFingerprint);
      expect(shownFingerprint).not.toBe(mallory.fingerprint);
      expect((await dialog.locator('[data-testid="checkout-signer-authority"]').innerText()).trim()).toMatch(/the publisher who created this application/);
      await expect(dialog.locator('[data-testid="checkout-signer-yours"]'), "the root key is this computer's").toBeVisible();
      await answerConsentPrompts(page, "Block", 1500);
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      expect(await sheetNames(page), "the authorised checkout did not add the application's sheet").toContain(sheetName);
      expect((await workingCopy(page))?.baseVersion).toBe("1.0.0");
    } finally {
      await newFile(page).catch(() => undefined);
    }
  });
});

interface CellTypeEntry {
  sheetIndex: number;
  row: number;
  col: number;
  typeId: string;
  params: Record<string, unknown> | null;
}

async function cellTypesOn(page: Page, sheetIdx: number): Promise<CellTypeEntry[]> {
  return invoke<CellTypeEntry[]>(page, "get_all_cell_types", { sheetIndex: sheetIdx });
}

/** The application a button cell's `fromApplication` stamp names, or null. */
function stampedApplication(params: Record<string, unknown> | null | undefined): string | null {
  const stamp = params?.fromApplication;
  if (!stamp || typeof stamp !== "object") return null;
  const application = (stamp as { application?: unknown }).application;
  return typeof application === "string" ? application : null;
}

// ===========================================================================
// 4. THE TIMELINE (BUG-0258 phase 1)
// ===========================================================================

/** Date / Product / Sales: one product per month, January to June 2026 (TEXT dates, see fixall-pivot TL-NUM). */
const TL6: Array<Array<string | number | null>> = [
  ["Date", "Product", "Sales"],
  ["'2026-01-10", "Apples", 1],
  ["'2026-02-05", "Pears", 2],
  ["'2026-03-10", "Plums", 4],
  ["'2026-04-20", "Kiwis", 8],
  ["'2026-05-03", "Figs", 16],
  ["'2026-06-15", "Limes", 32],
];
const SUM_SALES = { sourceIndex: 2, name: "Sum of Sales", aggregation: "sum" };
const ALL_PRODUCTS = ["Apples", "Figs", "Kiwis", "Limes", "Pears", "Plums"];
const MONTHS = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"];

interface TimelineRow {
  id: string;
  sheetIndex: number;
  selectionStart: string | null;
  selectionEnd: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface ClientPoint {
  x: number;
  y: number;
  part: string;
}

/** Row labels of a one-level pivot, in order, grand total left out. */
async function rowOrder(page: Page, pivotId: string): Promise<string[]> {
  const v = await pivotView(page, pivotId);
  const t = viewText(v);
  return v.rows.map((r, i) => (r.rowType === "Data" ? t[i][0] : null)).filter((x): x is string => x !== null);
}

async function timelineRow(page: Page, id: string): Promise<TimelineRow | null> {
  return (await callModule<TimelineRow | undefined>(page, TL.STORE, "getTimelineById", [id])) ?? null;
}

async function timelineRange(page: Page, id: string): Promise<string> {
  const t = await timelineRow(page, id);
  return t?.selectionStart ? `${t.selectionStart.slice(0, 7)}..${(t.selectionEnd ?? "").slice(0, 7)}` : "all";
}

/** Where the timeline is, in the extension's store. */
async function storeGeometry(page: Page, id: string): Promise<Rect | null> {
  const t = await timelineRow(page, id);
  return t ? { x: t.x, y: t.y, width: t.width, height: t.height } : null;
}

/** Where the timeline is, in the backend (what a save writes). */
async function persistedGeometry(page: Page, id: string): Promise<Rect | null> {
  const all = await invoke<TimelineRow[]>(page, "get_all_timeline_slicers");
  const t = all.find((x) => x.id === id);
  return t ? { x: t.x, y: t.y, width: t.width, height: t.height } : null;
}

async function periodStarts(page: Page, id: string): Promise<string[]> {
  const d = await callModule<{ periods?: Array<{ startDate: string }> } | undefined>(page, TL.STORE, "getCachedTimelineData", [id]);
  return (d?.periods ?? []).map((p) => p.startDate);
}

async function landed(page: Page): Promise<void> {
  await eventually(() => callModule<boolean>(page, TL.STORE, "isTimelineGestureLanding"), (v) => v === false, "the timeline selection never landed", 15_000);
  await page.waitForTimeout(300);
}

async function timelineSelected(page: Page, id: string): Promise<boolean> {
  return callModule<boolean>(page, TL.SELECTED, "isTimelineIdSelected", [id]);
}

/** A months timeline on a pivot's Date field, created the way Insert > Timeline does; waits for its six months. */
async function createMonthsTimeline(page: Page, opts: { name: string; sheetIndex: number; x: number; y: number; pivotId: string }): Promise<string> {
  const tl = await callModule<TimelineRow | null>(page, TL.STORE, "createTimelineAsync", [
    { name: opts.name, sheetIndex: opts.sheetIndex, x: opts.x, y: opts.y, width: 420, height: 140, sourceId: opts.pivotId, fieldName: "Date", level: "months" },
  ]);
  expect(tl, `precondition: the timeline "${opts.name}" was created`).toBeTruthy();
  await eventually(() => periodStarts(page, tl!.id), (p) => JSON.stringify(p) === JSON.stringify(MONTHS), `precondition: "${opts.name}" shows January-June 2026`, 15_000);
  await page.waitForTimeout(400);
  return tl!.id;
}

/**
 * The CLIENT point of a part of a timeline, computed from the zone table the
 * extension itself hit-tests with (lib/timelineZones.ts) on the timeline's
 * painted canvas bounds, and VERIFIED against the extension's own zone answer
 * before it is used -- so a press lands where the product says the month tile
 * (or the frame) is. `frame` is the header, or the year strip when the header
 * is hidden.
 */
async function timelinePoint(page: Page, tid: string, want: { period: number } | "frame"): Promise<ClientPoint> {
  await installAppImport(page);
  const r = await bounded(
    "timelinePoint",
    page.evaluate(
      async ({ tid, want, mods }) => {
        const w = window as unknown as AppWindow;
        type R = { x: number; y: number; width: number; height: number };
        const store = (await w.__appImport!(mods.store)) as { getTimelineById: (id: string) => R | undefined };
        const geo = (await w.__appImport!(mods.geo)) as { timelineCanvasBounds: (t: R) => R | null };
        const view = (await w.__appImport!(mods.view)) as {
          liveTimelineZoneInput: (id: string) => ({ periodCount: number; scrollOffset: number } & Record<string, unknown>) | null;
          timelineZoneAtCanvas: (id: string, cx: number, cy: number, b: R) => { part: string; kind: string; periodIndex?: number } | null;
        };
        const zones = (await w.__appImport!(mods.zones)) as {
          computeTimelineLayout: (shape: unknown, n: number) => {
            headerH: number;
            groupLabelH: number;
            yearStripTop: number;
            tileTop: number;
            tileBottom: number;
            periodWidth: number;
          };
          clampScroll: (layout: unknown, offset: number) => number;
        };
        const gridApi = (await w.__appImport!(mods.grid)) as { getGridStateSnapshot: () => { zoom?: number } | null };
        const tl = store.getTimelineById(tid);
        if (!tl) return { error: `no timeline ${tid} in the store` };
        const b = geo.timelineCanvasBounds(tl);
        const input = view.liveTimelineZoneInput(tid);
        if (!b || !input) return { error: "the timeline has no canvas bounds or zone input (not mounted?)" };
        const layout = zones.computeTimelineLayout(input, input.periodCount);
        const scroll = zones.clampScroll(layout, input.scrollOffset);
        const candidates: Array<{ relX: number; relY: number }> = [];
        if (want === "frame") {
          if (layout.headerH > 0) candidates.push({ relX: Math.round(b.width * 0.35), relY: Math.round(layout.headerH / 2) });
          candidates.push({ relX: Math.round(b.width * 0.35), relY: Math.round(layout.yearStripTop + layout.groupLabelH / 2) });
        } else {
          candidates.push({
            relX: Math.round((want.period + 0.5) * layout.periodWidth - scroll),
            relY: Math.round((layout.tileTop + layout.tileBottom) / 2),
          });
        }
        const areaEl = document.querySelector("[data-grid-area]");
        if (!areaEl) return { error: "no [data-grid-area]" };
        const area = areaEl.getBoundingClientRect();
        const zoom = gridApi.getGridStateSnapshot()?.zoom || 1;
        const seen: string[] = [];
        for (const c of candidates) {
          const cx = b.x + c.relX;
          const cy = b.y + c.relY;
          const z = view.timelineZoneAtCanvas(tid, cx, cy, b);
          seen.push(`${c.relX},${c.relY}=${z ? `${z.kind}/${z.part}${z.periodIndex !== undefined ? `#${z.periodIndex}` : ""}` : "none"}`);
          const ok = want === "frame" ? z?.kind === "frame" : z?.part === "period" && z.periodIndex === want.period;
          if (ok && z) return { x: area.left + cx * zoom, y: area.top + cy * zoom, part: z.part };
        }
        return { error: `no ${JSON.stringify(want)} point: ${seen.join("; ")}` };
      },
      { tid, want, mods: { store: TL.STORE, geo: TL.GEO, view: TL.VIEW, zones: TL.ZONES, grid: TL.GRID } },
    ),
  );
  const res = r as { error?: string; x?: number; y?: number; part?: string };
  if (res.error !== undefined || res.x === undefined || res.y === undefined) throw new Error(`timelinePoint: ${res.error ?? "no point"}`);
  return { x: res.x, y: res.y, part: res.part ?? "" };
}

async function gridAreaOrigin(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const el = document.querySelector("[data-grid-area]");
    if (!el) throw new Error("no [data-grid-area]");
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
}

async function gridZoom(page: Page): Promise<number> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { getGridStateSnapshot: () => { zoom?: number } | null };
    return m.getGridStateSnapshot()?.zoom || 1;
  }, TL.GRID);
}

/** A real pointer drag: press at `from`, move through `via` to `to` in steps, release. */
async function pointerDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, via: Array<{ x: number; y: number }> = []): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  for (const p of [...via, to]) await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** The canvas's contextual Canvas tab (Arrange lives there). */
async function openCanvasTab(page: Page): Promise<void> {
  const band = page.locator("[data-ribbon-content]");
  const strip = band.locator("xpath=..").locator("div").first();
  await strip.locator("button", { hasText: /^Canvas$/ }).first().click();
  await page.waitForTimeout(200);
}

/** The canvas's locked objects, as "kind:id", from the backend. */
async function lockedRefs(page: Page, canvasIndex: number): Promise<string[]> {
  const r = await invoke<{ sheets: Array<{ index: number; canvasLayout?: { locked?: Array<{ kind: string; id: string }> } }> }>(page, "get_sheets");
  return (r.sheets.find((s) => s.index === canvasIndex)?.canvasLayout?.locked ?? []).map((l) => `${l.kind}:${l.id}`);
}

async function canvasTimelineObject(page: Page, tid: string): Promise<{ selected: boolean; refKey: string | null } | null> {
  const o = (await objects(page)).find((x) => x.id === `timeline-slicer-${tid}`);
  return o ? { selected: o.selected, refKey: o.refKey } : null;
}

test.describe("owner follow-ups, live: the timeline's range drag (BUG-0258 phase 1)", () => {
  test("BUG-0258: a drag across three month tiles from the FIRST press on an unselected timeline selects those months, never moves it, and is ONE undo step; its header still moves it; LOCKED on a canvas it still filters and no longer moves", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(360_000);
    try {
      await newFile(page);
      await writeTable(page, TL6);
      expect((await cellAt(page, 0, 1, 0))?.type, "precondition: the dates are text").toBe("text");
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C7", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 1, name: "Product" }], valueFields: [SUM_SALES] });
      const pid2 = await createRangePivot(page, { sourceRange: "Sheet1!A1:C7", destinationCell: "I1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid2, rowFields: [{ sourceIndex: 1, name: "Product" }], valueFields: [SUM_SALES] });
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === JSON.stringify(ALL_PRODUCTS), "precondition: the pivot lists all six products");
      const tid = await createMonthsTimeline(page, { name: "Date", sheetIndex: 0, x: 470, y: 200, pivotId: pid });

      // A PREVIOUS selection for the undo to bring back: June, through the store's own non-asking door.
      await callModule(page, TL.STORE, "updateTimelineSelectionAsync", [tid, "2026-06-01", "2026-06-30"]);
      await landed(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-06..2026-06", "precondition: June is selected");
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["Limes"]', "precondition: June filters the pivot to Limes");

      // UNSELECTED before the first press. A cell selection change deselects a
      // timeline (selectionHandler.handleSelectionChange); B20 is clear of the
      // pivots (E1, I1) and of the timeline (x >= 470).
      if (await timelineSelected(page, tid)) {
        await grid.clickCell("B20");
        await page.waitForTimeout(400);
      }
      if (await timelineSelected(page, tid)) {
        await grid.clickCell("B22");
        await page.waitForTimeout(400);
      }
      expect(await timelineSelected(page, tid), "precondition: the timeline is not selected before the first press").toBe(false);

      // ---- CONTENT: press on February, drag across March to April, release.
      const geo0 = { store: await storeGeometry(page, tid), persisted: await persistedGeometry(page, tid) };
      const depth0 = (await undoState(page)).undoDepth;
      const feb = await timelinePoint(page, tid, { period: 1 });
      const mar = await timelinePoint(page, tid, { period: 2 });
      const apr = await timelinePoint(page, tid, { period: 3 });
      await pointerDrag(page, feb, apr, [mar]);
      await landed(page);
      await eventually(
        () => timelineRange(page, tid),
        (r) => r === "2026-02..2026-04",
        "the drag across February-April did not select those three months (BUG-0258: did the first press move the timeline instead?)",
      );
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["Kiwis","Pears","Plums"]', "the pivot is not filtered to February-April");
      expect(await storeGeometry(page, tid), "the range drag MOVED the timeline (store)").toEqual(geo0.store);
      expect(await persistedGeometry(page, tid), "the range drag MOVED the timeline (backend)").toEqual(geo0.persisted);
      expect((await undoState(page)).undoDepth, "the range drag is not exactly ONE undo step").toBe(depth0 + 1);
      expect.soft(await timelineSelected(page, tid), "the first press on the tiles did not also select the timeline").toBe(true);

      // ONE Ctrl+Z brings back the PREVIOUS selection, pivot included.
      await pressUndo(page);
      await landed(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-06..2026-06", "one Ctrl+Z did not bring back the previous selection (June)");
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["Limes"]', "one Ctrl+Z did not also bring back the pivot's June rows");
      expect.soft((await undoState(page)).undoDepth, "Ctrl+Z took back more or less than the drag").toBe(depth0);
      expect(await persistedGeometry(page, tid), "the undo moved the timeline").toEqual(geo0.persisted);

      // ---- FRAME: a drag on the header MOVES it, and changes no selection.
      const frame = await timelinePoint(page, tid, "frame");
      const start = await persistedGeometry(page, tid);
      const zoom = await gridZoom(page);
      const o0 = await gridAreaOrigin(page);
      await pointerDrag(page, frame, { x: frame.x + 60, y: frame.y + 40 }, [{ x: frame.x + 30, y: frame.y + 20 }]);
      const o1 = await gridAreaOrigin(page);
      // In sheet px. A contextual ribbon tab can shift the grid area while the
      // press selects the timeline; Core measures each pointer event against
      // the area as it is THEN, so a shift during the gesture changes the
      // delta. The move is accepted at the nominal delta or at the one
      // corrected for the measured shift -- never at "anything but zero".
      const nominal = { dx: 60 / zoom, dy: 40 / zoom };
      const corrected = { dx: (60 - (o1.x - o0.x)) / zoom, dy: (40 - (o1.y - o0.y)) / zoom };
      const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2;
      const moved = await eventually(
        () => persistedGeometry(page, tid),
        (g) =>
          !!g &&
          !!start &&
          (near(g.x - start.x, nominal.dx) || near(g.x - start.x, corrected.dx)) &&
          (near(g.y - start.y, nominal.dy) || near(g.y - start.y, corrected.dy)),
        `a drag on the timeline's ${frame.part} did not move it by (${nominal.dx.toFixed(1)}, ${nominal.dy.toFixed(1)}) ` +
          `[or, corrected for a grid shift, (${corrected.dx.toFixed(1)}, ${corrected.dy.toFixed(1)})] from ${JSON.stringify(start)}`,
      );
      expect({ width: moved!.width, height: moved!.height }, "the move resized the timeline").toEqual({ width: start!.width, height: start!.height });
      expect(await timelineRange(page, tid), "moving the timeline changed its selection").toBe("2026-06..2026-06");

      // ---- LOCKED, on a canvas page: a tile drag still filters (filtering is reading the report).
      const canvas = await addCanvas(page);
      const ci = await activate(page, canvas.name);
      const t2 = await createMonthsTimeline(page, { name: "Date (canvas)", sheetIndex: ci, x: 64, y: 64, pivotId: pid2 });
      await eventually(() => canvasTimelineObject(page, t2), (o) => o !== null, "the canvas timeline was never published as an object");
      const select = await timelinePoint(page, t2, "frame");
      await humanClick(page, select.x, select.y);
      const picked = await eventually(
        () => canvasTimelineObject(page, t2),
        (o) => o?.selected === true,
        "a click on the canvas timeline's frame did not select it",
      );
      await openCanvasTab(page);
      await clickRibbonTestId(page, "canvas-arrange-lock");
      await eventually(() => lockedRefs(page, ci), (refs) => !!picked?.refKey && refs.includes(picked.refKey), `Arrange > Lock did not lock the timeline (${picked?.refKey})`);

      // Unselect it again, so the tile drag is a first press on an unselected, LOCKED timeline.
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const stillSelected = (await canvasTimelineObject(page, t2))?.selected ?? false;
      if (stillSelected) console.log("[owner-followups] Escape did not unselect the canvas timeline; the tile drag starts on a SELECTED locked timeline");

      const g2 = await persistedGeometry(page, t2);
      const march = await timelinePoint(page, t2, { period: 2 });
      const april = await timelinePoint(page, t2, { period: 3 });
      const may = await timelinePoint(page, t2, { period: 4 });
      await pointerDrag(page, march, may, [april]);
      await landed(page);
      await eventually(
        () => timelineRange(page, t2),
        (r) => r === "2026-03..2026-05",
        "a tile drag on a LOCKED timeline did not filter (owner decision: only moving and resizing obey the lock)",
      );
      await eventually(() => rowOrder(page, pid2), (o) => JSON.stringify(o) === '["Figs","Kiwis","Plums"]', "the locked timeline's drag did not filter its pivot to March-May");
      expect(await persistedGeometry(page, t2), "the tile drag moved the LOCKED timeline").toEqual(g2);

      // POSITIVE CONTROL OF THE LOCK: its frame no longer moves it.
      const lockedFrame = await timelinePoint(page, t2, "frame");
      await pointerDrag(page, lockedFrame, { x: lockedFrame.x + 60, y: lockedFrame.y + 40 }, [{ x: lockedFrame.x + 30, y: lockedFrame.y + 20 }]);
      await page.waitForTimeout(900);
      expect(await persistedGeometry(page, t2), "a LOCKED timeline moved when its frame was dragged").toEqual(g2);
      expect(await timelineRange(page, t2), "the frame drag changed the locked timeline's selection").toBe("2026-03..2026-05");
      expect(await lockedRefs(page, ci), "the lock did not survive the gestures").toContain(picked!.refKey!);
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await newFile(page).catch(() => undefined);
    }
  });
});
