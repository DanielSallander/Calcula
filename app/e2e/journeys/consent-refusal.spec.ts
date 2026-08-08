/**
 * CONSENT REFUSAL — the async-confirm defect class, proved dead in the real app.
 *
 * THE DEFECT. Under Tauri `window.confirm` is replaced by an ASYNC shim, so it
 * returns a Promise. `if (!window.confirm(msg)) return;` therefore tests
 * `!Promise` — an object, always truthy — so the negation is ALWAYS FALSE and
 * the guard NEVER fires. Every such site ran as though the user had pressed OK.
 * On a CONSENT gate that means pressing Cancel GRANTED the thing being asked
 * about. It shipped six times, was patched per-site each time, and came back.
 *
 * WHY A LIVE TEST AND NOT JUST A UNIT TEST. The unit suite already had a test
 * called "user declines: denies and does NOT grant" and it PASSED throughout —
 * because it stubbed `confirm` with the SYNCHRONOUS jsdom shape
 * (`mockReturnValue(false)`), where `!false` is `true` and the dead guard looks
 * alive. A synchronous double can never catch this defect. Only the real webview,
 * with the real Tauri shim installed, can.
 *
 * WHAT IS ASSERTED. Not "the dialog closed" — a dialog closes on Cancel whether
 * or not the guard works. This spec asserts the APP'S OWN AUTHORISATION STATE:
 *
 *   getGrantSet(scriptId)      the live capability grant set consulted by the
 *                              broker on every subsequent call
 *   wasDeniedThisSession(...)  the session deny-memory
 *   the guarded ACTION         the script's storage write itself — it must throw
 *                              PermissionDenied on refusal and succeed on grant
 *
 * THE PAIR IS THE PROOF. A refusal test alone passes just as happily against a
 * feature that is broken outright — "nothing was granted" is also what a dead
 * capability system looks like. So every refusal case here is matched by a
 * positive control on the same code path that must GRANT.
 *
 * SCRIPT SECURITY is set to "enabled" for the duration, which makes the
 * ensureScriptsAllowed gate a silent no-op. That is deliberate: it isolates the
 * capability consent gate so a pass cannot be explained by the other gate.
 *
 * Grid area: BN..BP (columns 65-67), rows 91-95. Columns K,L,N,P,R,T-Z,AA-AD,
 * AE..AJ and BF..BL are claimed by other specs sharing this one app instance.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";

// --- private patch -----------------------------------------------------------
const MARKER = { row: 90, col: 65 }; // BN91 (0-based row/col)

const STORAGE_KEY = "e2e-consent-refusal-key";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Install `window.__appImport(path)`: resolve the URL the RUNNING APP actually
 * loaded a module from, and import THAT.
 *
 * THIS IS LOAD-BEARING, NOT TIDINESS. Vite's dev server appends an HMR version
 * query (`?t=<timestamp>`) to a module's URL after any edit in its import
 * graph. `import("/src/api/scriptHost/capabilities.ts")` and
 * `import("/src/api/scriptHost/capabilities.ts?t=1786181902539")` are two
 * DIFFERENT module instances with two different copies of the module-level
 * state — here, the `deniedThisSession` map and the live grant sets.
 *
 * A test that imports the unversioned URL therefore reads a PHANTOM module that
 * the app never touches: every grant set is empty and every deny is missing.
 * `expect(caps).not.toContain("storage")` passes against that phantom no matter
 * what the real gate did — a green refusal test that proves nothing. This was
 * observed live while writing this spec: after one source edit the app moved to
 * `?t=…` and the assertions silently detached from the app.
 *
 * So: read the real URL out of the resource timing entries (newest wins) and
 * fall back to the plain path only when the app has not loaded it yet.
 *
 * Implemented as a page-side function rather than `new Function` in the test,
 * because the app runs under a no-unsafe-eval CSP — dynamic `import()` is
 * permitted, `Function` is not.
 */
async function installAppImport(page: Page): Promise<void> {
  await page.evaluate(() => {
    if ((window as any).__appImport) return;
    (window as any).__appImport = async (modulePath: string) => {
      const entries = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((n) => {
          try {
            return new URL(n).pathname === modulePath;
          } catch {
            return false;
          }
        });
      entries.sort(); // newest HMR version last
      const url =
        entries.length > 0
          ? entries[entries.length - 1]
          : new URL(modulePath, document.baseURI).href;
      return (window as any).__calcImport(url);
    };
  });
}

/**
 * Fail loudly if the test is talking to a phantom module instance.
 *
 * Every mount records the ambient `ui.html` capability, so a freshly mounted
 * script MUST have a non-empty grant set in the app's real instance. An empty
 * one means this test imported a different copy and every subsequent
 * "not granted" assertion would be vacuously true.
 */
