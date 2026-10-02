/**
 * PROMOTION CODE SUMMARY -- plan_M8 Task B (S4 + S5, BUG-0257 phase 5), live.
 *
 * WHAT IS PROVED, on one workspace on disk:
 *   PC-1  A FIRST promotion (prod holds nothing) reads the impact and shows the
 *         CODE first: the macro is listed as new, and everyone in prod is asked
 *         to approve it. (The dialog used to skip the impact read entirely when
 *         the environment had no version.)
 *   PC-2  The native confirm NAMES the code that changes. Answered NO, nothing
 *         moves (calp_environments still shows prod empty); answered YES, prod
 *         is at v1.0.0.
 *   PC-3  After v1.1.0 changes the macro and adds an object script that
 *         declares net.fetch, Promote for prod lists BOTH, the object-script row
 *         says it gains net.fetch, and the headline says everyone in prod will
 *         be asked to approve the application's code AGAIN. Answered NO, prod
 *         stays at v1.0.0.
 *
 * NOT RUN BY ITS AUTHOR (plan_M8 job rule: type-checked only). For the main
 * loop:
 *   - The native confirm is answered over Win32 by e2e/answer-native-dialog.ps1,
 *     titled by `describePromotion` ("Promote to prod"). The click that raises
 *     it is AWAITED before the synchronous driver starts (an unawaited call
 *     before execFileSync is never sent).
 *   - LIVE SABOTAGE: make `promotion_impact_core` (app/src-tauri/src/
 *     calp_environments.rs) return no code rows -- e.g. replace the
 *     `promotion_code_summary(..)` match with `(Vec::new(), false, None)` --
 *     rebuild, and PC-1's and PC-3's row assertions go red ("the macro has no
 *     row"). Restore, rebuild, green again.
 *
 * GRID REAL ESTATE: a fresh File > New workbook; cells GA1..GA2 only.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { API, callModule, eventually, invoke, newFile, saveAs } from "../helpers/calp-harness";
import { publishNew } from "../helpers/calp-collab";

const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), "calcula-promotion-code-summary");
const WS = path.join(WORK, "workspace");
const FILE_DEV = path.join(WORK, "dev.cala");
const APP = `promo-code-${RUN}`;
const MACRO_ID = `macro-report-${RUN}`;
const OBJECT_SCRIPT_ID = `obj-fetch-${RUN}`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_DRIVER = path.join(HERE, "..", "answer-native-dialog.ps1");
/** `describePromotion`'s title for a promotion into prod. */
const CONFIRM_TITLE = "Promote to prod";
/** `PROMOTE_DIALOG_ID`, app/extensions/Collaboration/manifest.ts. */
const PROMOTE_DIALOG_ID = "collaboration:promoteDialog";

function log(line: string): void {
  console.log(`[promotion-code-summary] ${line}`);
}

// ---------------------------------------------------------------------------
// Native confirm (tauri-plugin-dialog -> Win32), driven from outside
// ---------------------------------------------------------------------------

