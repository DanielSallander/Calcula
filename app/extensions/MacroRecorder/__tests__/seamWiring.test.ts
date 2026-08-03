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

describe("Controls owns the button-control seam", () => {
  it("registers a ButtonControlProvider at activation", () => {
    expect(controlsIndex).toContain(
      'import { registerButtonControlProvider } from "@api/buttonControlService"',
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
});
