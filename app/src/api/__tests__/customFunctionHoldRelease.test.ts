//! FILENAME: app/src/api/__tests__/customFunctionHoldRelease.test.ts
// PURPOSE: The custom-function HOLD is released by any successful install of
//          the library the page read, and the page's registry report leaves
//          the Custom Functions library's own names out (rev11C).
// CONTEXT: After an application's subscribe or update merged a library, the
//          backend holds the changed functions' served answers until the page
//          reports the generation it installed (`note_custom_function_registry`,
//          app/src-tauri/src/bi/cube.rs). Only the refresh listener used to
//          report one, so a hold whose refresh install FAILED stayed for the
//          rest of the session even after a later consent reinstall or a
//          dialog Save mounted the new code: F9 and the save refused those
//          functions' calls as #NAME? although the live code computed them.
//          And the report carried the library's own names, which the backend
//          kept across File > Open, so the PREVIOUS workbook's library names
//          were noted on the next one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/* eslint-disable @typescript-eslint/naming-convention -- the doubles must match the real export names */

vi.mock("../scriptHost/host", () => ({
  hostMountScript: async () => undefined,
  hostUnmountScript: () => undefined,
}));
vi.mock("../scriptHost/capabilities", () => ({
  applyConsentedCapabilities: async () => undefined,
  revokeScriptGrants: () => undefined,
}));
vi.mock("../scriptLibraries", () => ({
  linkScript: async () => ({ prelude: "", imports: [], release: () => undefined }),
}));
vi.mock("../scriptableObjects", () => ({ callExposedMethod: async () => undefined }));
vi.mock("../distributedConsent", () => ({
  loadConsents: async () => [],
  isConsentCurrent: async () => true,
  recordConsent: async () => undefined,
}));
vi.mock("../events", () => ({ emitAppEvent: () => undefined }));

interface RegisteredUdf {
  name: string;
}
const registered: RegisteredUdf[] = [];
vi.mock("../formulaFunctions", () => ({
  registerFunction: (def: RegisteredUdf) => {
    registered.push(def);
    return () => {
      const i = registered.indexOf(def);
      if (i >= 0) registered.splice(i, 1);
    };
  },
  getAllCustomFunctions: () => [...registered],
  UDF_ERROR_KEY: "__calcula_error",
}));

/** The backend's current library generation, answered by every report. */
let backendGeneration = 0;
const invokeBackend = vi.fn(async (cmd: string, _args?: unknown) =>
  cmd === "note_custom_function_registry" ? backendGeneration : undefined,
);
vi.mock("../backend", () => ({ invokeBackend: (cmd: string, args?: unknown) => invokeBackend(cmd, args) }));

let storedLibrary: unknown = null;
const tauriInvoke = vi.fn(async (cmd: string, _args?: unknown) =>
  cmd === "get_script" ? (storedLibrary === null ? null : { source: JSON.stringify(storedLibrary) }) : undefined,
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => tauriInvoke(cmd, args) }));

/* eslint-enable @typescript-eslint/naming-convention */

import {
  installCustomFunctions,
  loadAndInstallCustomFunctions,
  savePersistedLibrary,
  uninstallCustomFunctions,
} from "../customFunctions";
import { reportCustomFunctionRegistry } from "../customFunctionRegistryReport";

interface Report {
  names: string[];
  installedGeneration: number | null;
}

function reports(): Report[] {
  return invokeBackend.mock.calls
    .filter(([cmd]) => cmd === "note_custom_function_registry")
    .map(([, args]) => args as Report);
}

function installedGenerations(): Array<number | null> {
  return reports().map((r) => r.installedGeneration);
}

const goodLibrary = { functions: [{ name: "MYFN", params: ["x"], body: "return x * 100;" }] };
const badLibrary = { functions: [{ name: "1 bad name", params: [], body: "return 1;" }] };

beforeEach(() => {
  invokeBackend.mockClear();
  tauriInvoke.mockClear();
  registered.length = 0;
  backendGeneration = 0;
  storedLibrary = null;
});

afterEach(() => {
  uninstallCustomFunctions();
});