async function assertSharedInstance(page: Page, mountedScriptId: string): Promise<void> {
  const caps = (await grantState(page, mountedScriptId)).caps;
  expect(
    caps.length,
    "module-instance check: the app's grant set for a mounted script is empty, " +
      "so this spec imported a DIFFERENT instance of capabilities.ts (Vite ?t= " +
      "HMR versioning). Every grant assertion below would be vacuous.",
  ).toBeGreaterThan(0);
}

/** Script Security "enabled" -> ensureScriptsAllowed is a no-op, isolating the
 *  capability gate as the ONLY consent gate in play. */
async function allowScripts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    await tauri.core.invoke("set_script_security_level", { level: "enabled" });
  });
}

/**
 * A script that DECLARES the storage capability (the JIT prompt only fires for
 * declared caps — an undeclared one is above the ceiling and is denied outright
 * without asking) and then USES it, recording the outcome where the test can
 * see it. The outcome cell is the guarded action's own report:
 *   "GRANTED" - the storage write completed
 *   "DENIED:..." - the broker refused it
 */
function scriptSource(): string {
  return (
    `// @capability storage\n` +
    `function setup(context) {\n` +
    `  context.caps.storage\n` +
    `    .set(${JSON.stringify(STORAGE_KEY)}, "written")\n` +
    `    .then(function () {\n` +
    `      return context.api.setCellValue(${MARKER.row}, ${MARKER.col}, "GRANTED");\n` +
    `    })\n` +
    `    .catch(function (e) {\n` +
    `      var code = (e && (e.code || e.message)) || String(e);\n` +
    `      return context.api.setCellValue(${MARKER.row}, ${MARKER.col}, "DENIED:" + code);\n` +
    `    });\n` +
    `}\n`
  );
}

/** Register a fresh script and START mounting it. The mount is NOT awaited here:
 *  setup() blocks on the consent dialog, so awaiting inside this evaluate would
 *  deadlock against the click that answers it. The promise is parked on window
 *  and collected afterwards. */
async function startMount(page: Page, scriptId: string): Promise<void> {
  await page.evaluate(
    async ({ scriptId, source }) => {
      const so: any = await (window as any).__appImport("/src/api/scriptableObjects.ts");
      so.ObjectScriptManager.registerScript({
        id: scriptId,
        name: scriptId,
        objectType: "shape",
        instanceId: scriptId,
        source,
        // "unlocked", not "restricted". The ACCESS LEVEL (allowlist tier) and the
        // CAPABILITY are two independent gates: the tier decides which api.*
        // methods exist at all, the capability decides whether a privileged
        // capability call is permitted. `context.api` is null at "restricted", so
        // the script could not report its own outcome — the guarded-action
        // assertion would then read an empty cell and "fail" identically whether
        // consent worked or not. Storage is still fully capability-gated here;
        // raising the tier does not grant it.
        accessLevel: "unlocked",
        description: null,
        // R19 — the declared-capability CEILING, and it is authoritative: the
        // JIT gate only prompts for a capability the script declared, because
        // anything above the ceiling is denied by the broker without asking the
        // user to grant something that was never requested. The `@capability`
        // source pragma is the AUTHORING form; the definition field is what the
        // handle is actually built from (buildHandleFromDefinition). Omitting it
        // is why an early draft of this spec saw PermissionDenied with no prompt
        // at all — a silent pass for the wrong reason, which is precisely the
        // failure mode this whole spec exists to rule out.
        declaredCapabilities: ["storage"],
      });
      (window as any).__consentMount = { settled: false, error: null };
      (window as any).__consentMountPromise = so.ObjectScriptManager.mountScript(scriptId)
        .then(() => {
          (window as any).__consentMount = { settled: true, error: null };
        })
        .catch((e: unknown) => {
          (window as any).__consentMount = { settled: true, error: String(e) };
        });
    },
    { scriptId, source: scriptSource() },
  );
}

/** Read the app's live authorisation state for a script. */
async function grantState(
  page: Page,
  scriptId: string,
): Promise<{ caps: string[]; denied: boolean }> {
  return page.evaluate(async (scriptId) => {
    const caps: any = await (window as any).__appImport("/src/api/scriptHost/capabilities.ts");
    return {
      caps: [...caps.getGrantSet(scriptId)],
      denied: caps.wasDeniedThisSession(scriptId, "storage", null) === true,
    };
  }, scriptId);
}

