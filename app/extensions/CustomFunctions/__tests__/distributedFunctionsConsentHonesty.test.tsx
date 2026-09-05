//! FILENAME: app/extensions/CustomFunctions/__tests__/distributedFunctionsConsentHonesty.test.tsx
// PURPOSE: The distributed-functions consent prompt must describe the realm a
//          publisher's functions actually get, sentence by sentence, and every
//          sentence must be pinned to the code that makes it true.
// CONTEXT: The prompt used to say the functions "share this workbook's one
//          Custom Functions sandbox" and that allowing them "hands this
//          publisher's code everything that sandbox already holds". Since the
//          per-origin realm split (`planCustomFunctionRealms` in
//          @api/customFunctions) neither is true: an application's functions
//          mount in a worker realm of their own under
//          `customFunctionScriptId(package)`, and `fns.OTHER()` never crosses a
//          realm. What IS shared is the library's ONE capability list —
//          `rawInstall` hands `lib.capabilities` to every realm — so the
//          enumeration was right while the sentence around it was not.
//
//          The capability-free branch understated the other way: "can only
//          compute from the arguments it is given" denied reach the realm has
//          with no capability at all. `brokerPolicy.ts` decides on tier and
//          capability alone — it never looks at the object type — so every
//          `tier: "restricted"` row without a `capability` in
//          scriptHost/allowlist.ts that host.ts implements is admitted to this
//          realm: the whole sheet.* family (cells of the sheet currently shown),
//          base.notify, base.log, base.expose/callMethod/callImport,
//          events.subscribe, form.define. And the workbook typed context
//          (worker/contextShims.ts `case "workbook"`) gives a body hooks —
//          onOpen, onBeforeSave, onBeforeClose, onBeforePrint, the sheet
//          collection hooks — that keep running after the cell that first
//          called the function is gone, three of which can VETO the operation.
//          A consent screen that understates reach is worse than none: the
//          user's Allow answers a different question from the one the code
//          will act on (the finding consentTextHonesty.test.ts records for the
//          object-script prompt).
//
//          THE SENTENCES ARE PINNED AGAINST THE SOURCE, NOT AGAINST MEMORY.
//          The reach rows are derived from the ALLOWLIST as data, filtered by
//          what host.ts's executor actually switches on; the hooks and
//          properties are parsed out of contextShims.ts's workbook case. Each
//          derived item must map to a clause this file knows, and each clause
//          must appear in the rendered prompt — on BOTH branches, because a
//          capability list adds to the restricted reach and never replaces it.
//          A row, hook or property added upstream without a sentence here goes
//          red instead of silently widening the reach behind an unchanged
//          prompt. Same technique as macroSurfaceReachHonesty.test.tsx and
//          formConsentHonesty.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ALLOWLIST } from "@api/scriptHost/allowlist";

vi.mock("@api", () => ({
  emitAppEvent: () => undefined,
}));

vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({
    ref: React.createRef<HTMLDivElement>(),
    style: {},
    onHeaderMouseDown: () => undefined,
    resizeHandles: null,
    reset: () => undefined,
  }),
}));

import { DistributedFunctionsConsentDialog } from "../components/DistributedFunctionsConsentDialog";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8");

/** Strip comments so a scanner never reads a quoted false claim as a live one. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const HOST = code(read("src/api/scriptHost/host.ts"));
const SHIMS = code(read("src/api/scriptHost/worker/contextShims.ts"));
const CUSTOM_FUNCTIONS = code(read("src/api/customFunctions.ts"));
/** Unstripped: the consent-source pragma is a `// @capability` INSIDE a template
 *  string, which the line-comment rule above would eat. */
const CUSTOM_FUNCTIONS_RAW = read("src/api/customFunctions.ts");
const BROKER = code(read("src/api/scriptHost/broker.ts"));
const BROKER_POLICY = code(read("src/api/scriptHost/brokerPolicy.ts"));
const DIALOG_SOURCE = read("extensions/CustomFunctions/components/DistributedFunctionsConsentDialog.tsx");

// ===========================================================================
// The reach, read out of the code
// ===========================================================================

