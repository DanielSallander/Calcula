/**
 * CALP BUTTON COMMANDS, LIVE -- plan_M8 Task A (BUG-0257 phase 5): a button
 * CELL that came with an application may run a Calcula COMMAND only when two
 * independent yeses agree -- Rust's (`DISTRIBUTABLE_BUTTON_COMMANDS`, EMPTY
 * today, then the approval under `button-commands:<application>` and the
 * working-copy private-sheet rule) and the page's (the command's LIVE
 * registration opts in with `distributableTrigger` and is not shadowed) -- and
 * only after `authorize_button_command` asks Rust again and writes the run row.
 *
 * WRITTEN AND TYPE-CHECKED ONLY (tsconfig.e2e.json); the main loop runs it.
 *
 *   BC-1  SUBSCRIBE. The publisher's application has one button cell that runs
 *         `cellTypes.clear` (not on the list) and one that runs the
 *         application's own macro. Subscribing through the REAL dialog names
 *         the command button in `[data-testid=subscribe-button-actions-removed]`
 *         ("not on Calcula's list ..."); the stored cell keeps its stamp and has
 *         NO action; the macro button keeps its action (POSITIVE CONTROL); a
 *         click on the disarmed button shows the door's "came with ... has no
 *         action" notice.
 *   BC-2  CHECKOUT. Opening the same version for editing HOLDS the command
 *         action (`heldAction`, no live `action`) and the click shows the
 *         door's held notice ("does not run in a working copy").
 *   BC-3  THE CLICK LAYER. In BC-1's subscriber workbook a stamped command
 *         action is written through `set_cell_type` -- a stamp only NARROWS
 *         what a click runs, so the write door accepts it -- with the stamp
 *         COPIED from BC-1's subscribed cell, so it decodes (a hand-made stamp
 *         that does not would be refused `stampUnreadable`/`triggerMismatch`
 *         and prove the wrong guard). The click is refused: with the
 *         production list empty it is RUST's door that refuses
 *         (`application_code_refused`, surface `buttonCommand`, reason
 *         `notAllowlisted`, `commandId` = cellTypes.clear) -- plan drift from
 *         plan_M8 S3, which predates the M6 button door and expected a page
 *         `button_code_refused` row -- and the cell is still a button cell, so
 *         `cellTypes.clear` (which clears the SELECTION's cell type, and the
 *         click first selects the button's own cell) did not run. POSITIVE
 *         CONTROL: the user's OWN button cell running `cellTypes.clear` does
 *         clear itself, so the negative has teeth.
 *
 * STATE AND DOM, NEVER PIXELS: `get_all_cell_types`, the audit log
 * (`getAuditLog`), the dialog's own test ids and the toast log.
 *
 * LIVE SABOTAGES for the main loop (NOT performed here; rebuild BETWEEN runs,
 * never during one):
 *   (a') make `application_code_gate::button_command_gate` skip BOTH its list
 *        step (1) and its approval step (2) -> the door answers `command` with
 *        the application, and the PAGE's flag check refuses instead: BC-3's
 *        `application_code_refused notAllowlisted` assertion goes red while the
 *        cell stays a button cell and a `button_code_refused` row (reason
 *        `commandNotAllowed`) appears -- the two layers are independent.
 *        (Skipping only the page's flag check in buttonCommandRun.ts /
 *        `judgeApplicationCommand` is a NO-OP under the empty production list:
 *        the door refuses first.)
 *   (b)  do (a') AND drop the flag step of `judgeApplicationCommand`
 *        (src/api/heldButtonCode.ts) -> `authorize_button_command` (the same
 *        gate, Admitted) admits, `cellTypes.clear` runs and clears the button:
 *        BC-3 goes red on "the cell is still a button cell". Confirm the
 *        sabotaged build really clears the cell (the positive control's own
 *        assertion) before counting it.
 *
 * SELF-CLEANING: one temp workspace removed first; application names carry a
 * per-run suffix; every test ends in File > New; `afterAll` forgets the
 * developer anchors this run's publishes recorded in the real profile.
 */

import type { Locator, Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";
import {
  COLLAB,
  activate,
  callModule,
  dismissToasts,
  eventually,
  invoke,
  newFile,
  renameSheetByName,
  sheetIndex,
  sheets,
  tryModule,
} from "../helpers/calp-harness";
import { checkout, publishNew } from "../helpers/calp-collab";
import { escapeRe, startToastLog, toastLog } from "../helpers/pivot-live";

const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), "calcula-calp-button-commands");
const WS = path.join(WORK, "workspace");
const CELL_TYPES = "/src/api/cellTypes.ts";
const DESIGN_MODE = "/src/api/designMode.ts";
const CREATED_APPS: string[] = [];

