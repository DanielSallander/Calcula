/**
 * MACRO RECORDER × BI MODEL — the record→replay loop, proved live.
 *
 * The design (docs/design/macro-model-recording-and-fused-cli.md, Feature 1)
 * shipped with Rust unit tests for the capture diff, vitest for the codegen,
 * and mirror tests pinning the kind tables together — but the loop's CLAIM is
 * end-to-end: a user records, edits the model, stops, and later presses Run,
 * and the model edit comes back through the consent-gated `bi.model` gateway.
 * This journey drives exactly that, through the real menus, the real Rust
 * capture hook, the real module store and the real JIT consent dialog.
 *
 * THE PROBES, AND WHY THEY HAVE TEETH
 *
 *   "did the Rust hook ARM?"        -> `macro_model_recording_armed` polled
 *                                      true after Start and false after Stop —
 *                                      the entry-point-live discipline (this
 *                                      recorder shipped dead entry points once).
 *   "did capture SEE the edits?"    -> the status-bar indicator's action count,
 *                                      polled 1 → 2 → 3 after the grid edit,
 *                                      the measure upsert and the role upsert.
 *                                      The count is read from the DOM, never by
 *                                      importing the session module — a fresh
 *                                      import would be a phantom instance with
 *                                      its own idle state (the Vite ?t= trap
 *                                      consent-refusal.spec.ts documents).
 *   "is the SOURCE right?"          -> the STORED module (get_script), not the
 *                                      dialog echo: pragma, exactly ONE
 *                                      caps.biModel.upsert, the grid write, the
 *                                      role redacted to a NOT REPLAYABLE
 *                                      comment WITHOUT its name, and no trace
 *                                      of the model edit made while NOT
 *                                      recording.
 *   "does REPLAY work?"             -> delete the measure, clear the cell, Run
 *                                      from Developer ▸ Macros…, answer the
 *                                      bi.model JIT consent, and poll the
 *                                      BACKEND until both come back.
 *
 * HOW THE TWO EDIT KINDS ARE DRIVEN — this is load-bearing, not convenience:
 *
 *   GRID edit  — typed through the canvas. The recorder's grid hook sits on
 *                the TS IPC bridge (setGridRecorderHook in core/lib/tauri-api),
 *                so a raw `__TAURI__.core.invoke("update_cell")` is INVISIBLE
 *                to it. Typing is the only honest entry — and conversely, raw
 *                invokes are how this spec's cleanup writes cells without
 *                polluting a recording.
 *   MODEL edit — a raw `__TAURI__.core.invoke("bi_model_upsert_measure")`.
 *                The capture hook is in RUST, below emit_model_changed
 *                (bi/macro_capture.rs), and `bi_model_*` commands accept the
 *                MAIN window (window guard MAIN_AND_MODEL_EDITOR) — so this
 *                exercises the real capture path without opening the Model
 *                Editor window at all.
 *
 * THE MEASURE FORMULA IS `1+1`, DELIBERATELY. The model is created blank
 * (bi_model_create_blank — no tables, no columns), and upsert_measure_model
 * exempts pure constants from home-table resolution ("Pure constants (e.g.
 * BLANK(), 42) legitimately have no table"). A column-form measure like
 * SUM(T[c]) would need a seeded table, which no main-window command provides
 * without a data source. Constants keep the journey self-contained; the DAX
 * text is invariant, so the sv-SE ';' separator gotcha never applies (and the
 * typed grid value "42" carries no separator either).
 *
 * CONSENT SURFACES. Script Security is set to "enabled" up front, which makes
 * ensureScriptsAllowed a no-op and isolates the bi.model capability gate as
 * the ONLY consent in play (consent-refusal.spec.ts precedent). That gate's
 * dialog is in-app DOM (ScriptableObjects/CapabilityRequestDialog — the text
 * "A script is asking for access it does not yet have", buttons Deny / Allow
 * once / Allow always), so no Win32 dialog driver is needed anywhere in this
 * journey. The prompt must be answered PROMPTLY: the run-once mount has a
 * 10-second deadline, and a consent left hanging becomes "was still running
 * after 10 seconds" — the settle loop below polls every 200ms.
 *
 * SHARED APP, JOURNEY PROJECT. This spec starts with newFile (that is why it
 * lives in e2e/journeys and not e2e/tests), owns cell D18 afterwards, and
 * removes everything it creates — the macro module, the BI connection, the
 * armed flag, a recording a crashed run left live — in a finally.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";

// ---------------------------------------------------------------------------
// What this spec owns
// ---------------------------------------------------------------------------

/** The one grid cell the macro writes (0-based backend coordinates). */
const CELL = { ref: "D18", row: 17, col: 3, typed: "42" } as const;

