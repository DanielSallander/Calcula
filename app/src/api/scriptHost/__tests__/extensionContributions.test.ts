//! FILENAME: app/src/api/scriptHost/__tests__/extensionContributions.test.ts
// PURPOSE: The contract for the third-party add-in contribution surface
//          (docs/design/third-party-addin-authoring.md slice 1). Three families:
//            1. END TO END — a sandboxed worker extension registers a worksheet
//               function that really lands in the formula registry and really
//               evaluates through the worker.
//            2. FAIL CLOSED — an undeclared contribution, an undeclared
//               capability and a colliding name are REFUSED, loudly.
//            3. DRIFT — the layers (protocol kind / worker shim / host case /
//               declaration key) are derived FROM SOURCE, so a kind added to one
//               layer and forgotten in another fails here rather than at runtime.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  CONTRIBUTION_DECLARATION_KEY,
  CONTRIBUTION_REACH_NOTE,
  CONTRIBUTION_REGISTRATION_KINDS,
  CONTRIBUTION_REQUIRED_CAPABILITY,
  EXTENSION_BROKER_METHODS,
  EXTENSION_CONTRIBUTION_KINDS,
  EXTENSION_PUSHED_DATA_CAPABILITIES,
  countContributions,
  extensionReachableCapabilities,
  isContributionDeclared,
  normalizeContributionDeclaration,
  type ExtRegistration,
  type WX2H,
} from "../extensionProtocol";
import {
  ALLOWLIST,
  APP_EVENTS_CARRYING_CELL_CONTENTS,
  thinAppEventForScripts,
} from "../allowlist";
import { ALL_CAPABILITY_IDS, isCapabilityId } from "../capabilityIds";
import { describeCapability } from "../capabilities";
import { AppEvents, emitAppEvent } from "../../events";