function answerNativeDialogRaw(titleLike: string, action: "ok" | "cancel", waitMs = 20_000): string {
  if (!fs.existsSync(DIALOG_DRIVER)) {
    throw new Error(`the native-dialog driver is missing at ${DIALOG_DRIVER}`);
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

/** The caller must already have AWAITED the gesture that raises it: this blocks Node. */
function answerNativeDialog(titleLike: string, action: "ok" | "cancel"): { text: string; clicked: string } {
  const lines = answerNativeDialogRaw(titleLike, action)
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

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

interface EnvironmentsResponse {
  headVersion: string;
  environments: Array<{ name: string; version: string | null }>;
}

async function environments(page: Page): Promise<EnvironmentsResponse> {
  return invoke<EnvironmentsResponse>(page, "calp_environments", { params: { registryPath: WS, packageName: APP } });
}

async function versionOf(page: Page, name: string): Promise<string | null> {
  return (await environments(page)).environments.find((e) => e.name === name)?.version ?? null;
}

async function saveMacro(page: Page, source: string): Promise<void> {
  await invoke(page, "save_script", {
    script: { id: MACRO_ID, name: "Report", description: "e2e promotion-code-summary", source, scope: { type: "workbook" } },
  });
}

async function promoteTest(page: Page, version: string, current: string): Promise<void> {
  await invoke(page, "calp_promote", {
    params: { registryPath: WS, packageName: APP, environment: "test", version, checkCurrent: true, expectedCurrent: current },
  });
}

/** Open the real Promote dialog for prod, the way the Explorer's row does. */
async function openPromoteForProd(page: Page): Promise<Locator> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await invoke(page, "calp_environments", { params: { registryPath: WS, packageName: APP } });
  await callModule(page, API, "showDialog", [
    PROMOTE_DIALOG_ID,
    { registryPath: WS, packageName: APP, environment: "prod", mode: "promote" },
  ]);
  const summary = page.locator("[data-promotion-code]");
  await expect(summary, "the Promote dialog shows no code summary").toBeVisible({ timeout: 20_000 });
  await expect(summary, "the code comparison did not finish").not.toHaveAttribute("data-promotion-code", "loading", { timeout: 30_000 });
  return summary;
}

async function closePromote(page: Page): Promise<void> {
  const close = page.getByRole("button", { name: /^(Cancel|Close)$/ }).last();
  if ((await close.count()) > 0) await close.click().catch(() => undefined);
  await page.waitForTimeout(400);
}

function promoteButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Promote…$/ }).last();
}

// ===========================================================================