/** Every macro this spec records carries this prefix, so cleanup finds strays. */
const MACRO_PREFIX = "ModelRecE2E";

/** The blank BI model / connection name (cleanup deletes by this name). */
const MODEL_NAME = "MacroModelE2E";

/** The replayable model edit. */
const MEASURE = "E2EMeasure";
const MEASURE_FORMULA = "1+1";

/** The privileged model edit — its NAME must never reach the generated source
 *  (role names are privileged; see sanitized_model_info / macro_capture.rs). */
const ROLE = "SecretRoleE2E";

// Resolved during the journey; read by the finally-cleanup.
let connectionId: string | null = null;
let macroId: string | null = null;

// ---------------------------------------------------------------------------
// Backend plumbing (setup + assertions — never the thing under test, except
// where the comment above says a raw invoke IS the real entry point)
// ---------------------------------------------------------------------------

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

/** The file-api helper (newFile), same idiom as floating-range.spec.ts. */
async function fileApi<T = unknown>(page: Page, fn: string, arg?: string): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const mod = await (
        window as unknown as {
          __calcImport: (u: string) => Promise<Record<string, (a?: unknown) => Promise<unknown>>>;
        }
      ).__calcImport(new URL("/src/core/lib/file-api.ts", document.baseURI).href);
      return (await mod[fn](arg)) as unknown;
    },
    { fn, arg },
  ) as Promise<T>;
}

/** Script Security "enabled" -> the global mount gate is a silent no-op, so the
 *  bi.model capability consent is the ONLY gate this journey exercises. */
async function allowScripts(page: Page): Promise<void> {
  await invoke(page, "set_script_security_level", { level: "enabled" });
}

/** The measure names the connection's model holds right now. */
async function measureNames(page: Page): Promise<string[]> {
  if (!connectionId) return [];
  const list = await invoke<Array<{ name: string }>>(page, "bi_model_get_measures", {
    connectionId,
  });
  return list.map((m) => m.name);
}

/** The owned cell's display value, straight from the engine. */
async function cellDisplay(page: Page): Promise<string> {
  return page.evaluate(
    async ({ row, col }) => {
      const tauri = (window as any).__TAURI__;
      const cell = await tauri.core.invoke("get_cell", { row, col });
      return String(cell?.display ?? cell?.value ?? "");
    },
    { row: CELL.row, col: CELL.col },
  );
}

/** Clear the owned cell WITHOUT the recorder seeing it (raw invoke bypasses the
 *  TS bridge the grid hook observes — here that blindness is the tool). */
async function clearCellUnrecorded(page: Page): Promise<void> {
  await page.evaluate(
    async ({ row, col }) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_cell", { row, col, value: "" }).catch(() => {});
      window.dispatchEvent(new Event("grid:refresh"));
    },
    { row: CELL.row, col: CELL.col },
  );
  await page.waitForTimeout(150);
}

/** Whether the Rust-side capture hook is armed (the boolean the recorder's
 *  install/uninstall toggles through macro_model_recording_set_armed). */
async function captureArmed(page: Page): Promise<boolean> {
  return invoke<boolean>(page, "macro_model_recording_armed");
}

/** The action count the status-bar indicator shows, or -1 while idle. Read
 *  from the DOM on purpose — importing the session module here would create a
 *  phantom instance whose state is forever idle (the ?t= HMR trap). */
async function recordedActionCount(page: Page): Promise<number> {
  const el = page.locator("[data-macro-recorder-indicator]");
  if ((await el.count()) === 0) return -1;
  if (!(await el.first().isVisible().catch(() => false))) return -1;
  const text = (await el.first().innerText()).replace(/\s+/g, " ");
  const m = /(\d+) action/.exec(text);
  return m ? Number(m[1]) : -1;
}