/** A command no list carries: it clears the SELECTION's cell type (the button's own, after the click selects it). */
const UNLISTED = "cellTypes.clear";

function ascii(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

function log(message: string): void {
  console.log(`[calp-button-commands] ${ascii(message)}`);
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

async function cellAt(page: Page, sheetIdx: number, row: number, col: number): Promise<CellTypeEntry | undefined> {
  return (await cellTypesOn(page, sheetIdx)).find((c) => c.row === row && c.col === col);
}

function stampedApplication(params: Record<string, unknown> | null | undefined): string | null {
  const stamp = params?.fromApplication;
  if (!stamp || typeof stamp !== "object") return null;
  const application = (stamp as { application?: unknown }).application;
  return typeof application === "string" ? application : null;
}

async function ensureRunMode(page: Page): Promise<void> {
  const design = await callModule<boolean>(page, DESIGN_MODE, "getDesignMode");
  if (design) await callModule(page, DESIGN_MODE, "setDesignMode", [false]);
  expect(await callModule<boolean>(page, DESIGN_MODE, "getDesignMode"), "precondition: Design Mode is off").toBe(false);
}

/** Leave the sheet and come back: the tab strip's route, which reloads its cell types. */
async function revisit(page: Page, name: string): Promise<number> {
  const other = (await sheets(page)).sheets.find((s) => s.name !== name);
  if (other) await activate(page, other.name);
  return activate(page, name);
}

async function waitForToast(page: Page, pattern: RegExp, label: string, ms = 20_000): Promise<string> {
  const seen = await eventually(() => toastLog(page), (t) => t.some((x) => pattern.test(x.text)), label, ms);
  return seen.find((x) => pattern.test(x.text))!.text;
}

interface AuditRow {
  event: string;
  description: string;
  [key: string]: unknown;
}

async function auditRows(page: Page): Promise<AuditRow[]> {
  const logged = await callModule<{ entries?: AuditRow[] }>(page, COLLAB, "getAuditLog");
  return logged.entries ?? [];
}

function describeRows(rows: AuditRow[]): string {
  return ascii(
    JSON.stringify(
      rows.map((r) => ({ event: r.event, reason: r.reason, surface: r.surface, commandId: r.commandId, application: r.application })),
    ),
  ).slice(0, 2000);
}

/** Answer any consent screen that appears, up to four. */
async function answerConsentPrompts(page: Page, choice: "Allow Scripts" | "Block", firstWaitMs = 4000): Promise<string[]> {
  const answered: string[] = [];
  let wait = firstWaitMs;
  for (let i = 0; i < 4; i++) {
    const shown = await page
      .getByRole("button", { name: "Allow Scripts", exact: true })
      .first()
      .waitFor({ state: "visible", timeout: wait })
      .then(
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

/**
 * The publisher: one sheet with a button cell at B2 that runs `cellTypes.clear`
 * and one at B4 that runs the application's own (module-runtime) macro.
 */
async function publishCommandApplication(page: Page, app: string, sheetName: string, appMacro: string): Promise<void> {
  await newFile(page);
  await renameSheetByName(page, "Sheet1", sheetName);
  const pub = await activate(page, sheetName);
  await invoke(page, "save_script", {
    script: {
      id: appMacro,
      name: "App macro",
      description: "e2e calp-button-commands (module runtime)",
      source: `Calcula.setCellValue(51, 25, 'APP-RAN-${RUN}');\n`,
      scope: { type: "workbook" },
    },
  });
  await callModule(page, CELL_TYPES, "setCellType", [1, 1, "calcula.button", { label: "Clear", action: { kind: "command", commandId: UNLISTED } }]);
  await callModule(page, CELL_TYPES, "setCellType", [3, 1, "calcula.button", { label: "Macro", action: { kind: "script", scriptId: appMacro } }]);
  const own = await cellTypesOn(page, pub);
  expect(
    own.filter((c) => c.typeId === "calcula.button" && c.params?.action).map((c) => `${c.row},${c.col}`),
    "precondition: the publisher's two button cells carry their actions",
  ).toEqual(["1,1", "3,1"]);
  const published = await publishNew(page, WS, app, "1.0.0");
  expect(published.version, `precondition: ${app} was published`).toBe("1.0.0");
  CREATED_APPS.push(app);
}

/** Click a button cell in run mode and wait until the click has been answered. */
async function clickButtonCell(page: Page, grid: GridHelper, ref: string): Promise<void> {
  await ensureRunMode(page);
  await dismissToasts(page);
  await startToastLog(page);
  await grid.clickCell(ref);
}

test.describe("calp button commands, live (plan_M8 Task A: the command list, the click, the approval)", () => {
  test.beforeAll(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
  });

  test.afterAll(async ({ sharedPage: page }) => {
    for (const app of CREATED_APPS) {
      const r = await tryModule(page, COLLAB, "forgetDeveloperAnchor", [WS, app]);
      log(`cleanup: forget the developer anchor of ${app}: ${r.ok ? JSON.stringify(r.value) : r.error}`);
    }
    await newFile(page).catch(() => undefined);
  });

  // BC-1 and BC-3 share ONE subscriber workbook: serial.
  test.describe.serial("BC-1 + BC-3: one subscriber workbook", () => {
    const app = `bc-commands-${RUN}`;
    const sheetName = `Cmds${RUN}`;
    const appMacro = `macro-bc-${RUN}`;
    let subscribed = false;

    test("BC-1: a subscribe REMOVES an application's button command that is not on Calcula's list, names it in the Subscribe dialog, keeps the stamp and the macro button's action, and a click says the button has no action", async ({
      appPage: page,
      grid,
    }) => {
      test.setTimeout(360_000);
      await withScriptsEnabled(page, async () => {
        await publishCommandApplication(page, app, sheetName, appMacro);

        // ---- The subscriber, through the REAL dialog.
        await newFile(page);
        const dialog = await subscribeThroughDialog(page, WS, app);
        const notice = dialog.locator('[data-testid="subscribe-button-actions-removed"]');
        const shown = await notice
          .waitFor({ state: "visible", timeout: 60_000 })
          .then(
            () => true,
            () => false,
          );
        if (!shown) {
          throw new Error(
            `the Subscribe dialog shows no removed-action notice; it says: ${ascii(await dialog.innerText().catch(() => "")).slice(0, 1500)}`,
          );
        }
        const noticeText = (await notice.innerText()).replace(/\s+/g, " ");
        expect(noticeText, "the notice does not name the command button").toContain(`${sheetName}!B2`);
        expect(noticeText, "the notice does not name the command").toContain(`'${UNLISTED}'`);
        expect(noticeText, "the notice does not say why: Calcula's list").toMatch(/not on Calcula's list of commands/);
        expect(noticeText, "the macro button (the application's own macro) was reported removed").not.toContain(`${sheetName}!B4`);
        const consent = await answerConsentPrompts(page, "Block", 2500);
        log(`BC-1: consent screens after the subscribe: ${JSON.stringify(consent)}`);
        await dialog.getByRole("button", { name: "Close" }).first().click();
        subscribed = true;

        // ---- The stored cells: B2 disarmed and stamped, B4 kept (POSITIVE CONTROL).
        const sub = await sheetIndex(page, sheetName);
        const command = await cellAt(page, sub, 1, 1);
        const macro = await cellAt(page, sub, 3, 1);
        expect(command?.typeId, "B2's button cell did not arrive").toBe("calcula.button");
        expect(command?.params?.action, "B2 arrived ARMED with a command not on Calcula's list").toBeUndefined();
        expect(command?.params?.heldAction, "a subscribe removes, never holds").toBeUndefined();
        expect(stampedApplication(command?.params), "B2 is not stamped with its application").toBe(app);
        expect(macro?.params?.action, "POSITIVE CONTROL: the button naming the application's own macro lost its action").toEqual({
          kind: "script",
          scriptId: appMacro,
        });

        // ---- The click: the door's own notice.
        await revisit(page, sheetName);
        await callModule(page, CELL_TYPES, "refreshCellTypeAssignments");
        await clickButtonCell(page, grid, "B2");
        await waitForToast(
          page,
          new RegExp(`came with the application '${escapeRe(app)}' and has no action`),
          "clicking the disarmed command button showed no notice naming its application",
        );
      });
    });

    test("BC-3: a stamped command written through set_cell_type is refused at the click by Rust's command gate (notAllowlisted, recorded) and cellTypes.clear never runs; the user's own button running it does (POSITIVE CONTROL)", async ({
      appPage: page,
      grid,
    }) => {
      test.setTimeout(240_000);
      test.skip(!subscribed, "BC-1 did not leave a subscribed workbook");
      try {
        await withScriptsEnabled(page, async () => {
          const sub = await activate(page, sheetName);
          const subscribedCell = await cellAt(page, sub, 1, 1);
          const stamp = subscribedCell?.params?.fromApplication;
          expect(stampedApplication(subscribedCell?.params), "precondition: BC-1's subscribed cell carries a decodable stamp").toBe(app);

          // ---- A stamped command action, through the write door: D2 gets
          // BC-1's stamp, COPIED, and the command.
          await callModule(page, CELL_TYPES, "setCellType", [
            1,
            3,
            "calcula.button",
            { label: "Stamped", action: { kind: "command", commandId: UNLISTED }, fromApplication: stamp },
          ]);
          const written = await cellAt(page, sub, 1, 3);
          expect(written?.params?.action, "the write door refused a stamped command action").toEqual({ kind: "command", commandId: UNLISTED });
          expect(stampedApplication(written?.params), "the copied stamp was not kept").toBe(app);

          const before = await auditRows(page);
          await revisit(page, sheetName);
          await callModule(page, CELL_TYPES, "refreshCellTypeAssignments");
          await clickButtonCell(page, grid, "D2");
          const said = await waitForToast(
            page,
            /APPLICATION_COMMAND_NOT_ALLOWED|not on Calcula's list of commands a button from an application may run/,
            "the click on a stamped command button was not refused in Calcula's words",
          );
          log(`refusal toast: ${said}`);

          // Rust's door refused it, and wrote the row.
          const rows = await eventually(
            () => auditRows(page),
            (r) => r.length > before.length && r.some((x) => x.event === "application_code_refused" && x.commandId === UNLISTED),
            "no application_code_refused row for the stamped command",
            20_000,
          );
          const refused = rows.filter((r) => r.event === "application_code_refused" && r.commandId === UNLISTED);
          expect(refused.length, `rows: ${describeRows(rows.slice(before.length))}`).toBeGreaterThan(0);
          const last = refused[refused.length - 1];
          expect(last.reason, `rows: ${describeRows(refused)}`).toBe("notAllowlisted");
          expect(last.surface).toBe("buttonCommand");
          expect(last.application).toBe(app);
          expect(
            rows.slice(before.length).some((r) => r.event === "application_code_run"),
            "a run row was written for a command that was refused",
          ).toBe(false);

          // ...and cellTypes.clear never ran: D2 is still a button cell.
          await page.waitForTimeout(1500);
          const after = await cellAt(page, sub, 1, 3);
          expect(after?.typeId, "the application's button ran cellTypes.clear (its own cell type is gone)").toBe("calcula.button");

          // ---- POSITIVE CONTROL: the user's OWN button cell running the same
          // command clears itself -- the negative above has teeth.
          await callModule(page, CELL_TYPES, "setCellType", [5, 3, "calcula.button", { label: "Mine", action: { kind: "command", commandId: UNLISTED } }]);
          await revisit(page, sheetName);
          await callModule(page, CELL_TYPES, "refreshCellTypeAssignments");
          await clickButtonCell(page, grid, "D6");
          await eventually(
            () => cellAt(page, sub, 5, 3),
            (c) => c === undefined || c.typeId !== "calcula.button",
            "POSITIVE CONTROL: the user's own button running cellTypes.clear did not clear its cell type",
            20_000,
          );
        });
      } finally {
        await newFile(page).catch(() => undefined);
      }
    });
  });

  test("BC-2: a checkout HOLDS the application's command action (heldAction, no live action) and a click shows the held notice", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(360_000);
    const app = `bc-held-${RUN}`;
    const sheetName = `Held${RUN}`;
    const appMacro = `macro-bch-${RUN}`;
    try {
      await withScriptsEnabled(page, async () => {
        await publishCommandApplication(page, app, sheetName, appMacro);
        await newFile(page);
        const opened = await checkout(page, WS, app);
        expect(opened.version, "precondition: the checkout opened 1.0.0").toBe("1.0.0");
        await answerConsentPrompts(page, "Block");

        const dev = await sheetIndex(page, sheetName);
        const command = await cellAt(page, dev, 1, 1);
        expect(command?.typeId).toBe("calcula.button");
        expect(command?.params?.action, "a checkout left a command not on Calcula's list LIVE").toBeUndefined();
        expect(command?.params?.heldAction, "a checkout did not HOLD the command action").toEqual({ kind: "command", commandId: UNLISTED });
        expect(stampedApplication(command?.params)).toBe(app);

        await revisit(page, sheetName);
        await callModule(page, CELL_TYPES, "refreshCellTypeAssignments");
        await clickButtonCell(page, grid, "B2");
        await waitForToast(page, /does not run in a working copy/, "clicking the held command button showed no held notice");
        expect((await cellAt(page, dev, 1, 1))?.typeId, "the held command ran (cellTypes.clear cleared the button)").toBe("calcula.button");
      });
    } finally {
      await newFile(page).catch(() => undefined);
    }
  });
});