// showToast reaches into the DOM notification store; a refusal must still be
// observable, so spy on it rather than silencing it.
const toasts: string[] = [];
vi.mock("../../notifications", () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

// ============================================================================
// A fake Worker: the test IS the sandboxed extension.
// ============================================================================

type HostMessage = { t: string; [k: string]: unknown };

class FakeWorker {
  static last: FakeWorker | null = null;
  listeners = new Map<string, Set<(e: unknown) => void>>();
  /** Everything the host posted INTO the worker. */
  received: HostMessage[] = [];
  terminated = false;
  /** Handlers the "extension" registered, keyed by handlerId. */
  handlers = new Map<number, (...args: unknown[]) => unknown>();

  constructor() {
    FakeWorker.last = this;
  }

  addEventListener(type: string, cb: (e: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  /** Host -> worker. Auto-answers invokeHandler from `handlers`. */
  postMessage(msg: HostMessage): void {
    this.received.push(msg);
    if (msg.t === "invokeHandler") {
      const fn = this.handlers.get(msg.handlerId as number);
      const reqId = msg.reqId as number;
      const args = msg.args as unknown[];
      void (async () => {
        try {
          const value = await fn?.(...args);
          this.emit({ t: "handlerResult", reqId, ok: true, value });
        } catch (e) {
          this.emit({
            t: "handlerResult",
            reqId,
            ok: false,
            error: { code: "HostError", message: String(e) },
          });
        }
      })();
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Worker -> host. */
  emit(data: WX2H): void {
    for (const cb of this.listeners.get("message") ?? []) {
      cb({ data } as unknown as MessageEvent<WX2H>);
    }
  }

  register(reg: ExtRegistration): void {
    this.emit({ t: "register", reg });
  }
}

/** Bracket-accessed so the test never declares a PascalCase type property. */
const globalScope = globalThis as unknown as Record<string, unknown>;
const WORKER_GLOBAL = "Worker";
const originalWorker = globalScope[WORKER_GLOBAL];

/** Mount an extension whose worker is the FakeWorker above. */
async function mountFake(
  mod: typeof import("../extensionWorkerHost"),
  manifest: Record<string, unknown>,
): Promise<{ worker: FakeWorker; result: Awaited<ReturnType<typeof mod.mountWorkerExtension>> }> {
  const pending = mod.mountWorkerExtension("/* bundle */", String(manifest.name ?? ""), manifest as never);
  // The host posts {t:"init"} synchronously inside mountWorkerExtension.
  await Promise.resolve();
  const worker = FakeWorker.last as FakeWorker;
  worker.emit({ t: "manifest", manifest: manifest as never });
  await Promise.resolve();
  await Promise.resolve();
  worker.emit({ t: "activated", ok: true });
  const result = await pending;
  return { worker, result };
}

const BASE_MANIFEST = {
  id: "test.addin",
  name: "Test Add-in",
  version: "1.0.0",
  workerSupport: true,
};

/**
 * Let the cell-style render cache complete one stale-while-revalidate round
 * trip: the rAF that drains the miss queue, the async resolver, the worker RPC
 * (the FakeWorker answers on a microtask) and the write-back into the cache.
 */
async function settleRenderCache(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("extension contribution ceiling", () => {
  let host: typeof import("../extensionWorkerHost");
  let formulas: typeof import("../../formulaFunctions");

  beforeEach(async () => {
    vi.resetModules();
    toasts.length = 0;
    globalScope[WORKER_GLOBAL] = FakeWorker;
    host = await import("../extensionWorkerHost");
    formulas = await import("../../formulaFunctions");
  });

  afterEach(async () => {
    await host.resetWorkerExtensions();
    globalScope[WORKER_GLOBAL] = originalWorker;
  });

  // --------------------------------------------------------------------------
  // 1. End to end
  // --------------------------------------------------------------------------

  it("a sandboxed extension registers a worksheet function that evaluates through the worker", async () => {
    // formula.udf must be DECLARED in the authoritative manifest for the
    // registration to be admitted. It is NOT separately JIT-granted: the
    // package consent that listed these function names by name is the consent,
    // and the host writes the grant down at registration so the transparency
    // panel reflects it (see setupFormulaRegistration).
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: ["formula.udf"],
      contributes: { formulas: ["VATRATE"] },
    });

    worker.handlers.set(7, (country) => (country === "SE" ? 0.25 : 0));
    worker.register({
      kind: "formula",
      regId: 1,
      handlerId: 7,
      def: { name: "vatrate", params: ["country"], description: "VAT rate" },
    });

    const def = formulas.getCustomFunction("VATRATE");
    expect(def, "the function must be in the worksheet-function registry").toBeDefined();
    // Attribution is host-supplied — the catalog always names the add-in.
    expect(def!.category).toBe("Test Add-in");
    expect(def!.syntax).toBe("VATRATE(country)");
    expect(def!.minArgs).toBe(1);
    expect(def!.maxArgs).toBe(1);

    // The value a cell would receive comes back OUT of the worker realm.
    await expect(def!.implementation("SE")).resolves.toBe(0.25);
    await expect(def!.implementation("US")).resolves.toBe(0);

    expect(
      host.listExtensionContributions().find((c) => c.kind === "formula")?.id,
    ).toBe("VATRATE");
  });

  it("unregistering the contribution removes the function from the registry", async () => {
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: ["formula.udf"],
      contributes: { formulas: ["VATRATE"] },
    });
    worker.handlers.set(7, () => 1);
    worker.register({ kind: "formula", regId: 1, handlerId: 7, def: { name: "VATRATE" } });
    expect(formulas.hasCustomFunction("VATRATE")).toBe(true);

    worker.emit({ t: "unregister", regId: 1 });
    expect(formulas.hasCustomFunction("VATRATE")).toBe(false);
    expect(host.listExtensionContributions()).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 2. Fail closed
  // --------------------------------------------------------------------------

  it("an UNDECLARED contribution is refused, not silently dropped", async () => {
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: ["formula.udf"],
      contributes: { formulas: ["VATRATE"] },
    });
    worker.handlers.set(9, () => 42);
    worker.register({ kind: "formula", regId: 2, handlerId: 9, def: { name: "SNEAKY" } });

    expect(formulas.hasCustomFunction("SNEAKY")).toBe(false);
    const refusal = host.listExtensionContributions().find((c) => c.id === "SNEAKY");
    expect(refusal?.refusedReason, "the refusal must be recorded for the user").toContain(
      "does not list",
    );
    expect(toasts.some((t) => t.includes("SNEAKY")), "the user must be told").toBe(true);
  });

  it("declaring a formula WITHOUT the formula.udf capability is refused (the unsigned-manifest case)", async () => {
    // An unsigned / invalid / publisherChanged sidecar arrives here with an
    // EMPTY capability list (ExtensionManager zeroes it), so this is exactly
    // what an unsigned add-in's worksheet function does.
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: [],
      contributes: { formulas: ["VATRATE"] },
    });
    worker.handlers.set(3, () => 1);
    worker.register({ kind: "formula", regId: 1, handlerId: 3, def: { name: "VATRATE" } });

    expect(formulas.hasCustomFunction("VATRATE")).toBe(false);
    expect(
      host.listExtensionContributions().find((c) => c.id === "VATRATE")?.refusedReason,
    ).toContain("formula.udf");
  });

  it("an add-in with NO contributes block contributes nothing", async () => {
    const { worker } = await mountFake(host, { ...BASE_MANIFEST });
    worker.handlers.set(1, () => undefined);
    worker.register({ kind: "command", regId: 1, id: "doThing", handlerId: 1 });
    const { CommandRegistry } = await import("../../commands");
    expect(CommandRegistry.has("ext:test.addin:doThing")).toBe(false);
    expect(host.listExtensionContributions()[0]?.refusedReason).toBeDefined();
  });

  it("a declared command IS installed under a namespaced id", async () => {
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      contributes: { commands: ["doThing"] },
    });
    worker.handlers.set(1, () => "done");
    worker.register({ kind: "command", regId: 1, id: "doThing", handlerId: 1 });
    const { CommandRegistry } = await import("../../commands");
    expect(CommandRegistry.has("ext:test.addin:doThing")).toBe(true);
    await expect(CommandRegistry.execute("ext:test.addin:doThing")).resolves.toBe("done");
    // Never script-safe by default: another script must not be able to drive it.
    expect(CommandRegistry.isScriptSafe("ext:test.addin:doThing")).toBe(false);
  });

  it("a name COLLISION is a loud refusal, never a silent overwrite or rename", async () => {
    const first = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: ["formula.udf"],
      contributes: { formulas: ["VATRATE"] },
    });
    first.worker.handlers.set(1, () => "first");
    first.worker.register({ kind: "formula", regId: 1, handlerId: 1, def: { name: "VATRATE" } });

    const second = await mountFake(host, {
      ...BASE_MANIFEST,
      id: "other.addin",
      name: "Other Add-in",
      capabilities: ["formula.udf"],
      contributes: { formulas: ["VATRATE"] },
    });
    second.worker.handlers.set(1, () => "second");
    second.worker.register({ kind: "formula", regId: 1, handlerId: 1, def: { name: "VATRATE" } });

    // The FIRST registration still owns the name.
    await expect(formulas.getCustomFunction("VATRATE")!.implementation()).resolves.toBe("first");
    expect(
      host
        .listExtensionContributions()
        .find((c) => c.extId === "other.addin" && c.refusedReason)?.refusedReason,
    ).toContain("already registered");
  });

  it("an invalid function name is refused rather than mangled", async () => {
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: ["formula.udf"],
      contributes: { formulas: ["MY.FN"] },
    });
    worker.handlers.set(1, () => 1);
    worker.register({ kind: "formula", regId: 1, handlerId: 1, def: { name: "MY.FN" } });
    expect(formulas.hasCustomFunction("MY.FN")).toBe(false);
    expect(
      host.listExtensionContributions().find((c) => c.refusedReason)?.refusedReason,
    ).toContain("not a valid function name");
  });

  it("a style override returned by sandboxed code is sanitized key-by-key", () => {
    expect(
      host.sanitizeStyleOverride({
        backgroundColor: "#ff0000",
        textColor: "javascript:alert(1)",
        bold: true,
        fontSize: 5000,
        borderTopStyle: "thin",
        borderTopColor: "#000000",
        borderLeftStyle: "wiggly",
        nonsense: "dropped",
      }),
    ).toEqual({
      backgroundColor: "#ff0000",
      bold: true,
      borderTopStyle: "thin",
      borderTopColor: "#000000",
    });
    expect(host.sanitizeStyleOverride({ nonsense: 1 })).toBeNull();
    expect(host.sanitizeStyleOverride(null)).toBeNull();
    expect(host.sanitizeStyleOverride("#fff")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 2b. IMPERSONATION + TAKEOVER (Wave F integration review)
  // --------------------------------------------------------------------------
  // Every one of these was reachable when the add-in slice landed: the ceiling
  // pins the ID a contribution registers under, but not the label it renders, not
  // the shortcut it claims, and not the file extension it answers for.

  it("a menu item is ATTRIBUTED to its add-in, so it cannot pose as a built-in", async () => {
    const ui = await import("../../ui");
    ui.registerMenu({ id: "file", label: "File", order: 0, items: [] });
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      contributes: { menuItems: ["file/refresh"] },
    });
    worker.register({
      kind: "menuItem",
      regId: 1,
      menuId: "file",
      // A declared id, an undeclared (and deliberately first-party-looking) label.
      item: { id: "refresh", label: "Save As…" },
      handlerId: 1,
    });
    const { getMenus } = await import("../../ui");
    const item = getMenus()
      .flatMap((m) => m.items ?? [])
      .find((i) => i.id === "ext:test.addin:refresh");
    expect(item).toBeDefined();
    expect(item!.label).toBe("Save As… (Test Add-in)");
  });

  it("a menu label cannot use control or bidi characters to rewrite its attribution", async () => {
    const ui = await import("../../ui");
    ui.registerMenu({ id: "file", label: "File", order: 0, items: [] });
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      contributes: { menuItems: ["file/x"] },
    });
    worker.register({
      kind: "menuItem",
      regId: 1,
      menuId: "file",
      item: { id: "x", label: "Save\n‮evil‬" },
      handlerId: 1,
    });
    const { getMenus } = await import("../../ui");
    const item = getMenus()
      .flatMap((m) => m.items ?? [])
      .find((i) => i.id === "ext:test.addin:x");
    expect(item!.label).toBe("Save evil (Test Add-in)");
    expect(item!.label).not.toMatch(/[‪-‮\n]/);
  });

  it("a keyboard shortcut that is ALREADY BOUND is refused, never quietly duplicated", async () => {
    const keys = await import("../../keybindings");
    const releaseBuiltIn = keys.registerKeybinding({
      id: "core.some.feature",
      combo: "Ctrl+Shift+J",
      commandId: "core.some.feature",
      label: "Some feature",
      category: "Editing",
    });
    try {
      const { worker } = await mountFake(host, {
        ...BASE_MANIFEST,
        contributes: { keybindings: ["steal"] },
      });
      worker.register({
        kind: "keybinding",
        regId: 1,
        binding: { id: "steal", combo: "Ctrl+Shift+J", command: "doThing", label: "Totally fine" },
      });
      expect(keys.getAllKeybindings().some((b) => b.id === "ext:test.addin:steal")).toBe(false);
      expect(
        host.listExtensionContributions().find((c) => c.refusedReason)?.refusedReason,
      ).toContain("already bound");
    } finally {
      releaseBuiltIn();
    }
  });

  // G2: the conflict check reads the keybinding REGISTRY, which never contained
  // the keys the grid owns (F9, Escape, Tab, arrows, plain typing) and stops
  // containing a built-in the moment the user remaps it. So a shortcut that
  // nothing has "registered" is not thereby free, and an add-in asking for one
  // is now refused by SHAPE. This case used to PASS — Ctrl+Alt+Shift+F9 was the
  // example of a legal shortcut — which is exactly why it is pinned now.
  it("a shortcut outside Ctrl+Shift+<letter> is refused even when nothing has registered it", async () => {
    const keys = await import("../../keybindings");
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      contributes: { keybindings: ["grabby"] },
    });
    worker.register({
      kind: "keybinding",
      regId: 1,
      binding: { id: "grabby", combo: "Ctrl+Alt+Shift+F9", command: "doThing", label: "Do it" },
    });
    expect(keys.getAllKeybindings().some((b) => b.id === "ext:test.addin:grabby")).toBe(false);
    expect(
      host.listExtensionContributions().find((c) => c.refusedReason)?.refusedReason,
    ).toContain("Ctrl+Shift+<letter>");
  });

  it("an UNUSED shortcut is still allowed, and is attributed to the add-in", async () => {
    const keys = await import("../../keybindings");
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      contributes: { keybindings: ["mine"] },
    });
    worker.register({
      kind: "keybinding",
      regId: 1,
      binding: { id: "mine", combo: "Ctrl+Shift+J", command: "doThing", label: "Do it" },
    });
    const bound = keys.getAllKeybindings().find((b) => b.id === "ext:test.addin:mine");
    expect(bound).toBeDefined();
    expect(bound!.category).toBe("Test Add-in");
  });

  it("a file extension another importer already handles is refused (no silent CSV takeover)", async () => {
    const formatsMod = await import("../../fileFormats");
    const releaseBuiltIn = formatsMod.registerFileFormat({
      id: "core.csv",
      name: "CSV",
      extensions: ["csv"],
      priority: 0,
      importer: async () => ({ sheets: [{ name: "real", cells: [] }] }),
    });
    try {
      const { worker } = await mountFake(host, {
        ...BASE_MANIFEST,
        contributes: { fileFormats: ["evil"] },
      });
      worker.register({
        kind: "fileFormat",
        regId: 1,
        handlerId: 1,
        format: { id: "evil", name: "Definitely CSV", extensions: ["csv"], priority: 9999 },
      });
      // The built-in still owns .csv...
      expect(formatsMod.findImporter("book.csv")?.id).toBe("core.csv");
      // ...and the attempt was refused out loud.
      expect(
        host.listExtensionContributions().find((c) => c.refusedReason)?.refusedReason,
      ).toContain("already handled");
    } finally {
      releaseBuiltIn();
    }
  });

  it("an add-in importer for a FREE extension registers, but always sorts below built-ins", async () => {
    const formatsMod = await import("../../fileFormats");
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      contributes: { fileFormats: ["taxdata"] },
    });
    worker.register({
      kind: "fileFormat",
      regId: 1,
      handlerId: 1,
      format: { id: "taxdata", name: "Tax data", extensions: [".TaxData"], priority: 9999 },
    });
    const reg = formatsMod.getFileFormats().find((f) => f.id === "ext:test.addin:taxdata");
    expect(reg).toBeDefined();
    expect(reg!.extensions).toEqual(["taxdata"]);
    // Priority is host-decided and below every built-in, so a later-registering
    // built-in for the same extension would still win the lookup.
    expect(reg!.priority).toBeLessThan(0);
    expect(reg!.name).toBe("Tax data (Test Add-in)");
  });

  it("refusals are bounded: a register-spam loop cannot become a toast channel", async () => {
    const { worker } = await mountFake(host, { ...BASE_MANIFEST });
    for (let i = 0; i < 40; i++) {
      worker.register({ kind: "command", regId: i + 1, id: `spam${i}`, handlerId: 1 });
    }
    // Every attempt was refused (nothing installed)...
    const { CommandRegistry } = await import("../../commands");
    expect(CommandRegistry.has("ext:test.addin:spam39")).toBe(false);
    // ...but the user-visible half stopped early, with one row saying why.
    expect(toasts.length).toBeLessThanOrEqual(10);
    expect(toasts[toasts.length - 1]).toContain("suppressed");
    expect(host.listExtensionContributions().length).toBeLessThanOrEqual(10);
  });

  it("a cell-style contribution declares its REACH in the label the user reads", async () => {
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: ["grid.read"],
      contributes: { cellStyles: ["negatives"] },
    });
    worker.register({ kind: "cellStyle", regId: 1, id: "negatives", handlerId: 1 });
    const c = host.listExtensionContributions().find((x) => x.kind === "cellStyle");
    expect(c).toBeDefined();
    expect(c!.refusedReason).toBeUndefined();
    // "adds cell styling" hides that the handler is handed each cell's value.
    expect(c!.label).toContain("shown the cells it styles");
  });

  // --------------------------------------------------------------------------
  // 2b. grid.read — the cells the user is looking at (B2)
  // --------------------------------------------------------------------------

  it("a cell-style contribution WITHOUT grid.read is refused, and no cell ever reaches it", async () => {
    // The unsigned/tampered case verbatim: ExtensionManager zeroes `capabilities`,
    // so this is what an add-in nobody signed looks like when it asks to be shown
    // the workbook. The contribution is DECLARED — the ceiling alone would admit
    // it — and it is still refused, because declaring a surface is not consenting
    // to the data that flows through it.
    const styles = await import("../../styleInterceptors");
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: [],
      contributes: { cellStyles: ["negatives"] },
    });
    let sawCells: unknown = null;
    worker.handlers.set(4, (cells) => {
      sawCells = cells;
      return [];
    });
    worker.register({ kind: "cellStyle", regId: 1, id: "negatives", handlerId: 4 });

    // THE PROPERTY THAT MATTERS, asserted FIRST so it is what fails if the gate
    // is ever removed. Paint two cells for real: no style interceptor exists, so
    // the paint path never even collects the cells to ask about, and nothing
    // crosses into the worker.
    expect(
      styles.getStyleInterceptors().some((i) => i.id.includes("test.addin")),
      "no interceptor may exist for a refused contribution",
    ).toBe(false);
    styles.applyStyleInterceptors("SALARY-99000", {}, { row: 0, col: 0, sheetIndex: 0 });
    styles.applyStyleInterceptors("-42", {}, { row: 1, col: 0, sheetIndex: 0 });
    await settleRenderCache();
    expect(sawCells, "no cell may have crossed into the worker").toBeNull();
    expect(
      JSON.stringify(worker.received),
      "not one cell value may appear in anything posted into the worker",
    ).not.toContain("SALARY-99000");

    // ...and the refusal is LOUD: the manager row, the reason, and the toast.
    const c = host.listExtensionContributions().find((x) => x.kind === "cellStyle");
    expect(c?.refusedReason, "a refusal must be recorded for the user").toContain("grid.read");
    expect(toasts.some((t) => t.includes("negatives"))).toBe(true);
  });

  it("with grid.read the contributor really is handed the cells' values", async () => {
    const styles = await import("../../styleInterceptors");
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: ["grid.read"],
      contributes: { cellStyles: ["negatives"] },
    });
    const seen: Array<Array<{ value: string }>> = [];
    worker.handlers.set(5, (cells) => {
      seen.push(cells as Array<{ value: string }>);
      return (cells as Array<{ value: string }>).map((cell) =>
        cell.value.startsWith("-") ? { textColor: "#ff0000" } : null,
      );
    });
    worker.register({ kind: "cellStyle", regId: 1, id: "negatives", handlerId: 5 });

    // Drive the REAL paint path: first frame is a cache miss (base style), the
    // batch goes out off the paint path, the second frame serves the answer.
    styles.applyStyleInterceptors("-42", {}, { row: 0, col: 0, sheetIndex: 0 });
    styles.applyStyleInterceptors("7", {}, { row: 1, col: 0, sheetIndex: 0 });
    await settleRenderCache();

    // This is the disclosure the capability is FOR: the add-in was shown the
    // cells' displayed values, not merely their coordinates.
    expect(seen).toHaveLength(1);
    expect(seen[0].map((cell) => cell.value).sort()).toEqual(["-42", "7"]);

    expect(
      styles.applyStyleInterceptors("-42", {}, { row: 0, col: 0, sheetIndex: 0 }).textColor,
    ).toBe("#ff0000");
    expect(
      styles.applyStyleInterceptors("7", {}, { row: 1, col: 0, sheetIndex: 0 }).textColor,
    ).toBeUndefined();

    // ...and the capability is written down, so the transparency panel shows a
    // reach that is genuinely in use rather than only a label on a contribution.
    const { getScriptGrants } = await import("../capabilities");
    expect(getScriptGrants("extension:test.addin").caps).toContain("grid.read");
  });

  it("a cell-style batch re-checks grid.read at delivery, not only at registration", async () => {
    // The render cache outlives the registration message. If the ceiling is gone
    // by the time a batch is due, the batch must not go out — and the answer must
    // be the documented DEGRADED one (keep base styling), never a batch of
    // blanked cells that would look to the add-in like an empty workbook.
    const styles = await import("../../styleInterceptors");
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: ["grid.read"],
      contributes: { cellStyles: ["negatives"] },
    });
    let calls = 0;
    worker.handlers.set(6, (cells) => {
      calls++;
      return (cells as unknown[]).map(() => ({ backgroundColor: "#00ff00" }));
    });
    worker.register({ kind: "cellStyle", regId: 1, id: "negatives", handlerId: 6 });
    styles.applyStyleInterceptors("x", {}, { row: 0, col: 0, sheetIndex: 0 });
    await settleRenderCache();
    expect(calls).toBe(1);

    // Simulate the ceiling being lost (revoke / remount with a bad signature).
    const { listMountedHandles } = await import("../broker");
    const handle = listMountedHandles().find((h) => h.scriptId === "extension:test.addin")!;
    (handle.declaredCapabilities as Set<string>).delete("grid.read");

    styles.applyStyleInterceptors("y", {}, { row: 1, col: 0, sheetIndex: 0 });
    await settleRenderCache();
    expect(calls, "no further batch may reach the worker").toBe(1);
    // Degraded, not blanked: the cell keeps whatever the base style says.
    expect(
      styles.applyStyleInterceptors("y", {}, { row: 1, col: 0, sheetIndex: 0 }).backgroundColor,
    ).toBeUndefined();
  });

  it("cell-change EVENTS are the second reader, and they are redacted without grid.read", async () => {
    // An event subscription is NOT a contribution: it is never named in the
    // sidecar manifest and never shown in the consent prompt. So an add-in that
    // subscribes to cell-values-changed was being handed every changed cell's
    // old value, new value and formula through a door nobody had counted.
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: [],
      contributes: {},
    });
    worker.register({
      kind: "event",
      regId: 1,
      eventName: AppEvents.CELL_VALUES_CHANGED,
      handlerId: 11,
    });
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 3, col: 4, sheetIndex: 0, oldValue: "40000", newValue: "95000", formula: null }],
      source: "user",
    });
    const delivered = worker.received.filter((m) => m.t === "appEvent");
    expect(delivered, "the handler must still fire — this is redaction, not a mute").toHaveLength(1);
    const payload = delivered[0].payload as {
      changes: Array<Record<string, unknown>>;
      source: string;
      redacted: string;
    };
    // WHERE survives; WHAT does not.
    expect(payload.changes[0]).toEqual({ row: 3, col: 4, sheetIndex: 0 });
    expect(JSON.stringify(payload)).not.toContain("95000");
    expect(JSON.stringify(payload)).not.toContain("40000");
    // Not silent: the absence is named, so it cannot read as "nothing changed".
    expect(payload.redacted).toBe("grid.read");
    expect(payload.source).toBe("user");
  });

  it("with grid.read the same subscription receives the values in full", async () => {
    const { worker } = await mountFake(host, {
      ...BASE_MANIFEST,
      capabilities: ["grid.read"],
      contributes: {},
    });
    worker.register({
      kind: "event",
      regId: 1,
      eventName: AppEvents.CELL_VALUES_CHANGED,
      handlerId: 11,
    });
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 3, col: 4, newValue: "95000" }],
      source: "user",
    });
    const payload = worker.received.find((m) => m.t === "appEvent")!.payload as {
      changes: Array<{ newValue?: string }>;
    };
    expect(payload.changes[0].newValue).toBe("95000");
    // Subscribing IS the use, so the grant is recorded even though this add-in
    // registers no contribution at all — otherwise it would be the one holder of
    // grid.read that never appears in the transparency panel.
    const { getScriptGrants } = await import("../capabilities");
    expect(getScriptGrants("extension:test.addin").caps).toContain("grid.read");
  });

  it("EDIT_ENDED loses the typed value but keeps the coordinates", async () => {
    const { worker } = await mountFake(host, { ...BASE_MANIFEST, capabilities: [] });
    worker.register({ kind: "event", regId: 1, eventName: AppEvents.EDIT_ENDED, handlerId: 12 });
    emitAppEvent(AppEvents.EDIT_ENDED, {
      row: 2,
      col: 1,
      sheetIndex: 0,
      value: "=SUM(Payroll!A:A)",
      committed: true,
    });
    const payload = worker.received.find((m) => m.t === "appEvent")!.payload as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      row: 2,
      col: 1,
      sheetIndex: 0,
      committed: true,
      redacted: "grid.read",
    });
  });

  it("a coordinate-only event is untouched — redaction is scoped to cell CONTENTS", async () => {
    const { worker } = await mountFake(host, { ...BASE_MANIFEST, capabilities: [] });
    worker.register({
      kind: "event",
      regId: 1,
      eventName: AppEvents.SELECTION_CHANGED,
      handlerId: 13,
    });
    emitAppEvent(AppEvents.SELECTION_CHANGED, {
      row: 5,
      col: 6,
      startRow: 5,
      startCol: 6,
      endRow: 5,
      endCol: 6,
    });
    const payload = worker.received.find((m) => m.t === "appEvent")!.payload as Record<
      string,
      unknown
    >;
    expect(payload.endRow).toBe(5);
    expect((payload as { redacted?: string }).redacted).toBeUndefined();
  });

  it("a broker method outside EXTENSION_BROKER_METHODS is refused before the broker", async () => {
    const { worker } = await mountFake(host, { ...BASE_MANIFEST });
    // api.setCellValue is a real ALLOWLIST row — it is simply not part of the
    // sandboxed-extension gate. It must never reach the broker.
    worker.emit({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "x"] });
    await new Promise((r) => setTimeout(r, 0));
    const answer = worker.received.find(
      (m) => m.t === "callResult" && m.callId === 1,
    ) as { ok: boolean; error?: { code: string } } | undefined;
    expect(answer?.ok).toBe(false);
    expect(answer?.error?.code).toBe("UnknownMethod");
  });
});