/** Substring occurrence count (for "exactly one gateway call"). */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Recorder lifecycle guards
// ---------------------------------------------------------------------------

/**
 * End a recording session left running by a FAILED earlier run.
 *
 * The recorder is a singleton with a TOGGLED menu item ("Record Macro…" /
 * "Stop Recording"), so a session that outlives its test renames the entry
 * point this spec starts from and every later run fails at `/^Record Macro/`
 * looking like a missing menu item. macro-recorder-journey.spec.ts and
 * macro-live-edit.spec.ts both carry this guard; a spec that ARMS the Rust
 * capture needs it twice over, because a leaked session also leaves
 * MODEL_RECORDING_ARMED true for every later spec in the app instance.
 */
async function ensureNotRecording(page: Page): Promise<void> {
  const indicator = page.locator("[data-macro-recorder-indicator]");
  if ((await indicator.count()) === 0) return;
  if (!(await indicator.first().isVisible().catch(() => false))) return;

  await indicator
    .locator("button")
    .filter({ hasText: /^Stop$/ })
    .first()
    .click()
    .catch(() => {});

  // Stopping opens the review dialog; the recording it describes is abandoned
  // state, and cleanupArtifacts deletes whatever module it wrote on the way out.
  const result = page.locator("[data-macro-result-dialog]");
  await result.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await result.locator("[data-macro-result-close]").first().click().catch(() => {});
  await result.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(150);
}

/**
 * Remove everything this spec creates. Idempotent and failure-tolerant — runs
 * BEFORE the journey (a crashed previous run must not poison this one) and
 * again in the finally.
 */