async function readMarker(page: Page): Promise<string> {
  return page.evaluate(
    async ({ row, col }) => {
      const tauri = (window as any).__TAURI__;
      const cell = await tauri.core.invoke("get_cell", { row, col });
      return String(cell?.display ?? cell?.value ?? "");
    },
    { row: MARKER.row, col: MARKER.col },
  );
}

async function clearMarker(page: Page): Promise<void> {
  await page.evaluate(
    async ({ row, col }) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_cell", { row, col, value: "" }).catch(() => {});
      window.dispatchEvent(new Event("grid:refresh"));
    },
    { row: MARKER.row, col: MARKER.col },
  );
  await page.waitForTimeout(120);
}

async function unmount(page: Page, scriptId: string): Promise<void> {
  await page.evaluate(async (scriptId) => {
    try {
      const so: any = await (window as any).__appImport("/src/api/scriptableObjects.ts");
      try {
        so.ObjectScriptManager.unmountScript(scriptId);
      } catch {
        /* not mounted */
      }
      try {
        so.ObjectScriptManager.removeScript(scriptId);
      } catch {
        /* already gone */
      }
    } catch {
      /* module not loaded */
    }
  }, scriptId);
}

async function waitForPermissionDialog(page: Page): Promise<void> {
  await expect(
    page.getByText("A script is asking for access it does not yet have"),
  ).toBeVisible({ timeout: 20_000 });
}

async function answerPermission(page: Page, label: "Deny" | "Allow once"): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(
    page.getByText("A script is asking for access it does not yet have"),
  ).toBeHidden({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// NATIVE dialogs — the confirmAsync sites themselves
// ---------------------------------------------------------------------------
// confirmAsync goes to tauri-plugin-dialog, which raises a REAL Win32
// TaskDialog. Playwright cannot see or answer it: Tauri defines its whole IPC
// surface with Object.defineProperty(..., { value }) — non-writable and
// non-configurable — so `window.confirm` cannot be stubbed and
// `plugin:dialog|confirm` cannot be intercepted. Any in-page interception is a
// silent no-op (see dirty-flag-close.spec.ts, which hit the same wall).
//
// So the dialog is driven from OUTSIDE the app, over Win32, exactly as a user's
// mouse would: find the dialog window owned by app.exe, enumerate its child
// buttons, and post BM_CLICK to the chosen one.
//
// THIS IS THE PART THAT PROVES THE DEFECT IS DEAD. The in-app capability dialog
// above is React and was never broken; `confirmAsync` on a native dialog is the
// exact construct that returned a Promise and made `if (!confirm(...))` a no-op.

const DIALOG_DRIVER = path.join(
  os.homedir(),
  "AppData",
  "Local",
  "Temp",
  "claude",
  "c--Dropbox-Projekt-Calcula",
  "ffc06ccd-ce77-42f8-bee3-71899bcec1e9",
  "scratchpad",
  "answer-native-dialog.ps1",
);

/**
 * Click OK or Cancel on the native dialog whose title contains `titleLike`.
 *
 * The driver prints the dialog's message as `TEXT:` lines (read via UI
 * Automation) followed by its verdict, so the raw stdout must be PARSED rather
 * than pattern-matched whole — matching the whole string against /^CLICKED:/
 * breaks the moment a TEXT line is emitted first, which is exactly how this
 * spec broke when the driver gained text reporting.
 */
function answerNativeDialogRaw(
  titleLike: string,
  action: "ok" | "cancel",
  waitMs = 20_000,
): string {
  try {
    return execFileSync(
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
        action,
        "-TimeoutMs",
        String(waitMs),
      ],
      { encoding: "utf-8", timeout: 60_000 },
    );
  } catch (e) {
    return `DRIVERERROR:${String(e)}`;
  }
}

function answerNativeDialog(
  titleLike: string,
  action: "ok" | "cancel",
): { text: string; clicked: string } {
  const out = answerNativeDialogRaw(titleLike, action);
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    text: lines.filter((l) => l.startsWith("TEXT:")).map((l) => l.slice(5)).join(" "),
    clicked: lines.find((l) => l.startsWith("CLICKED:")) ?? lines.join("|"),
  };
}

/**
 * Dismiss any native dialog left over from an earlier test or a crashed run.
 *
 * These are app-modal and they ACCUMULATE — one app instance serves every spec,
 * so an unanswered dialog is still on screen when the next test starts. The
 * driver would then read THAT dialog and report a confident CLICKED, so the
 * assertions would be made against a message this test never raised.
 */
function drainNativeDialogs(): void {
  for (let i = 0; i < 5; i++) {
    const r = answerNativeDialogRaw("Calcula", "cancel", 1_200);
    if (!r.includes("CLICKED:")) return;
  }
}