// ============================================================================
// 3. Declaration helpers + drift guards
// ============================================================================

describe("contribution declaration normalization", () => {
  it("drops unknown kinds, non-strings, blanks and duplicates", () => {
    const d = normalizeContributionDeclaration({
      formulas: ["  VATRATE ", "VATRATE", 42, "", null],
      nonsense: ["x"],
      commands: "not-an-array",
    });
    expect(d.formulas).toEqual(["VATRATE"]);
    expect((d as Record<string, unknown>).nonsense).toBeUndefined();
    expect(d.commands).toBeUndefined();
    expect(countContributions(d)).toBe(1);
  });

  it("declaring nothing means deny-by-default for every kind", () => {
    for (const kind of EXTENSION_CONTRIBUTION_KINDS) {
      expect(isContributionDeclared({}, kind, "anything")).toBe(false);
      expect(isContributionDeclared(undefined, kind, "anything")).toBe(false);
    }
  });

  it("formula names match case-insensitively; every other kind matches exactly", () => {
    expect(isContributionDeclared({ formulas: ["VATRATE"] }, "formula", "vatrate")).toBe(true);
    expect(isContributionDeclared({ commands: ["doThing"] }, "command", "dothing")).toBe(false);
    expect(isContributionDeclared({ commands: ["doThing"] }, "command", "doThing")).toBe(true);
  });
});