test.describe.serial("promotion code summary -- the code comes first, on a first promotion too", () => {
  test.beforeAll(() => {
    if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
  });

  test("PC-1/PC-2: a FIRST promotion lists the macro as new; the confirm names it; No moves nothing, Yes promotes", async ({
    appPage: page,
  }) => {
    test.setTimeout(360_000);
    // Leftovers from a crashed run would be answered instead of ours.
    answerNativeDialogRaw(CONFIRM_TITLE, "cancel", 1200);

    await newFile(page);
    await invoke(page, "update_cell", { row: 0, col: 182, value: "v1" });
    await saveMacro(page, "Calcula.setCellValue(1, 182, 'ran v1');\n");
    await saveAs(page, FILE_DEV);
    await publishNew(page, WS, APP, "1.0.0");
    await invoke(page, "calp_set_environments", {
      params: { registryPath: WS, packageName: APP, environments: ["test", "prod"], expectedSequence: 0 },
    });
    await promoteTest(page, "1.0.0", "");
    expect(await versionOf(page, "prod"), "precondition: prod holds nothing").toBeNull();

    try {
      const summary = await openPromoteForProd(page);
      await expect(summary).toHaveAttribute("data-promotion-code", "ready");
      const headline = (await page.locator("[data-promotion-code-headline]").innerText()).trim();
      log(`PC-1 headline: ${headline}`);
      expect(headline, "a first promotion's headline").toContain("will be asked to approve this application's code before it runs");
      const row = page.locator(`[data-promotion-code-row="${MACRO_ID}"]`);
      await expect(row, "the macro has no row").toBeVisible();
      await expect(row).toHaveAttribute("data-promotion-code-kind", "macro");
      await expect(row).toHaveAttribute("data-promotion-code-change", "added");
      await expect(row).toHaveAttribute("data-promotion-code-consequence", "asksApprovalAgain");

      // PC-2: NO first -- the click is awaited before the synchronous driver.
      await promoteButton(page).click();
      const no = answerNativeDialog(CONFIRM_TITLE, "cancel");
      log(`PC-2 confirm (NO): ${no.clicked} :: ${no.text.slice(0, 300)}`);
      expect(no.clicked, "the promotion confirm never appeared or was not answered").toMatch(/^CLICKED:/);
      expect(no.text, "the confirm does not name the code it carries").toContain('Code it carries: macro "Report"');
      await page.waitForTimeout(1500);
      expect(await versionOf(page, "prod"), "answering NO moved prod").toBeNull();

      await promoteButton(page).click();
      const yes = answerNativeDialog(CONFIRM_TITLE, "ok");
      log(`PC-2 confirm (YES): ${yes.clicked}`);
      expect(yes.clicked).toMatch(/^CLICKED:/);
      await eventually(() => versionOf(page, "prod"), (v) => v === "1.0.0", "prod after answering YES", 20_000);
    } finally {
      answerNativeDialogRaw(CONFIRM_TITLE, "cancel", 1200);
      await closePromote(page);
    }
  });

  test("PC-3: v1.1.0 changes the macro and adds an object script that gains net.fetch; both are listed and prod is asked again", async ({
    appPage: page,
  }) => {
    test.setTimeout(360_000);
    await saveMacro(page, "Calcula.setCellValue(1, 182, 'ran v2');\n");
    await invoke(page, "save_object_script", {
      script: {
        id: OBJECT_SCRIPT_ID,
        name: "Fetcher",
        objectType: "workbook",
        instanceId: null,
        source: "// @capability net.fetch https://example.com\nfunction setup(context) {}\n",
        accessLevel: "restricted",
        description: null,
        provenance: null,
        packageName: null,
        packageVersion: null,
      },
    });
    await invoke(page, "update_cell", { row: 0, col: 182, value: "v2" });
    await saveAs(page, FILE_DEV);
    await invoke(page, "calp_publish", {
      params: {
        registryPath: WS,
        packageName: APP,
        version: "1.1.0",
        kind: "report",
        sheetIndices: [],
        publishedBy: "",
        includeComments: false,
        mode: "update",
        expectedBaseVersion: "1.0.0",
        changeSummary: "the macro changes; a fetcher arrives",
      },
    });
    await promoteTest(page, "1.1.0", "1.0.0");
    expect(await versionOf(page, "prod")).toBe("1.0.0");

    try {
      const summary = await openPromoteForProd(page);
      await expect(summary).toHaveAttribute("data-promotion-code", "ready");
      const headline = (await page.locator("[data-promotion-code-headline]").innerText()).trim();
      log(`PC-3 headline: ${headline}`);
      expect(headline).toContain("Everyone in prod will be asked to approve this application's code again before it runs");

      const macro = page.locator(`[data-promotion-code-row="${MACRO_ID}"]`);
      await expect(macro, "the changed macro has no row").toBeVisible();
      await expect(macro).toHaveAttribute("data-promotion-code-change", "modified");
      await expect(macro).toHaveAttribute("data-promotion-code-consequence", "asksApprovalAgain");

      const fetcher = page.locator(`[data-promotion-code-row="${OBJECT_SCRIPT_ID}"]`);
      await expect(fetcher, "the new object script has no row").toBeVisible();
      await expect(fetcher).toHaveAttribute("data-promotion-code-kind", "objectScript");
      await expect(fetcher).toHaveAttribute("data-promotion-code-change", "added");
      await expect(fetcher.locator("[data-promotion-code-capabilities]")).toHaveText("It gains net.fetch.");

      // The code section comes before the cell diff.
      const order = await page.evaluate(() => {
        const code = document.querySelector("[data-promotion-code]");
        const heading = [...document.querySelectorAll("div")].find((d) => /will see change$/.test(d.textContent?.trim() ?? ""));
        if (!code || !heading) return "missing";
        return code.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING ? "code-first" : "diff-first";
      });
      expect(order, "the code summary is not shown first").toBe("code-first");

      await promoteButton(page).click();
      const no = answerNativeDialog(CONFIRM_TITLE, "cancel");
      log(`PC-3 confirm (NO): ${no.clicked} :: ${no.text.slice(0, 400)}`);
      expect(no.clicked).toMatch(/^CLICKED:/);
      expect(no.text).toContain('macro "Report" (changed)');
      expect(no.text).toContain("gains net.fetch");
      expect(no.text).toContain("asked to approve this application's code again");
      await page.waitForTimeout(1500);
      expect(await versionOf(page, "prod"), "answering NO moved prod").toBe("1.0.0");
    } finally {
      answerNativeDialogRaw(CONFIRM_TITLE, "cancel", 1200);
      await closePromote(page);
      await newFile(page).catch(() => undefined);
    }
  });
});