/** Resolve a parked promise's recorded value. */
async function parked<T>(page: Page, key: string): Promise<T> {
  return page.evaluate((key) => (window as any)[key], key);
}

/**
 * Arm and start the LAPSED-GRANT re-consent gate (api/scriptHost/capabilities.ts).
 *
 * noteLapsedGrant() records that this script held a persisted "Allow always"
 * grant and has since been EDITED, so the grant lapsed. The next
 * requestCapabilityGrant() must show the diff and make the user acknowledge it
 * BEFORE the permission dialog — "re-consent after an edit is never a blind
 * re-approval", and declining the notice is documented as a deny.
 *
 * That acknowledgement is a confirmAsync, i.e. a NATIVE dialog titled
 * "Permission changed". The promise is parked because the native answer arrives
 * from another process.
 *
 * Repeatable by construction: the lapse notice is per-script, so a fresh script
 * id re-arms it. (The global Script Security session approval, by contrast, is
 * app-lifetime state with no revoke, so a gate built on it could only be tested
 * once per launch — which is exactly how a test starts passing for the wrong
 * reason on its second run.)
 */
async function startLapsedConsent(page: Page, scriptId: string): Promise<void> {
  await page.evaluate(async (scriptId) => {
    const caps: any = await (window as any).__appImport("/src/api/scriptHost/capabilities.ts");
    caps.noteLapsedGrant(
      scriptId,
      `The code of "${scriptId}" changed since you granted it storage access.`,
    );
    (window as any).__lapseDecision = "pending";
    caps
      .requestCapabilityGrant({
        scriptId,
        scriptName: scriptId,
        capability: "storage",
        origin: null,
      })
      .then((d: string) => {
        (window as any).__lapseDecision = d;
      });
  }, scriptId);
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

test.describe("consent refusal (async-confirm defect class)", () => {
  const denyId = `e2e-consent-deny-${Date.now()}`;
  const allowId = `e2e-consent-allow-${Date.now()}`;

  test.afterAll(async ({ sharedPage }) => {
    await unmount(sharedPage, denyId);
    await unmount(sharedPage, allowId);
    await clearMarker(sharedPage);
  });

  test("Deny refuses the capability: not granted, remembered, and the guarded action fails", async ({
    appPage,
  }) => {
    await installAppImport(appPage);
    await allowScripts(appPage);
    await clearMarker(appPage);
    await unmount(appPage, denyId);

    await startMount(appPage, denyId);

    // The prompt must actually appear. If it does not, the rest of this test
    // would "pass" for the wrong reason, so this is an assertion, not a wait.
    await waitForPermissionDialog(appPage);

    // The script is mounted by now, so the app has recorded its ambient grants.
    // Prove this spec is reading the app's REAL module before trusting a single
    // "not granted" assertion.
    await assertSharedInstance(appPage, denyId);

    // Before answering, the capability under test may not be granted yet.
    const before = await grantState(appPage, denyId);
    expect(before.caps).not.toContain("storage");

    await answerPermission(appPage, "Deny");

    // --- the app's own authorisation state ---------------------------------
    await expect
      .poll(async () => (await grantState(appPage, denyId)).denied, { timeout: 15_000 })
      .toBe(true);

    const after = await grantState(appPage, denyId);
    // THE CENTRAL ASSERTION: the capability is NOT in the live grant set the
    // broker consults. Under the defect this contained "storage".
    expect(after.caps).not.toContain("storage");

    // --- the guarded action itself -----------------------------------------
    // Not "a dialog closed": the storage write the user refused must have been
    // refused. The script reports its own outcome into the marker cell.
    await expect.poll(() => readMarker(appPage), { timeout: 20_000 }).toMatch(/^DENIED:/);
  });

  test("POSITIVE CONTROL — Allow once grants the capability and the guarded action succeeds", async ({
    appPage,
  }) => {
    // Without this case the refusal test above would pass just as well against a
    // capability system that grants nothing at all.
    await installAppImport(appPage);
    await allowScripts(appPage);
    await clearMarker(appPage);
    await unmount(appPage, allowId);

    await startMount(appPage, allowId);
    await waitForPermissionDialog(appPage);
    await assertSharedInstance(appPage, allowId);

    const before = await grantState(appPage, allowId);
    expect(before.caps).not.toContain("storage");

    await answerPermission(appPage, "Allow once");

    // --- the app's own authorisation state ---------------------------------
    await expect
      .poll(async () => (await grantState(appPage, allowId)).caps, { timeout: 15_000 })
      .toContain("storage");

    const after = await grantState(appPage, allowId);
    expect(after.denied).toBe(false);

    // --- the guarded action itself -----------------------------------------
    await expect.poll(() => readMarker(appPage), { timeout: 20_000 }).toBe("GRANTED");
  });
});

// ---------------------------------------------------------------------------
// THE NATIVE confirmAsync GATE — the defect's own construct
// ---------------------------------------------------------------------------
// The capability dialog above is React and was never broken. THIS is the shape
// that shipped six times: a confirmAsync (formerly `window.confirm`) whose
// result gates an authorisation. Under the defect the call returned a Promise,
// `!Promise` was always false, and the refusal branch was unreachable.
//
// Target: the LAPSED-GRANT re-consent notice in api/scriptHost/capabilities.ts —
// one of the three fail-open consent gates. Its own docstring promises
// "declining the notice is a deny"; before the fix, Cancel fell through to the
// permission dialog exactly like OK, with the diff already consumed and
// therefore never shown again.

test.describe("lapsed-grant re-consent (native confirmAsync)", () => {
  test.afterAll(async ({ sharedPage }) => {
    await allowScripts(sharedPage);
  });

  test("the primitive itself: Cancel resolves false, OK resolves true", async ({ appPage }) => {
    await installAppImport(appPage);
    drainNativeDialogs();
    // The contract every one of the ~171 rewritten call sites now depends on,
    // asserted against the REAL Tauri dialog rather than a synchronous jsdom
    // double. A sync double cannot fail this way, which is precisely why the
    // pre-existing unit test "user declines: denies and does NOT grant" passed
    // for months while the product was broken.
    for (const [action, expected] of [
      ["cancel", false],
      ["ok", true],
    ] as const) {
      await appPage.evaluate(async () => {
        const d: any = await (window as any).__appImport("/src/api/dialogs.ts");
        (window as any).__primitiveAnswer = "pending";
        d.confirmAsync("E2E consent probe.", {
          title: "Consent Probe",
          kind: "warning",
        }).then((v: boolean) => {
          (window as any).__primitiveAnswer = v;
        });
      });

      const verdict = answerNativeDialog("Consent Probe", action);
      expect(verdict.clicked).toMatch(/^CLICKED:/);

      await expect
        .poll(() => parked<unknown>(appPage, "__primitiveAnswer"), { timeout: 20_000 })
        .toBe(expected);
    }
  });

  test("Cancel on the lapse notice DENIES: the capability is not granted", async ({ appPage }) => {
    await installAppImport(appPage);
    drainNativeDialogs();
    const scriptId = `e2e-lapse-deny-${Date.now()}`;

    await startLapsedConsent(appPage, scriptId);

    // Answer the REAL native dialog from outside the app. Asserting the driver
    // actually pressed a button matters: a silent NOTFOUND would leave the
    // request parked forever, and "not granted" would then be true for a reason
    // that has nothing to do with consent.
    const verdict = answerNativeDialog("Permission changed", "cancel");
    expect(verdict.clicked).toMatch(/^CLICKED:/);

    // --- the decision -------------------------------------------------------
    await expect
      .poll(() => parked<string>(appPage, "__lapseDecision"), { timeout: 20_000 })
      .toBe("deny");

    // --- the app's own authorisation state ---------------------------------
    const state = await grantState(appPage, scriptId);
    expect(state.caps).not.toContain("storage");
    expect(state.denied).toBe(true);

    // The permission dialog must NEVER have been reached. Under the defect it
    // was shown, with the diff already consumed — a blind re-approval.
    await expect(
      appPage.getByText("A script is asking for access it does not yet have"),
    ).toBeHidden();
  });

  test("POSITIVE CONTROL — OK on the lapse notice proceeds to the permission dialog and grants", async ({
    appPage,
  }) => {
    // Without this, the refusal above would pass just as well if the lapse gate
    // denied unconditionally — i.e. if the feature were broken shut.
    await installAppImport(appPage);
    drainNativeDialogs();
    const scriptId = `e2e-lapse-allow-${Date.now()}`;

    await startLapsedConsent(appPage, scriptId);

    const verdict = answerNativeDialog("Permission changed", "ok");
    expect(verdict.clicked).toMatch(/^CLICKED:/);

    // Acknowledging the diff must lead to the real permission dialog.
    await waitForPermissionDialog(appPage);
    await answerPermission(appPage, "Allow once");

    await expect
      .poll(() => parked<string>(appPage, "__lapseDecision"), { timeout: 20_000 })
      .toBe("once");

    const state = await grantState(appPage, scriptId);
    expect(state.denied).toBe(false);
  });
});