describe("contribution layer coverage (derived from source)", () => {
  const HOST_DIR = path.resolve(__dirname, "..");
  const read = (rel: string): string => fs.readFileSync(path.join(HOST_DIR, rel), "utf8");
  const workerContext = read("worker/extensionWorkerContext.ts");
  const hostSrc = read("extensionWorkerHost.ts");

  it("every contribution kind has a worker shim that posts it", () => {
    const posted = new Set(
      [...workerContext.matchAll(/kind:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
    );
    const missing = EXTENSION_CONTRIBUTION_KINDS.filter((k) => !posted.has(k));
    expect(
      missing,
      `these kinds are declared in the protocol but no worker shim registers them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every contribution kind has a host branch that installs it", () => {
    const handled = new Set(
      [...hostSrc.matchAll(/reg\.kind === "([a-zA-Z]+)"/g)].map((m) => m[1]),
    );
    const missing = EXTENSION_CONTRIBUTION_KINDS.filter((k) => !handled.has(k));
    expect(
      missing,
      `these kinds pass the ceiling gate but setupRegistration has no branch, so they would be admitted and then vanish: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every contribution kind has a declaration key and a label", () => {
    for (const kind of EXTENSION_CONTRIBUTION_KINDS) {
      expect(CONTRIBUTION_DECLARATION_KEY[kind], kind).toBeTruthy();
      expect(CONTRIBUTION_REGISTRATION_KINDS.has(kind), kind).toBe(true);
    }
  });

  it("every capability a contribution requires is a real capability id", () => {
    // NOT "is used by an ALLOWLIST row" any more. That was the right check while
    // every capability gated a CALL; `grid.read` gates a PUSH (the host handing
    // a cellStyle contributor the cells on screen), so it deliberately has no
    // method row, and the old assertion would have forced a fake one.
    for (const [kind, cap] of Object.entries(CONTRIBUTION_REQUIRED_CAPABILITY)) {
      expect(isCapabilityId(cap), `${kind} requires '${cap}', which is not a capability id`).toBe(
        true,
      );
    }
    // The two that exist today, pinned by name: both are the "receives workbook
    // data" kinds, and no third kind may join them without this test changing.
    expect(CONTRIBUTION_REQUIRED_CAPABILITY).toEqual({
      formula: "formula.udf",
      cellStyle: "grid.read",
    });
  });

  it("a contribution-required capability is reflected in what the surface can reach", () => {
    // extensionReachableCapabilities feeds the taxonomy row for this surface, so
    // a capability required by a contribution but missing from it would let the
    // transparency panel understate the add-in surface.
    const reachable = extensionReachableCapabilities();
    for (const cap of Object.values(CONTRIBUTION_REQUIRED_CAPABILITY)) {
      expect(reachable.has(cap!), `${cap} is required by a contribution but not reachable`).toBe(
        true,
      );
    }
    for (const cap of EXTENSION_PUSHED_DATA_CAPABILITIES) {
      expect(reachable.has(cap), `${cap} is pushed to this surface but not reachable`).toBe(true);
    }
  });

  it("the broker gate is ENFORCED in the host, not merely declared", () => {
    // The regression this pins: EXTENSION_BROKER_METHODS existed for months as
    // a comment ("anything not here is rejected by the broker") while nothing
    // read it — the only thing failing closed was the executor's default arm.
    expect(hostSrc).toContain("EXTENSION_BROKER_METHODS.has(method)");
    expect(EXTENSION_BROKER_METHODS.has("ext.invalidateCellStyles")).toBe(true);
    expect(ALLOWLIST["ext.invalidateCellStyles"]).toBeDefined();
  });
});

// ============================================================================
// 4. grid.read — the disclosure half (B2)
//
// A capability whose consent text does not name its reach is worse than no
// capability at all: it converts an undisclosed risk into a disclosed-looking
// one. These tests hold the text to the reach, and hold the redaction to the
// payload shapes it claims to cover.
// ============================================================================

describe("grid.read consent text and coverage", () => {
  it("the consent sentence names the real reach, in the user's words", () => {
    const text = describeCapability("grid.read");
    // What it is: being SHOWN cell contents. Not "access", not "grid".
    expect(text).toMatch(/shown/i);
    expect(text).toMatch(/cells/i);
    // Both paths, because a sentence that named only one would understate:
    // the cells on screen (styling) and the cells that change (events).
    expect(text).toMatch(/style|colou?r/i);
    expect(text).toMatch(/changes|formula/i);
    // And the honest limit, so a reader is not left imagining a data exfil.
    expect(text).toMatch(/cannot change/i);
    expect(text).toMatch(/network|file access/i);
  });

  it("the cellStyle contribution note tells the user it is now GATED, not just disclosed", () => {
    const note = CONTRIBUTION_REACH_NOTE.cellStyle!;
    expect(note).toMatch(/contents|reading|read/i);
    expect(note).toContain("grid.read");
    // Refused, not degraded-in-place: the user must not picture a styler that
    // keeps running with the values blanked out.
    expect(note).toMatch(/refused/i);
  });

  it("every capability id has a consent phrase in this module's map", () => {
    // describeCapability falls back to the raw id; a capability that reached a
    // user as "grid.read" would be a bare token in a security prompt.
    for (const id of ALL_CAPABILITY_IDS) {
      expect(describeCapability(id), id).not.toBe(id);
      expect(describeCapability(id).length, id).toBeGreaterThan(20);
    }
  });

  it("redaction strips every CONTENT field of a full cell-change payload", () => {
    // Rebuilt-not-deleted: this asserts the property that survives a payload
    // gaining a new field later. Anything that is not a coordinate must go.
    const payload = {
      changes: [
        {
          row: 1,
          col: 2,
          sheetIndex: 0,
          oldValue: "SECRET-OLD",
          newValue: "SECRET-NEW",
          formula: "=SECRET-FORMULA",
        },
      ],
      source: "paste",
    };
    const redacted = thinAppEventForScripts(AppEvents.CELL_VALUES_CHANGED, payload, {
      redactCellContents: true,
    });
    const json = JSON.stringify(redacted);
    expect(json).not.toContain("SECRET");
    expect(json).toContain('"row":1');
    // Without the option nothing is stripped: object scripts, whose grid reach
    // is tier-governed, must keep the payload they have always received.
    expect(thinAppEventForScripts(AppEvents.CELL_VALUES_CHANGED, payload)).toBe(payload);
  });

  it("the cell-content event set is exactly the events whose payload carries values", () => {
    // Pinned by NAME. The trap this guards: SELECTION_CHANGED and EDIT_STARTED
    // look like they belong here (they name a cell) and must not be redacted,
    // while EDIT_ENDED looks like a twin of EDIT_STARTED and carries the typed
    // value. Getting that backwards would either break coordinate-only
    // subscribers or leak the workbook.
    expect([...APP_EVENTS_CARRYING_CELL_CONTENTS].sort()).toEqual(
      [AppEvents.CELL_VALUES_CHANGED, AppEvents.EDIT_ENDED].sort(),
    );
    expect(APP_EVENTS_CARRYING_CELL_CONTENTS.has(AppEvents.SELECTION_CHANGED)).toBe(false);
    expect(APP_EVENTS_CARRYING_CELL_CONTENTS.has(AppEvents.EDIT_STARTED)).toBe(false);
  });

  it("the OTHER contribution kinds receive no workbook data (the enumeration, pinned)", () => {
    // The B2 audit, written down so a new kind cannot quietly join the list of
    // readers. For each kind: what its handler is invoked WITH.
    //   command / menuItem / ribbonButton / keybinding -> a click; no data.
    //   formula   -> the cell values passed as arguments  (formula.udf)
    //   cellStyle -> the displayed value of every cell    (grid.read)
    //   fileFormat-> the bytes of a FOREIGN file the user just chose to open;
    //                not the workbook, so it is disclosed rather than gated.
    const dataBearing: Record<string, string | undefined> = {
      formula: "formula.udf",
      cellStyle: "grid.read",
    };
    for (const kind of EXTENSION_CONTRIBUTION_KINDS) {
      expect(CONTRIBUTION_REQUIRED_CAPABILITY[kind], kind).toBe(dataBearing[kind]);
    }
    // fileFormat is the deliberate exclusion, and it must stay DISCLOSED.
    expect(CONTRIBUTION_REACH_NOTE.fileFormat).toMatch(/file/i);
  });
});
