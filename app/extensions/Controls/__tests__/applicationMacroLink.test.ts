//! FILENAME: app/extensions/Controls/__tests__/applicationMacroLink.test.ts
// PURPOSE: Phase 3 of BUG-0257, the click. A button control's macro LINK runs
//          through ONE rule for both the floating and the in-cell path
//          (lib/applicationMacroLink.ts):
//            * the author's own live `macroRef` wins, and runs as before;
//            * otherwise the application's HELD link runs through the macro-run
//              seam with `requirePackage` = the stamp's application, so the id
//              can resolve only to that application's macro;
//            * an unreadable stamp refuses, and the refusal is audited;
//            * a `refused` outcome is toasted AND audited; every other outcome
//              is voiced;
//            * every run carries the button (`trigger`) to the Rust run gate.
//          And the census: both click paths ask the Rust button door first
//          (phase 4, lib/controlClick.ts) and reach the helper ONLY on the
//          door's `link` answer, and neither calls `runMacroByRef` itself --
//          the in-cell path used to ignore `macroRef` entirely.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({
  toasts: [] as { message: string; variant?: string }[],
  invokes: [] as { cmd: string; args: unknown }[],
}));

vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string, options?: { variant?: string; type?: string }) => {
    h.toasts.push({ message, variant: options?.variant ?? options?.type });
  },
}));
// The audit call goes through the backend facade; captured, never sent.
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.invokes.push({ cmd, args });
    return undefined;
  },
}));

import {
  registerMacroRunProvider,
  resetMacroRunProvider,
  type MacroRunOptions,
  type MacroRunOutcome,
} from "@api/macroRunService";
import {
  describeLinkedRunFailure,
  resolveButtonMacroLink,
  runButtonMacroLink,
} from "../lib/applicationMacroLink";
import { claimExplicitMacroRun, mintExplicitMacroRun, type ExplicitMacroRun } from "@api/explicitMacroRun";

type Props = Record<string, { valueType: string; value: string }>;
const prop = (value: string) => ({ valueType: "static", value });
const STAMP = JSON.stringify({ workspace: "ws", application: "Sales", version: "1.2.0" });

/** An application's button after a subscribe or a checkout: its link HELD and stamped. */
const heldLink = (): Props => ({
  text: prop("Run report"),
  heldMacroRef: prop("macro-report"),
  heldFrom: prop(STAMP),
});

let runs: { macroId: string; options?: MacroRunOptions }[];
let answer: MacroRunOutcome;
let unregister: () => void;

beforeEach(() => {
  h.toasts.length = 0;
  h.invokes.length = 0;
  runs = [];
  answer = { status: "ran", name: "Report" };
  unregister = registerMacroRunProvider({
    runMacroByRef: async (macroId: string, options?: MacroRunOptions) => {
      runs.push({ macroId, options });
      return answer;
    },
  });
});

afterEach(() => {
  unregister();
  resetMacroRunProvider();
});

function audited(): unknown[] {
  return h.invokes.filter((i) => i.cmd === "audit_button_refusal").map((i) => i.args);
}

describe("which link a click follows", () => {
  it("none, for a button that links nothing", () => {
    expect(resolveButtonMacroLink({ text: prop("Go") })).toBeNull();
    expect(resolveButtonMacroLink(null)).toBeNull();
    // An empty value is no link (how an absent property reads if ever set).
    expect(resolveButtonMacroLink({ macroRef: prop(""), heldMacroRef: prop("") })).toBeNull();
  });

  it("the author's own LIVE link wins over a held one, exactly as Rust reads it", () => {
    expect(resolveButtonMacroLink({ ...heldLink(), macroRef: prop("macro-mine") })).toEqual({
      kind: "own",
      macroId: "macro-mine",
    });
  });

  it("a held link names the application its stamp names", () => {
    expect(resolveButtonMacroLink(heldLink())).toEqual({
      kind: "application",
      macroId: "macro-report",
      application: "Sales",
    });
  });

  it("a held link whose stamp cannot be read vouches for nothing", () => {
    expect(resolveButtonMacroLink({ ...heldLink(), heldFrom: prop("{not json") })).toEqual({
      kind: "unreadableStamp",
      macroId: "macro-report",
    });
    const { heldFrom: _gone, ...unstamped } = heldLink();
    expect(resolveButtonMacroLink(unstamped)).toEqual({ kind: "unreadableStamp", macroId: "macro-report" });
  });
});

