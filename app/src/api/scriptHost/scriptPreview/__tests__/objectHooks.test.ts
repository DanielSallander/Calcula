//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/objectHooks.test.ts
// PURPOSE: The object-type -> hooks derivation resolves for every type a draft
//          can target, so no object silently loses its handlers from the preview.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          `contextInterfaceFor` relies on the generator's `<Type>Context`
//          naming CONVENTION rather than on a declared mapping. That is the
//          right trade — a hand-written map is a second source of truth that
//          drifts the first time a hook is added — but a convention needs a
//          guard, or a rename turns into an object type whose handlers are never
//          fired and whose preview quietly only ever runs `setup`.

import { describe, expect, it } from "vitest";
import { SCRIPTABLE_OBJECT_TYPES } from "../../../scriptableObjects";
import { SCRIPT_SURFACE } from "../../generated/scriptSurfacePolicy";
import { contextInterfaceFor, objectHooksFor } from "../objectHooks";

/**
 * Object types that genuinely have no context interface of their own.
 *
 * Listed rather than tolerated, so the guard below stays sharp: a NEW type
 * appearing here is a decision someone made, not a rename nobody noticed.
 * Each of these is a target a script can be attached to whose reach is the
 * generic surface — there is no `RowContext` with row-specific hooks.
 */
const NO_OWN_CONTEXT = new Set(["row", "textbox"]);

const interfaces = new Set(SCRIPT_SURFACE.map((m) => m.iface));

describe("every drafted object type resolves to a real context", () => {
  it("has a non-empty list of types to check", () => {
    expect(SCRIPTABLE_OBJECT_TYPES.length).toBeGreaterThan(5);
    expect(interfaces.size).toBeGreaterThan(5);
  });

  it.each(SCRIPTABLE_OBJECT_TYPES.map((t) => [t]))("%s", (objectType) => {
    const iface = contextInterfaceFor(objectType);
    if (NO_OWN_CONTEXT.has(objectType)) {
      expect(
        interfaces.has(iface),
        `${objectType} is listed as having no context of its own, but ${iface} now exists — ` +
          `remove it from NO_OWN_CONTEXT so its hooks get fired`,
      ).toBe(false);
      return;
    }
    expect(
      interfaces.has(iface),
      `${objectType} does not resolve to a context interface (${iface}). Either the ` +
        `generator's naming changed, or this type has no context of its own and belongs ` +
        `in NO_OWN_CONTEXT — but decide, because until then its handlers are never fired.`,
    ).toBe(true);
  });

  it("finds a button's click handler, which the whole corpus is built around", () => {
    expect(objectHooksFor("button")).toEqual(["onClick"]);
  });

  it("finds ALL of a multi-hook object's hooks, not just the first", () => {
    // A sheet script's work can hang off any of them; offering one would make
    // the other two invisible to the preview.
    const sheet = objectHooksFor("sheet");
    expect(sheet).toContain("onSelectionChange");
    expect(sheet.length).toBeGreaterThan(1);
  });

  it("returns nothing — rather than throwing — for a type with no hooks", () => {
    // A preview then simply runs `setup` and reports that, which is a fact
    // about the object rather than a failure.
    expect(objectHooksFor("row")).toEqual([]);
    expect(objectHooksFor("not-a-real-object")).toEqual([]);
  });

  it("only ever reports registration hooks, never ordinary members", () => {
    for (const objectType of SCRIPTABLE_OBJECT_TYPES) {
      for (const hook of objectHooksFor(objectType)) {
        expect(hook, `${objectType}.${hook} is not a hook name`).toMatch(/^on[A-Z]/);
      }
    }
  });
});