describe("the custom-function hold release", () => {
  it("a hold whose refresh install failed is released by the next successful install", async () => {
    // An application update merged MYFN v2 and held it at generation 9; the
    // refresh install of what it merged fails.
    backendGeneration = 9;
    storedLibrary = badLibrary;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await loadAndInstallCustomFunctions({ libraryGeneration: 9 });
    errorSpy.mockRestore();
    expect(installedGenerations()).not.toContain(9);

    // The user fixes the library / grants consent: the reinstall carries no
    // event generation, yet it installs what generation 9 wrote.
    storedLibrary = goodLibrary;
    invokeBackend.mockClear();
    await loadAndInstallCustomFunctions();
    expect(
      installedGenerations(),
      "the consent reinstall mounted the new code but never released generation 9's hold",
    ).toContain(9);
  });

  it("the authoring dialog's Save releases every generation reached before it saved", async () => {
    backendGeneration = 4;
    await installCustomFunctions(goodLibrary);
    invokeBackend.mockClear();
    await savePersistedLibrary(goodLibrary);
    const saveOrder = tauriInvoke.mock.invocationCallOrder[
      tauriInvoke.mock.calls.findIndex(([cmd]) => cmd === "save_script")
    ];
    const releases = invokeBackend.mock.calls
      .map((call, i) => ({ args: call[1] as Report | undefined, order: invokeBackend.mock.invocationCallOrder[i] }))
      .filter((c) => c.args?.installedGeneration === 4);
    expect(releases.length, "the Save never reported the generation it made live").toBeGreaterThan(0);
    expect(releases.every((r) => r.order > saveOrder), "released before the library was stored").toBe(true);
  });
});

describe("overlapping library installs (rev13A)", () => {
  // A consent reinstall and a refresh land together: each asks the backend's
  // generation, reads the library, then queues its install. The one that read
  // the OLDER library (generation 100) is slow to read; the one that read the
  // NEWER (101) installs first and releases its holds. The older one then
  // installed last, so the old code served with every hold already released.
  // SABOTAGE: make `installUnlessSuperseded` never skip (drop its
  // `readGeneration < highestInstalledLibraryGeneration` test).
  it("an install that read an older library than the one already installed is skipped", async () => {
    const oldLibrary = { functions: [{ name: "OLDFN", params: ["x"], body: "return x * 100;" }] };
    const newLibrary = { functions: [{ name: "NEWFN", params: ["x"], body: "return x * 200;" }] };
    backendGeneration = 100;
    storedLibrary = oldLibrary;
    let releaseSlowRead: () => void = () => undefined;
    let slowReadPending = true;
    const realInvoke = tauriInvoke.getMockImplementation()!;
    tauriInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_script" && slowReadPending) {
        slowReadPending = false;
        const snapshot = storedLibrary; // read under generation 100
        await new Promise<void>((resolve) => (releaseSlowRead = resolve));
        return { source: JSON.stringify(snapshot) };
      }
      return realInvoke(cmd, args);
    });
    try {
      const slow = loadAndInstallCustomFunctions();
      for (let i = 0; i < 10 && slowReadPending; i++) await Promise.resolve();
      expect(slowReadPending, "the premise: the first call is reading the library").toBe(false);

      // An application update merged the new library at generation 101.
      backendGeneration = 101;
      storedLibrary = newLibrary;
      await loadAndInstallCustomFunctions({ libraryGeneration: 101 });
      expect(installedGenerations()).toContain(101);
      expect(registered.map((r) => r.name)).toContain("NEWFN");

      invokeBackend.mockClear();
      releaseSlowRead();
      await slow;
      expect(
        registered.map((r) => r.name),
        "the install that read the older library put the old code back after the newer one went live",
      ).not.toContain("OLDFN");
      expect(registered.map((r) => r.name)).toContain("NEWFN");
      expect(installedGenerations(), "the skipped install reported a generation").not.toContain(100);
    } finally {
      tauriInvoke.mockImplementation(realInvoke);
    }
  });
});

describe("the registry report", () => {
  it("leaves the Custom Functions library's own names out, and keeps an add-in's", async () => {
    await installCustomFunctions(goodLibrary);
    // An add-in's registration (formulas.registerFunction) -- not the library's.
    registered.push({ name: "FXRATE" });
    expect(registered.map((r) => r.name)).toContain("MYFN"); // precondition: the library registered
    invokeBackend.mockClear();
    await reportCustomFunctionRegistry();
    const names = reports()[0].names.map((n) => n.toUpperCase());
    expect(names).toContain("FXRATE");
    expect(names, "the library's name rode the session list onto the next workbook").not.toContain("MYFN");
  });
});