describe("runButtonMacroLink", () => {
  // SABOTAGE: call runMacroByRef without `requirePackage` for the held link in
  // runButtonMacroLink (lib/applicationMacroLink.ts).
  it("runs a HELD link only as its application's macro, and names the button", async () => {
    expect(await runButtonMacroLink(2, 4, 1, heldLink())).toBe(true);
    expect(runs).toEqual([
      {
        macroId: "macro-report",
        options: {
          requirePackage: "Sales",
          trigger: { kind: "buttonControl", sheetIndex: 2, row: 4, col: 1 },
        },
      },
    ]);
    expect(h.toasts).toEqual([]);
  });

  it("runs the author's own live link with the trigger and no application requirement", async () => {
    expect(await runButtonMacroLink(0, 1, 1, { macroRef: prop("macro-mine"), ...heldLink() })).toBe(true);
    expect(runs).toEqual([
      { macroId: "macro-mine", options: { trigger: { kind: "buttonControl", sheetIndex: 0, row: 1, col: 1 } } },
    ]);
  });

  it("answers false -- and runs nothing -- for a button that links no macro", async () => {
    expect(await runButtonMacroLink(0, 1, 1, { onSelect: prop("Mine();") })).toBe(false);
    expect(runs).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  // SABOTAGE: delete the `recordButtonRefusal(... "stampUnreadable")` call.
  it("refuses a held link whose stamp cannot be read, runs nothing, and audits it", async () => {
    expect(await runButtonMacroLink(0, 3, 3, { ...heldLink(), heldFrom: prop("garbage") })).toBe(true);
    expect(runs).toEqual([]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toMatch(/cannot be read/);
    expect(audited()).toEqual([
      { kind: "control", sheetIndex: 0, row: 3, col: 3, refused: 'the macro "macro-report"', reason: "stampUnreadable" },
    ]);
  });

  // SABOTAGE: delete the `recordButtonRefusal(` call in the "refused" arm of voiceOutcome.
  it("a REFUSED outcome (the user's own macro under the id) is toasted AND audited", async () => {
    answer = {
      status: "refused",
      macroId: "macro-report",
      name: "My report",
      owner: null,
      message:
        'This button came with the application "Sales", and the macro "My report" it names is ' +
        "one of your own. A button from an application runs only that application's own macros, " +
        "so it did not run.",
    };
    expect(await runButtonMacroLink(1, 2, 2, heldLink())).toBe(true);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toContain("is one of your own");
    // The button's OWN sheet (1), the index the run's claim carries -- never
    // "whatever sheet is active when the refusal lands".
    expect(audited()).toEqual([
      {
        kind: "control",
        sheetIndex: 1,
        row: 2,
        col: 2,
        refused: 'the macro "My report"',
        reason: "macroNotFromApplication",
      },
    ]);
  });

  it("voices a missing macro, and records nothing (not a refusal)", async () => {
    answer = { status: "notFound", macroId: "macro-report" };
    await runButtonMacroLink(0, 1, 1, heldLink());
    expect(h.toasts[0].message).toContain('"macro-report", which no longer');
    expect(audited()).toEqual([]);
  });

  it("says a Rust-gate refusal DID NOT RUN (the gate already audited it), and a throw FAILED", async () => {
    answer = {
      status: "failed",
      name: "Report",
      message: "APPLICATION_CODE_BESIDE_PRIVATE_SHEETS: \"macro-report\" came with the application \"Sales\".",
    };
    await runButtonMacroLink(0, 1, 1, heldLink());
    expect(h.toasts[0].message).toMatch(/^"Report" did not run: APPLICATION_CODE_BESIDE_PRIVATE_SHEETS/);
    expect(audited(), "the Rust gate records its own refusals").toEqual([]);
    expect(describeLinkedRunFailure("Report", "TypeError: x is undefined")).toBe(
      '"Report" failed: TypeError: x is undefined',
    );
  });

  it("with no Macro Recorder loaded, names the remedy instead of running", async () => {
    unregister();
    resetMacroRunProvider();
    expect(await runButtonMacroLink(0, 1, 1, heldLink())).toBe(true);
    expect(h.toasts[0].message).toMatch(/Macro Recorder/);
  });
});

// ---------------------------------------------------------------------------
// A PERSON'S CLICK carries the one-time pass (owner decision B, follow-up F1)
// ---------------------------------------------------------------------------

/** A gesture as the pointer handlers make it, recording each macro it was asked to mint for. */
function personsClick(): { gesture: (macroId: string) => ExplicitMacroRun; minted: string[] } {
  const minted: string[] = [];
  return {
    minted,
    gesture: (macroId: string) => {
      minted.push(macroId);
      return mintExplicitMacroRun("button", macroId);
    },
  };
}

describe("a person's click: the link runs with a pass for exactly its macro", () => {
  // SABOTAGE: drop `...(explicitRun ? { explicitRun } : {}),` from the
  // application branch of runButtonMacroLink -> the held link runs restricted.
  it("a HELD link: a pass minted once, for its macro, claiming as the button door", async () => {
    const click = personsClick();
    expect(await runButtonMacroLink(2, 4, 1, heldLink(), click.gesture)).toBe(true);
    expect(click.minted).toEqual(["macro-report"]);
    expect(runs).toHaveLength(1);
    const { explicitRun, ...rest } = runs[0].options ?? {};
    // Everything else exactly as before: the application, and the button the
    // host requires beside a button pass (Rust verifies it).
    expect(rest).toEqual({
      requirePackage: "Sales",
      trigger: { kind: "buttonControl", sheetIndex: 2, row: 4, col: 1 },
    });
    expect(claimExplicitMacroRun(explicitRun)).toEqual({ door: "button", macroId: "macro-report" });
    expect(claimExplicitMacroRun(explicitRun), "one click, one use").toBeNull();
  });

  // SABOTAGE: drop the spread from the own-link branch -> red.
  it("the author's own LIVE link: the same", async () => {
    const click = personsClick();
    await runButtonMacroLink(0, 1, 1, { macroRef: prop("macro-mine") }, click.gesture);
    expect(click.minted).toEqual(["macro-mine"]);
    const { explicitRun, ...rest } = runs[0].options ?? {};
    expect(rest).toEqual({ trigger: { kind: "buttonControl", sheetIndex: 0, row: 1, col: 1 } });
    expect(claimExplicitMacroRun(explicitRun)).toEqual({ door: "button", macroId: "macro-mine" });
  });

  it("NO gesture, no pass: a caller that is not a person's click runs the macro restricted", async () => {
    await runButtonMacroLink(2, 4, 1, heldLink());
    expect(runs).toHaveLength(1);
    expect(runs[0].options).not.toHaveProperty("explicitRun");
  });

  // A pass for a run that never happens is a pass lying around: the mint comes
  // AFTER every refusal decided on this side.
  it("a click that runs nothing mints nothing", async () => {
    const click = personsClick();
    await runButtonMacroLink(0, 3, 3, { ...heldLink(), heldFrom: prop("garbage") }, click.gesture);
    await runButtonMacroLink(0, 1, 1, { onSelect: prop("Mine();") }, click.gesture);
    unregister();
    resetMacroRunProvider();
    await runButtonMacroLink(0, 1, 1, heldLink(), click.gesture);
    expect(click.minted).toEqual([]);
    expect(runs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE CENSUS: one click rule, on both paths
// ---------------------------------------------------------------------------

const CONTROLS = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(CONTROLS, rel), "utf8");

/** The body of `async function <name>(` up to the next top-level closing brace. */
function body(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n"));
}

describe("both click paths go through the one rule", () => {
  // Phase 4 of BUG-0257: the Rust door decides whether a click is a link
  // (`run_control_action` answers `link`), and the ONE shared click
  // (lib/controlClick.ts) then follows it through the helper. Both paths call
  // that click; neither reads the link itself.
  //
  // SABOTAGE: make executeButtonAction call runButtonMacroLink itself again,
  // ahead of the door -> red.
  it("the in-cell path (Button/interceptors.ts executeButtonAction) clicks through the door", () => {
    const click = body(read("Button/interceptors.ts"), "executeButtonAction");
    expect(click, "the in-cell click no longer asks the door").toContain("clickButtonControl(");
    expect(click, "the in-cell click follows a link without the door").not.toContain("runButtonMacroLink(");
  });

  it("the floating path (index.ts runFloatingButtonClick) clicks through the door", () => {
    const click = body(read("index.ts"), "runFloatingButtonClick");
    expect(click).toContain("clickButtonControl(");
    expect(click).not.toContain("runButtonMacroLink(");
  });

  it("the shared click asks the door FIRST and follows the link only on its `link` answer", () => {
    const shared = read("lib/controlClick.ts");
    const follow = body(shared, "followMacroLink");
    expect(follow).toContain("const metadata = await getControlMetadata(sheetIndex, row, col);");
    expect(follow).toContain("runButtonMacroLink(sheetIndex, row, col, metadata?.properties, gesture)");
    const click = body(shared, "clickButtonControl");
    expect(click).toContain("clickButtonThroughDoor(");
    expect(click).toContain('{ kind: "control", sheetIndex, row, col }');
    expect(click).toContain("link: () => followMacroLink(sheetIndex, row, col, gesture),");
  });

  it("neither path calls runMacroByRef itself -- only the helper does, with requirePackage", () => {
    expect(read("index.ts")).not.toContain("runMacroByRef(");
    expect(read("Button/interceptors.ts")).not.toContain("runMacroByRef(");
    const helper = read("lib/applicationMacroLink.ts");
    expect(helper).toContain('from "@api/macroRunService"');
    expect(helper).toContain("requirePackage: link.application");
  });
});
