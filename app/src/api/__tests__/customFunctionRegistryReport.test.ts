// The page reports its custom-function registry to the backend
// (`note_custom_function_registry`, app/src-tauri/src/bi/cube.rs).
//
// WHY (rev10 rev9A). F9 and the save serve no custom function. A refused call
// must survive an IFERROR around it -- but only for a name that IS a function
// here, because a typo's #NAME? is Excel's ordinary error that IFERROR catches.
// The backend can read the Custom Functions libraries itself, never an add-in's
// `formulas.registerFunction`, so `=IFERROR(FXRATE("USD",TODAY()),0)` saved a
// plausible 0. The page now reports every registered name on every change.
//
// WHY THE GENERATION (rev10 cache2 residual). After an application update
// merges a library, the backend holds the changed functions' served answers
// until the page says the NEW library is live; a re-install triggered by the
// `custom-functions:refresh` event reports the generation that event carried --
// and only once the install succeeded, since a failed one restores the old realm.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../backend", () => ({ invokeBackend: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../core/lib/tauri-api", () => ({ setUdfResolveHook: vi.fn() }));
const tauriInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => tauriInvoke(...args) }));

import { invokeBackend } from "../backend";
import { registerFunction } from "../formulaFunctions";
import { installUdfEvaluation, uninstallUdfEvaluation } from "../formulaUdf";
import { loadAndInstallCustomFunctions } from "../customFunctions";

const mockedInvokeBackend = vi.mocked(invokeBackend);

function registryReports(): Array<{ names: string[]; installedGeneration: number | null }> {
  return mockedInvokeBackend.mock.calls
    .filter(([cmd]) => cmd === "note_custom_function_registry")
    .map(([, args]) => args as { names: string[]; installedGeneration: number | null });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("custom-function registry report", () => {
  beforeEach(() => {
    mockedInvokeBackend.mockClear();
    tauriInvoke.mockReset();
  });
  afterEach(() => {
    uninstallUdfEvaluation();
  });

  it("reports an add-in's registered function to the backend, and its removal", async () => {
    installUdfEvaluation();
    await flush();
    mockedInvokeBackend.mockClear();

    const unregister = registerFunction({
      name: "FXRATE",
      description: "",
      syntax: "FXRATE(currency, date)",
      category: "Custom",
      minArgs: 2,
      maxArgs: 2,
      implementation: () => 1,
    });
    await flush();
    const afterRegister = registryReports();
    expect(afterRegister.length).toBeGreaterThan(0);
    expect(afterRegister[afterRegister.length - 1].names.map((n) => n.toUpperCase())).toContain("FXRATE");
    expect(afterRegister[afterRegister.length - 1].installedGeneration).toBeNull();

    mockedInvokeBackend.mockClear();
    unregister();
    await flush();
    const afterUnregister = registryReports();
    expect(afterUnregister.length).toBeGreaterThan(0);
    expect(afterUnregister[afterUnregister.length - 1].names.map((n) => n.toUpperCase())).not.toContain("FXRATE");
  });

  it("reports the refresh event's library generation once the re-install succeeded", async () => {
    // The merged library is empty: the install tears every realm down.
    tauriInvoke.mockImplementation(async (cmd: string) => (cmd === "get_script" ? null : undefined));
    await loadAndInstallCustomFunctions({ libraryGeneration: 7 });
    expect(registryReports().map((r) => r.installedGeneration)).toContain(7);
  });

  it("does not report a generation when the re-install failed (the old realm may be back)", async () => {
    tauriInvoke.mockImplementation(async (cmd: string) =>
      cmd === "get_script"
        ? { source: JSON.stringify({ functions: [{ name: "1 bad name", params: [], body: "return 1;" }] }) }
        : undefined,
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await loadAndInstallCustomFunctions({ libraryGeneration: 9 });
    errorSpy.mockRestore();
    expect(registryReports().map((r) => r.installedGeneration)).not.toContain(9);
  });
});
