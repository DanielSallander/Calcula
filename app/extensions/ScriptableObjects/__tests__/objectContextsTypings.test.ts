// PURPOSE: THE LOCKSTEP GUARD. Regenerates objectContexts.d.ts from the live
//          worker context shim + the broker allowlist and fails when the
//          committed file differs, or when the shim exposes a member the
//          typings do not declare (or the reverse).
// CONTEXT: objectContexts.d.ts is the ONLY extraLib Monaco loads for object
//          scripts, so it IS Calcula's object browser. Before this test it was
//          hand-maintained and had silently drifted: biQuery, biSql,
//          listBiConnections, cube.*, connector.*, the whole range and chartMark
//          contexts, shape.declareProperties and two invalidate() methods were
//          callable at runtime and invisible to IntelliSense — while
//          shape.render.declareProperties was advertised and did not exist.
//
//          A generator alone would not have prevented that; nothing forces
//          anyone to run it. This test does, on every `npm test`. If it fails
//          because you added a method to contextShims.ts, that is the guard
//          working: declare it in
//          app/scripts/scriptTypings/objectContexts.template.d.ts and run
//          `npm run gen:script-typings`.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { generateObjectContexts } from "../../../scripts/scriptTypings/generateObjectContexts";
import { probeSurface, OBJECT_TYPE_INTERFACES } from "../../../scripts/scriptTypings/probeShim";
import { ALLOWLIST } from "@api/scriptHost/allowlist";

const TEMPLATE_PATH = path.resolve(__dirname, "../../../scripts/scriptTypings/objectContexts.template.d.ts");
const GENERATED_PATH = path.resolve(__dirname, "../objectContexts.d.ts");

function readTemplate(): string {
  return fs.readFileSync(TEMPLATE_PATH, "utf8");
}

describe("objectContexts.d.ts is generated, not maintained", () => {
  it("declares every member the worker shim actually exposes, and nothing it does not", () => {
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    expect(
      result.problems,
      "the object-script typings and the worker context shim disagree:\n  - " +
        result.problems.join("\n  - ") +
        "\n\nFix app/scripts/scriptTypings/objectContexts.template.d.ts, then run `npm run gen:script-typings`.",
    ).toEqual([]);
  });

  it("matches the committed objectContexts.d.ts byte for byte", () => {
    const result = generateObjectContexts(readTemplate(), path.basename(TEMPLATE_PATH));
    expect(result.problems).toEqual([]);
    const committed = fs.readFileSync(GENERATED_PATH, "utf8");
    expect(
      committed === result.output,
      "extensions/ScriptableObjects/objectContexts.d.ts is stale — run `npm run gen:script-typings`.",
    ).toBe(true);
  });

  it("covers every objectType buildTyped can mount", () => {
    // The probe drives the objectType list; this pins that the list is the one
    // the shim's switch actually has, so a NEW objectType cannot ship with no
    // context interface at all.
    const shimSource = fs.readFileSync(
      path.resolve(__dirname, "../../../src/api/scriptHost/worker/contextShims.ts"),
      "utf8",
    );
    const cases = [...shimSource.matchAll(/^\s{4}case "([a-zA-Z]+)":/gm)].map((m) => m[1]);
    expect(cases.length).toBeGreaterThan(10);
    const covered = new Set(OBJECT_TYPE_INTERFACES.map(([t]) => t));
    const missing = cases.filter((c) => !covered.has(c));
    expect(
      missing,
      `contextShims.ts buildTyped handles objectType(s) the typings generator does not probe: ${missing.join(", ")}. ` +
        "Add them to OBJECT_TYPE_INTERFACES in app/scripts/scriptTypings/probeShim.ts.",
    ).toEqual([]);
  });
});

describe("generated broker policy", () => {
  const probe = probeSurface();

  it("resolves every probed broker method against the allowlist", () => {
    // A shim method that dispatches to a broker name the allowlist does not
    // know is a call that can only ever be denied — and it would silently emit
    // no policy JSDoc, so IntelliSense would describe it as if it were free.
    const unknown = new Set<string>();
    for (const iface of probe.interfaces.values()) {
      for (const member of iface.members.values()) {
        if (member.broker && !ALLOWLIST[member.broker]) unknown.add(member.broker);
      }
    }
    expect([...unknown], "shim methods dispatch to broker methods with no allowlist policy").toEqual([]);
  });

  it("publishes the allowlist `desc` verbatim so the tooltip and the consent prompt agree", () => {
    const generated = fs.readFileSync(GENERATED_PATH, "utf8");
    // Every capability-gated method reachable from a script context must have
    // its consent sentence visible in the editor, not only in the prompt.
    const reachable = new Set<string>();
    for (const iface of probe.interfaces.values()) {
      for (const member of iface.members.values()) {
        if (member.broker) reachable.add(member.broker);
      }
    }
    const gated = [...reachable].filter((m) => ALLOWLIST[m]?.capability);
    expect(gated.length).toBeGreaterThan(20);
    const undocumented = gated.filter((m) => !generated.includes(ALLOWLIST[m].desc));
    expect(
      undocumented,
      "capability-gated methods whose consent text is missing from the typings: " + undocumented.join(", "),
    ).toEqual([]);
  });

  it("names the capability every gated method needs", () => {
    const generated = fs.readFileSync(GENERATED_PATH, "utf8");
    for (const capability of new Set(
      Object.values(ALLOWLIST)
        .map((p) => p.capability)
        .filter((c): c is NonNullable<typeof c> => !!c),
    )) {
      expect(generated, `capability ${capability} is never named in the typings`).toContain(capability);
    }
  });
});

describe("the surface the drift actually hid", () => {
  // Regression pins for the specific members that existed on the shim and were
  // missing from the typings when the generator was introduced. They are cheap,
  // and they document what "the typings drifted" concretely cost an author.
  const generated = fs.readFileSync(GENERATED_PATH, "utf8");

  it.each([
    ["biQuery", "structured BI model queries"],
    ["biSql", "raw SQL against a BI connection"],
    ["listBiConnections", "enumerating BI connections"],
    ["ScriptCubeApi", "the CUBE value/kpi/members surface"],
    ["ScriptConnectorApi", "registering a script data connector"],
    ["RangeContext", "cell-behavior bindings"],
    ["ChartMarkContext", "custom chart marks"],
  ])("declares %s (%s)", (symbol) => {
    expect(generated).toContain(symbol);
  });

  it("puts shape.declareProperties on the context, not under render", () => {
    // The typings used to declare `render.declareProperties`, which does not
    // exist; the real method is on the context itself.
    expect(generated).toMatch(/declareProperties\(props: DeclaredProperty\[\]\): void;/);
    const shapeIface = generated.slice(generated.indexOf("declare interface ShapeContext"));
    const renderBlock = shapeIface.slice(shapeIface.indexOf("render: {"), shapeIface.indexOf("\n}"));
    expect(renderBlock).not.toContain("declareProperties");
  });
});
