//! FILENAME: app/extensions/MacroRecorder/__tests__/seamWiring.test.ts
// PURPOSE: The seam has an owner. Controls REGISTERS the button provider, and
//          it builds the button with the property names it actually renders.
// CONTEXT: A seam nothing registers into is a slower way to fail. The recorder's
//          own tests can only prove it CALLS the seam correctly (they stub the
//          provider), so this reads the owning extension's source directly — the
//          same drift-guard shape the applicationParity tests use — because an
//          extension may not import another extension's module to check.
//
//          The `text` assertion is the original bug, frozen: the recorder wrote
//          `label`, Controls renders `text`, and the backend happily stored a
//          caption nothing would ever draw.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const controlsIndex = fs.readFileSync(
  path.resolve(__dirname, "../../Controls/index.ts"),
  "utf8",
);
const macroRecorderIndex = fs.readFileSync(
  path.resolve(__dirname, "../index.ts"),
  "utf8",
);

describe("Controls owns the button-control seam", () => {
  it("registers a ButtonControlProvider at activation", () => {
    expect(controlsIndex).toMatch(
      /import \{[\s\S]*registerButtonControlProvider[\s\S]*\} from "@api\/buttonControlService"/,
    );
    expect(controlsIndex).toMatch(/registerButtonControlProvider\(\{/);
    expect(controlsIndex).toMatch(/createButton:\s*createButtonControlAt/);
    expect(controlsIndex).toMatch(/removeButton:\s*removeButtonControlAt/);
  });

  it("pushes the unregister onto the cleanup list", () => {
    expect(controlsIndex).toMatch(
      /cleanupFns\.push\(\s*registerButtonControlProvider\(/,
    );
  });

  it("has ONE button factory, used by both the ribbon and the seam", () => {
    const factories = controlsIndex.match(/async function createButtonControlAt\b/g) ?? [];
    expect(factories).toHaveLength(1);
    // insertButton must delegate rather than keep its own copy of the recipe.
    const insertButton = controlsIndex.slice(
      controlsIndex.indexOf("async function insertButton"),
    );
    expect(insertButton.slice(0, 900)).toContain("createButtonControlAt({");
  });

  it("writes the caption as `text` (the property Controls renders)", () => {
    const factory = controlsIndex.slice(
      controlsIndex.indexOf("async function createButtonControlAt"),
      controlsIndex.indexOf("async function removeButtonControlAt"),
    );
    expect(factory).toMatch(/text:\s*\{\s*valueType:\s*"static",\s*value:\s*request\.label\s*\}/);
    expect(factory).not.toMatch(/\blabel:\s*\{\s*valueType/);
  });

  it("registers the control in the floating store and re-syncs the overlay", () => {
    const factory = controlsIndex.slice(
      controlsIndex.indexOf("async function createButtonControlAt"),
      controlsIndex.indexOf("async function removeButtonControlAt"),
    );
    // Without these two the control exists only in the backend and nothing draws it.
    expect(factory).toContain("addFloatingControl({");
    expect(factory).toContain("syncFloatingControlRegions()");
  });

  it("writes pinToGrid explicitly (the backend defaults an absent value to 'moves')", () => {
    const factory = controlsIndex.slice(
      controlsIndex.indexOf("async function createButtonControlAt"),
      controlsIndex.indexOf("async function removeButtonControlAt"),
    );
    expect(factory).toMatch(/pinToGrid:\s*\{\s*valueType:\s*"static",\s*value:\s*"false"\s*\}/);
  });

  it("writes the macroRef link property when the request carries one", () => {
    const factory = controlsIndex.slice(
      controlsIndex.indexOf("async function createButtonControlAt"),
      controlsIndex.indexOf("async function removeButtonControlAt"),
    );
    // The button LINKS a macro by id; the property key comes from the shared
    // constant so writer and reader cannot disagree.
    expect(factory).toContain("request.macroRef");
    expect(factory).toContain("MACRO_REF_PROPERTY");
  });
});

describe("Controls runs a macro-linked button through the macro-run seam", () => {
  it("checks macroRef FIRST on a click, before the inline/object-script paths", () => {
    const click = controlsIndex.slice(
      controlsIndex.indexOf("async function runFloatingButtonClick"),
    );
    const body = click.slice(0, click.indexOf("\n}\n"));
    // The macroRef branch must appear before executeFloatingButtonAction, so an
    // old copy-model button (no macroRef) still falls through to the old path.
    const macroRefAt = body.indexOf("readMacroRef");
    const inlineAt = body.indexOf("executeFloatingButtonAction");
    expect(macroRefAt).toBeGreaterThanOrEqual(0);
    expect(inlineAt).toBeGreaterThanOrEqual(0);
    expect(macroRefAt).toBeLessThan(inlineAt);
  });

  it("runs the link through @api/macroRunService, not by reaching into MacroRecorder", () => {
    expect(controlsIndex).toContain('from "@api/macroRunService"');
    expect(controlsIndex).toContain("requireMacroRunProvider().runMacroByRef");
    // Facade Rule: Controls must not import MacroRecorder internals.
    expect(controlsIndex).not.toMatch(/from ["'].*MacroRecorder/);
  });
});

describe("MacroRecorder owns the macro-run seam", () => {
  it("registers a MacroRunProvider at activation and cleans it up", () => {
    expect(macroRecorderIndex).toContain(
      'import { registerMacroRunProvider } from "@api/macroRunService"',
    );
    expect(macroRecorderIndex).toMatch(
      /cleanupFns\.push\(registerMacroRunProvider\(\{\s*runMacroByRef\s*\}\)\)/,
    );
  });
});