/**
 * Every ALLOWLIST row a restricted realm may call with NO capability, that the
 * object-script host actually implements. The ALLOWLIST is imported as data;
 * "implemented" is read from host.ts, because rows the extension-worker host
 * owns (`ext.*`) and host-driven rows the worker never names (`form.readControl`)
 * are in the table but not in this realm's executor.
 */
function capabilityFreeRestrictedRows(): string[] {
  return Object.entries(ALLOWLIST)
    .filter(([, p]) => p.tier === "restricted" && p.capability === undefined)
    .map(([name]) => name)
    .filter((name) => HOST.includes(`case "${name}":`))
    .sort();
}

/**
 * The prompt's clause for one reach row. Grouped by what the row DOES, so a
 * user reads "read and write the cells of the sheet currently shown" once, not
 * eleven times — but every row must land in some group, or the test fails.
 */
function clauseForRow(row: string): string | undefined {
  switch (row) {
    // ONE CASE PER SHEET ROW, deliberately not a `startsWith("sheet.")` rule: a
    // prefix would let a new `sheet.*` row with different reach (a sheet-wide
    // clear, a protection change) pass under a sentence written for these
    // eleven, which is the silent widening this whole test exists to refuse.
    case "sheet.getCellValue":
    case "sheet.getCellData":
    case "sheet.getCellFormula":
    case "sheet.getCellFormat":
    case "sheet.getRangeValues":
    case "sheet.getRangeFormat":
    case "sheet.setCellValue":
    case "sheet.setCellFormula":
    case "sheet.setRangeValues":
    case "sheet.setRangeFormat":
    case "sheet.clearRangeFormat":
      return "read and write the cells of the sheet currently shown";
    case "base.notify":
      return "show you a notification";
    case "base.log":
      return "write to the script console";
    case "base.expose":
    case "base.unexpose":
      return "offer methods of its own to other scripts";
    case "base.callMethod":
      return "call methods other scripts have made public";
    case "base.callImport":
      return "call the shared code libraries this workbook's Custom Functions library declares it uses";
    case "events.subscribe":
      return "listen for this workbook's events";
    case "form.define":
      return "lay out a form of its own (showing it takes the dialog permission)";
    // Own-object rows: every aspect host.ts dispatches is keyed by the mount's
    // instance id, and a formula library mounts under a random reserved
    // instance that names no chart, shape, slicer, pivot, table or panel.
    case "object.getState":
    case "object.setState":
    case "render.invalidate":
      return "It has no chart, shape or slicer of its own to act on.";
    default:
      return undefined;
  }
}

/** The `case "workbook":` block of buildTyped, comments already stripped. */
function workbookContextBlock(): string {
  const start = SHIMS.indexOf('case "workbook":');
  expect(start, "contextShims.ts has no workbook typed context").toBeGreaterThan(-1);
  const end = SHIMS.indexOf('case "sheet":', start);
  expect(end, "the workbook case is not followed by the sheet case").toBeGreaterThan(start);
  return SHIMS.slice(start, end);
}

/** Every `onXxx:` hook the workbook context offers. */
function workbookHooks(): string[] {
  return [...new Set([...workbookContextBlock().matchAll(/\b(on[A-Z]\w*):/g)].map((m) => m[1]))].sort();
}