async function cleanupArtifacts(page: Page): Promise<void> {
  await ensureNotRecording(page);
  await page.evaluate(
    async (a) => {
      const tauri = (window as any).__TAURI__;

      // 1. Macro modules this spec (or a crashed run of it) saved.
      try {
        const modules: Array<{ id: string; name: string }> =
          await tauri.core.invoke("list_scripts");
        for (const m of modules) {
          if (m.name && m.name.startsWith(a.prefix)) {
            await tauri.core.invoke("delete_script", { id: m.id }).catch(() => {});
          }
        }
      } catch {
        /* no module store yet */
      }

      // 2. The blank BI connection (removing it also removes its measures).
      try {
        const conns: Array<{ id: string; name: string }> =
          await tauri.core.invoke("bi_get_connections");
        for (const c of conns) {
          if (c.name === a.model) {
            await tauri.core.invoke("bi_delete_connection", { connectionId: c.id }).catch(() => {});
          }
        }
      } catch {
        /* BI state not up */
      }

      // 3. The armed flag — a belt for the case where the session died between
      //    arm and disarm (the indicator guard above covers the normal path).
      await tauri.core
        .invoke("macro_model_recording_set_armed", { armed: false })
        .catch(() => {});

      // 4. The owned cell.
      await tauri.core
        .invoke("update_cell", { row: a.row, col: a.col, value: "" })
        .catch(() => {});
      window.dispatchEvent(new Event("grid:refresh"));
    },
    { prefix: MACRO_PREFIX, model: MODEL_NAME, row: CELL.row, col: CELL.col },
  );
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// Developer-menu entries (same idiom as macro-recorder-journey.spec.ts)
// ---------------------------------------------------------------------------

async function openRecordDialog(page: Page, grid: GridHelper): Promise<Locator> {
  await grid.openMenu("Developer");
  const item = page.locator("button").filter({ hasText: /^Record Macro/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  const dialog = page.locator("[data-macro-start-dialog]");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  return dialog;
}

async function openMacroLibrary(page: Page, grid: GridHelper): Promise<Locator> {
  await grid.openMenu("Developer");
  const item = page.locator("button").filter({ hasText: /^Macros/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  const library = page.locator("[data-macro-library-dialog]");
  await expect(library).toBeVisible({ timeout: 10_000 });
  return library;
}

// ---------------------------------------------------------------------------
// The replay settle loop: Run + JIT consent + outcome, with named diagnostics
// ---------------------------------------------------------------------------

/**
 * Press Run and settle the run to its outcome.
 *
 * Three things can happen after Run, and each is handled where it is seen:
 *   - the bi.model JIT consent dialog appears -> click "Allow once" PROMPTLY
 *     (the run-once mount's 10s deadline is ticking underneath the prompt);
 *   - the library dialog reports an error     -> throw WITH its text, plus the
 *     one diagnosis a reader will need: "did not declare bi.model" means the
 *     run-once mount did not thread the source's `// @capability` pragma into
 *     the R19 declared-capability ceiling — a product gap in the replay path,
 *     not a harness fault;
 *   - `probe()` turns true                    -> the replay landed.
 *
 * Returns whether the consent prompt was seen. The caller asserts it WAS: the
 * transient run-once script id is unique per run, so no persisted grant can
 * exist for it — a replay that succeeds without ever prompting means the
 * capability was granted without asking, which is the fail-open shape this
 * program keeps hunting (consent-refusal.spec.ts is the sibling proof).
 */
async function runAndSettle(
  page: Page,
  library: Locator,
  probe: () => Promise<boolean>,
): Promise<boolean> {
  const prompt = page.getByText("A script is asking for access it does not yet have");
  const errorBox = library.locator("[data-macro-error]");

  await library.locator("[data-macro-run-button]").click();

  const deadline = Date.now() + 45_000;
  let consentSeen = false;
  while (Date.now() < deadline) {
    if (!consentSeen && (await prompt.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "Allow once", exact: true }).click();
      await prompt.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
      consentSeen = true;
      continue;
    }
    if (
      (await errorBox.count()) > 0 &&
      (await errorBox.first().isVisible().catch(() => false))
    ) {
      const text = (await errorBox.first().innerText().catch(() => "")).trim();
      if (text) {
        throw new Error(
          "Run reported an error instead of replaying the macro" +
            (consentSeen
              ? " (AFTER the bi.model consent was granted)"
              : " (no bi.model consent prompt ever appeared)") +
            `:\n--- ${text}\n` +
            'If the text says the script "did not declare" the bi.model capability, the ' +
            "run-once mount (runObjectScriptOnce -> hostMountScript) is not threading the " +
            "macro source's `// @capability bi.model` pragma into the declared-capability " +
            "ceiling (R19) — the broker then denies before the JIT gate may even prompt. " +
            "That is a product gap in the record→replay loop, not a harness fault.",
        );
      }
    }
    if (await probe()) return consentSeen;
    await page.waitForTimeout(200);
  }
  throw new Error(
    `the replayed model edit never landed within 45s (the bi.model consent prompt ` +
      `${consentSeen ? "was answered with Allow once" : "never appeared"}).`,
  );
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

test.describe("Macro Recorder — BI-model recording, record → replay", () => {
  test("a recorded model edit replays through the consented bi.model gateway", async ({
    appPage: page,
    grid,
  }) => {
    // Menus, dialogs, keyboard cell edits, two IPC-driven model edits, a
    // worker-realm mount and a consent dialog. Explicit, not inherited.
    test.setTimeout(300_000);

    const macroName = `${MACRO_PREFIX} ${Date.now().toString(36)}`;

    try {
      // -----------------------------------------------------------------
      await test.step("0. fresh workbook + blank editable model (and one model edit made while NOT recording)", async () => {
        await cleanupArtifacts(page);

        // A fresh document: empty module store, no BI connections, clean grid.
        // This is what makes the spec a journey — newFile disturbs the whole
        // document, which e2e/tests specs are forbidden to do.
        await fileApi(page, "newFile");
        await page.waitForTimeout(500);
        await allowScripts(page);

        const info = await invoke<{ id: string; name: string }>(page, "bi_model_create_blank", {
          name: MODEL_NAME,
        });
        connectionId = info.id;
        expect(connectionId, "bi_model_create_blank returned a connection id").toBeTruthy();

        // NEGATIVE CONTROL, armed-only edition: a model edit made while NOT
        // recording. The capture hook is disarmed, so nothing of this may
        // appear in the recorded source later ("metadata" is asserted absent).
        await invoke(page, "bi_model_set_metadata", {
          connectionId,
          author: "NotRecordingProbe",
        });

        // Precondition for the whole journey: no measures yet.
        expect(await measureNames(page)).toEqual([]);
      });

      // -----------------------------------------------------------------
      await test.step("1. Developer ▸ Record Macro… arms the session AND the Rust capture", async () => {
        const dialog = await openRecordDialog(page, grid);
        await dialog.locator("[data-macro-name-input]").fill(macroName);
        // Object script is the default; check it anyway so the spec cannot
        // silently record for the notebook runtime (whose model surface is
        // read-only and would turn every assertion below into NOT REPLAYABLE).
        await dialog.locator('[data-macro-target="objectScript"]').check();
        await dialog.locator("[data-macro-start-button]").click();

        // The status-bar indicator is the user-visible "you are recording".
        await expect(page.locator("[data-macro-recorder-indicator]")).toBeVisible({
          timeout: 5_000,
        });

        // ...and the Rust-side hook must be ARMED, or every model edit below
        // would silently not record (the exact dead-entry-point failure this
        // feature's test plan calls out).
        await expect
          .poll(() => captureArmed(page), {
            timeout: 10_000,
            message:
              "macro_model_recording_set_armed(true) never reached Rust — the session " +
              "installed its hooks but the model capture is deaf",
          })
          .toBe(true);
      });

      // -----------------------------------------------------------------
      await test.step("2. one GRID edit + one MODEL edit + one PRIVILEGED edit are captured, in order", async () => {
        // GRID: typed through the canvas — the TS-bridge hook is what records,
        // so this must be a real keyboard entry, not an invoke.
        await grid.setCellValue(CELL.ref, CELL.typed);
        await expect
          .poll(() => recordedActionCount(page), {
            timeout: 15_000,
            message: "the typed cell edit never reached the recording session",
          })
          .toBe(1);

        // MODEL: a raw invoke from the MAIN window — the Rust hook below
        // emit_model_changed is the recorder here, so this is the REAL path.
        await invoke(page, "bi_model_upsert_measure", {
          connectionId,
          name: MEASURE,
          formula: MEASURE_FORMULA,
        });
        expect(await measureNames(page)).toContain(MEASURE);
        await expect
          .poll(() => recordedActionCount(page), {
            timeout: 15_000,
            message:
              "the measure upsert never reached the recording session — check the " +
              "macro:model-edit emission (armed flag, main-window targeting) in " +
              "bi/macro_capture.rs",
          })
          .toBe(2);

        // PRIVILEGED: a role upsert. Captured, but only as a redacted marker.
        await invoke(page, "bi_model_upsert_role", {
          connectionId,
          name: ROLE,
          filters: [],
        });
        await expect
          .poll(() => recordedActionCount(page), {
            timeout: 15_000,
            message: "the role upsert never reached the recording session",
          })
          .toBe(3);
      });

      // -----------------------------------------------------------------
      await test.step("3. Stop auto-saves the macro, disarms the capture, and shows the review dialog", async () => {
        await page
          .locator("[data-macro-recorder-indicator] button")
          .filter({ hasText: /^Stop$/ })
          .click();

        const result = page.locator("[data-macro-result-dialog]");
        await expect(result).toBeVisible({ timeout: 20_000 });

        // Saved — not "would you like to save?", and NOT the failure banner.
        await expect(result.locator("[data-macro-save-error]")).toHaveCount(0);
        const banner = result.locator("[data-macro-saved-banner]");
        await expect(banner).toBeVisible();
        await expect(banner).toContainText(macroName);

        // The review dialog's editable box shows the gateway call — the same
        // source the store holds (asserted authoritatively in step 4).
        const shown = await result.locator("textarea").first().inputValue();
        expect(shown).toContain("caps.biModel.upsert(");

        // Stopping must also DISARM the Rust capture, or every later spec in
        // this app instance records model edits into nothing.
        await expect
          .poll(() => captureArmed(page), {
            timeout: 10_000,
            message: "Stop never disarmed the Rust model capture",
          })
          .toBe(false);

        await result.locator("[data-macro-result-close]").click();
        await expect(result).toBeHidden({ timeout: 5_000 });
      });

      // -----------------------------------------------------------------
      await test.step("4. the STORED source: pragma, exactly one gateway call, privileged redaction, no leak from the unarmed edit", async () => {
        const scripts = await invoke<Array<{ id: string; name: string }>>(page, "list_scripts");
        const entry = scripts.find((s) => s.name === macroName);
        expect(
          entry,
          `the auto-saved macro "${macroName}" is listed in the workbook module store`,
        ).toBeTruthy();
        macroId = entry!.id;

        const record = await invoke<{ source?: string }>(page, "get_script", { id: macroId });
        const source = String(record?.source ?? "");

        // The grid half: the typed edit, at its exact coordinates.
        expect(source).toContain(
          `await api.setCellValue(${CELL.row}, ${CELL.col}, "${CELL.typed}")`,
        );

        // The model half: exactly ONE caps.biModel.upsert — the measure. Not
        // zero (capture dead), not two (the role or the pre-recording metadata
        // edit leaked in), and no batch wrapper (a single replayable edit must
        // not be wrapped — codegen batches only runs of 2+).
        expect(occurrences(source, "caps.biModel.upsert(")).toBe(1);
        expect(source).toContain('"measure"');
        expect(source).toContain(MEASURE);
        expect(source).toContain(connectionId!); // replay addresses the id
        expect(source).not.toContain("batchBegin");

        // The capability pragma — what the mount-time ceiling and the JIT
        // consent read. Without it the macro could never even ASK for bi.model.
        expect(source).toContain("// @capability bi.model");

        // Privileged redaction: the role edit is present as a refusal, with
        // the capture's own reason — and the role's NAME does not appear
        // anywhere in the source (role names are privileged).
        expect(source).toContain("NOT REPLAYABLE");
        expect(source).toContain("security roles are not scriptable");
        expect(source).not.toContain(ROLE);

        // Armed-only: the metadata edit from step 0 (made while NOT recording)
        // must have left no trace.
        expect(source).not.toContain('"metadata"');
      });

      // -----------------------------------------------------------------
      await test.step("5. replay: Run re-creates the deleted measure through the bi.model JIT consent", async () => {
        // Undo the recorded work so the replay has something to prove.
        await invoke(page, "bi_model_delete_measure", { connectionId, name: MEASURE });
        expect(await measureNames(page)).not.toContain(MEASURE);
        await clearCellUnrecorded(page);
        expect(await cellDisplay(page)).toBe("");

        const library = await openMacroLibrary(page, grid);
        const row = library.locator(`[data-macro-library-item="${macroId}"]`);
        await expect(row).toHaveCount(1);
        await row.click();

        // The library derived the right runtime BEFORE Run is pressed.
        await expect(library.locator("[data-macro-run-route]")).toHaveAttribute(
          "data-macro-run-route",
          "objectScript",
        );
        await expect(library.locator("[data-macro-run-button]")).toBeEnabled();

        const consentSeen = await runAndSettle(page, library, async () =>
          (await measureNames(page)).includes(MEASURE),
        );

        // THE PAIR IS THE PROOF (consent-refusal precedent): the outcome above
        // shows the gateway worked; this shows it worked BECAUSE the user was
        // asked. The transient run-once script id is unique per run, so no
        // persisted grant can explain a promptless success — that would be a
        // capability granted without consent, the fail-open shape.
        expect(
          consentSeen,
          "the measure came back WITHOUT the bi.model consent prompt ever appearing — " +
            "the capability was granted without asking (fail-open), or an unexpected " +
            "persisted grant matched a supposedly unique transient script id",
        ).toBe(true);

        // The grid half of the macro replayed alongside the model half.
        await expect
          .poll(() => cellDisplay(page), {
            timeout: 20_000,
            message: "the macro's grid write did not replay",
          })
          .toBe(CELL.typed);

        // And the library reported success, not a failure it swallowed.
        await expect(library.locator("[data-macro-error]")).toHaveCount(0);
        await expect(library.locator("[data-macro-output]")).toContainText("[OK]");

        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });
      });
    } finally {
      // Leave the shared app as found: no live recording, no armed capture,
      // no macro module, no BI connection, an empty D18.
      await cleanupArtifacts(page).catch(() => {});
    }
  });
});