/** The hooks whose verdict the host AWAITS — the ones that can veto. */
function workbookReplyingHooks(): string[] {
  return [
    ...new Set(
      [...workbookContextBlock().matchAll(/registerReplyingHook\(rt,\s*"(on\w+)"/g)].map((m) => m[1]),
    ),
  ].sort();
}

/** Every property getter / method under `properties: { ... }`. */
function workbookProperties(): string[] {
  const block = workbookContextBlock();
  const start = block.indexOf("properties:");
  expect(start, "workbook context has no properties").toBeGreaterThan(-1);
  const props = block.slice(start);
  const getters = [...props.matchAll(/get (\w+)\(\)/g)].map((m) => m[1]);
  const methods = [...props.matchAll(/^\s*(\w+)\(\)\s*\{/gm)].map((m) => m[1]);
  return [...new Set([...getters, ...methods])].sort();
}

describe("what the prompt says about WHEN the code runs is true", () => {
  it("names both triggers: a cell using the function, and the library loading", () => {
    // `generateLibrarySource` splices the publisher's body INSIDE an arrow
    // function, so ordinarily it runs only when a cell calls it — but nothing
    // refuses a body whose `}` closes that function early, and whatever follows
    // then runs at every load of this workbook's functions. A sentence that
    // said "whenever a cell uses it" and nothing else was false in exactly the
    // case a consent screen exists for.
    expect(DIALOG_SOURCE).not.toContain("runs whenever a cell uses it");
    expect(DIALOG_SOURCE).toContain("It runs when a cell uses it");
    expect(DIALOG_SOURCE).toContain(
      "sits outside the function body runs every time this workbook&apos;s functions load",
    );
  });

  it("'handlers that run when this workbook opens' is DELIVERED, not just promised", () => {
    // The host replays `workbook.onOpen` only to a mount whose definition says
    // `mountCause: "open"` (host.ts: `openReplayPending`). This realm never said
    // so, so a consented library's onOpen never fired while the prompt promised
    // it would. The open-driven install now says it, all the way down.
    expect(CUSTOM_FUNCTIONS).toContain("mountCause: opts.cause");
    expect(CUSTOM_FUNCTIONS).toContain('opts: { cause?: "open" } = {}');
    const EXT = read("extensions/CustomFunctions/index.ts");
    expect(EXT).toContain('loadAndInstallCustomFunctions({ cause: "open" })');
    // ...from the AFTER_OPEN handler specifically, not the activation install.
    const afterOpen = EXT.indexOf("AppEvents.AFTER_OPEN");
    const withCause = EXT.indexOf('loadAndInstallCustomFunctions({ cause: "open" })');
    expect(afterOpen).toBeGreaterThan(-1);
    expect(withCause).toBeGreaterThan(afterOpen);
    // The gate on the host side is the real thing this sentence rests on.
    expect(HOST).toContain('openReplayPending: definition.mountCause === "open"');
  });
});

const HOOK_CLAUSE = new Map<string, string>([
  ["onOpen", "when this workbook opens"],
  ["onBeforeSave", "is saved"],
  ["onAfterSave", "is saved"],
  ["onBeforeClose", "closed"],
  ["onBeforePrint", "printed"],
  ["onThemeChange", "when its theme changes"],
  ["onSheetChange", "a sheet is switched"],
  ["onSheetAdd", "added"],
  ["onSheetDelete", "deleted"],
  ["onSheetRename", "renamed"],
]);

/** The veto sentence, and the word in it that names each replying hook. */
const VETO_SENTENCE = "a handler can block the save, close or print";
const VETO_WORD = new Map<string, string>([
  ["onBeforeSave", "save"],
  ["onBeforeClose", "close"],
  ["onBeforePrint", "print"],
]);

const PROPERTY_CLAUSE = new Map<string, string>([
  ["title", "title"],
  ["author", "author"],
  ["sheetCount", "sheet count"],
  ["getSheetNames", "sheet names"],
]);

// ===========================================================================
// Rendering
// ===========================================================================

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

function render(data: Record<string, unknown>): string {
  act(() => {
    root.render(
      React.createElement(DistributedFunctionsConsentDialog, {
        onClose: () => undefined,
        data,
      } as never),
    );
  });
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

const NO_CAPS = {
  packageName: "Acme Finance Pack",
  functionNames: ["VENDORRATE", "FXRATE"],
  requestedCapabilities: [],
};

const WITH_CAPS = {
  ...NO_CAPS,
  requestedCapabilities: [
    { capability: "net.fetch", description: "fetch data from the web" },
    { capability: "bi.query", description: "run read-only BI queries (model-scoped)" },
  ],
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

// ===========================================================================

describe("the premise, read from the code", () => {
  it("an application's functions mount in a restricted realm of their own, not the subscriber's", () => {
    // A per-package script id, derived from the stamp — not the library's id.
    expect(CUSTOM_FUNCTIONS).toMatch(/return name === "" \? LIB_SCRIPT_ID : `\$\{LIB_SCRIPT_ID\}pkg:\$\{name\}`/);
    // One realm per package, mounted at the restricted tier.
    expect(CUSTOM_FUNCTIONS).toContain("export function planCustomFunctionRealms(");
    const mount = CUSTOM_FUNCTIONS.slice(CUSTOM_FUNCTIONS.indexOf("await hostMountScript({"));
    expect(mount.slice(0, mount.indexOf("});"))).toContain('accessLevel: "restricted"');
  });

  it("the sibling table is built per realm, so fns.OTHER() cannot reach another origin", () => {
    // `fns` is declared inside the generated `setup` of ONE realm's source.
    expect(CUSTOM_FUNCTIONS).toContain("`  const fns = {};\\n`");
    // ...and a realm's source is generated over that realm's functions only.
    expect(CUSTOM_FUNCTIONS).toContain("source: generateLibrarySource(functions, uses)");
  });

  it("the subscriber's own functions are exposed non-public, and cross-origin calls to non-public methods are refused", () => {
    expect(CUSTOM_FUNCTIONS).toContain("{ public: false }");
    expect(BROKER).toContain("if (!sameTrust && !target.isPublic)");
  });

  it("the capability LIST is shared: every realm is mounted with lib.capabilities", () => {
    const install = CUSTOM_FUNCTIONS.slice(CUSTOM_FUNCTIONS.indexOf("async function rawInstall("));
    const body = install.slice(0, install.indexOf("\n}\n"));
    expect(body).toContain("const capabilities = lib.capabilities ?? [];");
    expect(body).toContain("await mountRealm(realm, capabilities, opts);");
  });

  it("the consent source carries the capability list, so a change to it re-prompts", () => {
    const start = CUSTOM_FUNCTIONS_RAW.indexOf("export function customFunctionConsentSource(");
    expect(start, "customFunctionConsentSource not found").toBeGreaterThan(-1);
    const former = CUSTOM_FUNCTIONS_RAW.slice(start);
    expect(former.slice(0, former.indexOf("\n}\n"))).toContain("`// @capability ${c}`");
  });

  it("the broker admits a capability-free restricted row on tier alone — it never reads the object type", () => {
    const decide = BROKER_POLICY.slice(BROKER_POLICY.indexOf("export function decidePolicy("));
    expect(decide).toContain('if (policy.tier === "unlocked" && identity.tier !== "unlocked")');
    expect(decide).not.toContain("objectType");
    // ...so the sheet.* family really is in this realm's reach.
    const rows = capabilityFreeRestrictedRows();
    expect(rows).toContain("sheet.getCellValue");
    expect(rows).toContain("sheet.setCellValue");
    expect(rows).toContain("base.notify");
    expect(rows).toContain("base.log");
    expect(rows).toContain("events.subscribe");
  });

  it("every capability-free restricted row this realm can reach has a clause in the prompt's vocabulary", () => {
    for (const row of capabilityFreeRestrictedRows()) {
      expect(
        clauseForRow(row),
        `allowlist.ts row "${row}" is restricted-tier, capability-free and implemented by host.ts, ` +
          "and no sentence in the distributed-functions consent prompt has been written for it — " +
          "the screen would understate what a publisher's function may do",
      ).toBeDefined();
    }
  });

  it("every workbook hook and property has a clause, and the three replying hooks a veto word", () => {
    const hooks = workbookHooks();
    expect(hooks.length, "workbook typed context parsed as hookless").toBeGreaterThanOrEqual(8);
    for (const hook of hooks) {
      expect(HOOK_CLAUSE.get(hook), `workbook hook "${hook}" has no clause in the prompt`).toBeDefined();
    }
    const replying = workbookReplyingHooks();
    expect(replying, "the three cancellable lifecycle hooks").toEqual(["onBeforeClose", "onBeforePrint", "onBeforeSave"]);
    for (const hook of replying) {
      expect(VETO_WORD.get(hook), `replying hook "${hook}" is not named in the veto sentence`).toBeDefined();
      expect(VETO_SENTENCE).toContain(VETO_WORD.get(hook)!);
    }
    const props = workbookProperties();
    expect(props, "the workbook properties the mirror seeds").toEqual(["author", "getSheetNames", "sheetCount", "title"]);
    for (const prop of props) {
      expect(PROPERTY_CLAUSE.get(prop), `workbook property "${prop}" has no clause in the prompt`).toBeDefined();
    }
  });
});

describe("the prompt states the realm's capability-free reach on BOTH branches", () => {
  it.each([
    ["no capabilities", NO_CAPS],
    ["with capabilities", WITH_CAPS],
  ])("%s: every derived reach row is stated", (_label, data) => {
    const text = render(data);
    for (const row of capabilityFreeRestrictedRows()) {
      expect(text, `the reach of "${row}" is not stated on the prompt`).toContain(clauseForRow(row)!);
    }
  });

  it.each([
    ["no capabilities", NO_CAPS],
    ["with capabilities", WITH_CAPS],
  ])("%s: every workbook hook, the veto, and every property is stated", (_label, data) => {
    const text = render(data);
    for (const hook of workbookHooks()) {
      expect(text, `hook "${hook}" is not stated`).toContain(HOOK_CLAUSE.get(hook)!);
    }
    expect(text).toContain(VETO_SENTENCE);
    expect(text).toContain("read this workbook's title, author, sheet names and sheet count");
    for (const prop of workbookProperties()) {
      expect(text, `property "${prop}" is not stated`).toContain(PROPERTY_CLAUSE.get(prop)!);
    }
    // A handler outlives the call that registered it.
    expect(text).toContain("keep running on their own, whether or not a cell still uses the function that registered them");
  });

  it("says the realm is its own and does not carry the subscriber's grants", () => {
    const text = render(NO_CAPS);
    expect(text).toContain("restricted sandbox of their own");
    expect(text).toContain("cannot call your own custom functions");
    expect(text).toContain("nothing you have granted your own functions carries over");
  });
});

describe("the capability branches say what the list is and what its absence means", () => {
  it("with capabilities: the list is the library's ONE list, mounted into every realm", () => {
    const text = render(WITH_CAPS);
    expect(text).toContain("declares one capability list for every function in it");
    expect(text).toContain("each application's sandbox is mounted with the whole list");
    expect(text).toContain("also grants this publisher's code all of the following");
    expect(text).toContain("fetch data from the web");
    expect(text).toContain("run read-only BI queries (model-scoped)");
  });

  it("without capabilities: nothing beyond the restricted reach, and says so without shrinking it", () => {
    const text = render(NO_CAPS);
    expect(text).toContain("declares no capabilities");
    expect(text).toContain("beyond that reach this code gets nothing: no network, no files, no dialogs, no BI data");
    expect(text).not.toContain("fetch data from the web");
  });

  it("the re-prompt sentence names the capability LIST, which is what the consent source hashes", () => {
    const text = render(NO_CAPS);
    expect(text).toContain("asked again if the publisher changes this code");
    expect(text).toContain("or if the capability list of this workbook's Custom Functions library changes");
  });
});

describe("the stale sentences are gone", () => {
  it.each([
    ["no capabilities", NO_CAPS],
    ["with capabilities", WITH_CAPS],
  ])("%s: no shared-sandbox claim, no compute-only claim", (_label, data) => {
    const text = render(data);
    expect(text, "the realm is per application since planCustomFunctionRealms").not.toContain("one Custom Functions sandbox");
    expect(text).not.toContain("share this workbook");
    expect(text).not.toContain("everything that sandbox already holds");
    expect(text, "notify/log/hooks/cells are reachable with no capability").not.toContain("only compute from the arguments");
    expect(text).not.toContain("widen what the Custom Functions sandbox");
  });

  it("the SECURITY header describes the per-origin realm, not a shared one", () => {
    const header = DIALOG_SOURCE.slice(0, DIALOG_SOURCE.indexOf("import React"));
    expect(header).not.toMatch(/SHARED realm/);
    expect(header).not.toContain("one shared Custom Functions record");
    expect(header).toContain("planCustomFunctionRealms");
    expect(header).toContain("The RECORD is shared; the REALM is not.");
    expect(header).toContain("distributedFunctionsConsentHonesty.test.tsx");
  });

  it("reads the real files, so no comparison above can pass vacuously", () => {
    expect(HOST).toContain('case "sheet.getCellValue":');
    expect(SHIMS).toContain('case "workbook":');
    expect(CUSTOM_FUNCTIONS).toContain("customFunctionScriptId");
    expect(DIALOG_SOURCE).toContain("DistributedFunctionsConsentDialog");
  });
});
