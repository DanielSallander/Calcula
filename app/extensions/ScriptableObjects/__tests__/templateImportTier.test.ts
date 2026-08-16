//! FILENAME: app/extensions/ScriptableObjects/__tests__/templateImportTier.test.ts
// PURPOSE: A `.calcula-template` file may carry SOURCE. It may never carry the
//          PRIVILEGE LEVEL that source runs at.
// CONTEXT: `importTemplate` was `JSON.parse(json) as ObjectTemplate` — a cast,
//          which validates nothing — and the parsed object was written to
//          %APPDATA%/Calcula/templates/ verbatim, `accessLevel` included.
//
//          That field is not decoration. `stampFromTemplate` copies it onto the
//          stamped `ObjectScriptDefinition`, and `buildHandleFromDefinition`
//          (app/src/api/scriptHost/broker.ts) turns `accessLevel === "unlocked"`
//          into `tier: "unlocked"`, which is whole-workbook reach:
//          `api.getCellValue`, `api.setCellValue`, `api.updateCellsBatch` over
//          100,000 cells, `api.executeCommand`. Object scripts run on their
//          object's events, so no further click was required. A file chose its
//          own privilege level and nothing in the import flow said so.
//
//          The rule already existed one file away: `draftToScriptDefinition` in
//          lib/scriptDrafts.ts forces "restricted" because "an AI-authored
//          script must never arrive pre-escalated to the unlocked tier; raising
//          it is a separate, deliberate human action in the editor." This door
//          simply never got it. BUG-0092.
//
//          The broker half is asserted against the BROKER SOURCE, not a
//          reconstruction, so if `buildHandleFromDefinition` ever stops deriving
//          the tier from `accessLevel` this test says so instead of quietly
//          guarding nothing.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import {
  importTemplate,
  exportTemplate,
  stampFromTemplate,
  createTemplateFromScript,
  TemplateImportError,
  type ObjectTemplate,
} from "../lib/templateManager";
import { draftToScriptDefinition } from "../lib/scriptDrafts";

/** A hostile template: valid in every field, escalated in exactly one. */
function hostileTemplateJson(accessLevel: string): string {
  return JSON.stringify({
    id: "attacker-chosen-id",
    name: "Quarterly Report Helper",
    objectType: "button",
    scriptSource:
      "export function setup(context) { context.api.updateCellsBatch([]); }",
    accessLevel,
    description: "Looks helpful.",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("an imported template may not choose its own privilege tier", () => {
  it("forces `restricted` even when the file says `unlocked`", () => {
    const t = importTemplate(hostileTemplateJson("unlocked"));
    expect(t.accessLevel).toBe("restricted");
  });

  it("forces `restricted` for any junk value in the field", () => {
    for (const value of ["UNLOCKED", "admin", "", "unlocked "]) {
      expect(importTemplate(hostileTemplateJson(value)).accessLevel).toBe(
        "restricted",
      );
    }
  });

  it("still forces `restricted` when the field is absent entirely", () => {
    const json = JSON.stringify({
      name: "No tier stated",
      objectType: "cell",
      scriptSource: "export function setup() {}",
    });
    expect(importTemplate(json).accessLevel).toBe("restricted");
  });

  it("does not let the file choose the id a grant would be keyed to", () => {
    const t = importTemplate(hostileTemplateJson("unlocked"));
    expect(t.id).not.toBe("attacker-chosen-id");
    expect(t.id.length).toBeGreaterThan(0);
  });

  it("THE CONSEQUENCE: the stamped script cannot reach the unlocked tier", () => {
    // The end-to-end shape of the defect: import -> stamp -> the definition the
    // broker builds a handle from.
    const stamped = stampFromTemplate(
      importTemplate(hostileTemplateJson("unlocked")),
      "instance-1",
    );
    expect(stamped.accessLevel).toBe("restricted");
  });

  it("agrees with the rule scriptDrafts.ts already applies to AI drafts", () => {
    const draft = draftToScriptDefinition({
      id: "draft-1",
      name: "AI draft",
      objectType: "cell",
      instanceId: null,
      source: "export function setup() {}",
      mounted: false,
    } as Parameters<typeof draftToScriptDefinition>[0]);
    const imported = importTemplate(hostileTemplateJson("unlocked"));
    expect(imported.accessLevel).toBe(draft.accessLevel);
  });
});

describe("the tier field is load-bearing — this is why the above matters", () => {
  it("the broker still derives `tier` from `accessLevel`", () => {
    const broker = fs.readFileSync(
      path.resolve(__dirname, "../../../src/api/scriptHost/broker.ts"),
      "utf-8",
    );
    // If this line ever moves, the guard above needs re-aiming, not deleting.
    expect(broker).toContain(
      'tier: definition.accessLevel === "unlocked" ? "unlocked" : "restricted"',
    );
  });

  it("`unlocked` really does unlock whole-workbook writes", () => {
    const allowlist = fs.readFileSync(
      path.resolve(__dirname, "../../../src/api/scriptHost/allowlist.ts"),
      "utf-8",
    );
    for (const method of [
      "api.setCellValue",
      "api.getCellValue",
      "api.updateCellsBatch",
    ]) {
      const row = allowlist
        .split("\n")
        .find((l) => l.includes(`"${method}":`));
      expect(row, `${method} row missing from ALLOWLIST`).toBeTruthy();
      expect(row, `${method} is expected to be unlocked-tier`).toContain(
        'tier: "unlocked"',
      );
    }
  });
});

describe("a template file that is not a template is refused, not absorbed", () => {
  it("refuses non-JSON", () => {
    expect(() => importTemplate("not json at all")).toThrow(TemplateImportError);
  });

  it("refuses JSON that is not an object", () => {
    for (const json of ["null", "42", '"a string"', "[1,2,3]"]) {
      expect(() => importTemplate(json), json).toThrow(TemplateImportError);
    }
  });

  it("refuses a missing or empty name", () => {
    expect(() =>
      importTemplate(
        JSON.stringify({ objectType: "cell", scriptSource: "" }),
      ),
    ).toThrow(/`name` is missing/);
    expect(() =>
      importTemplate(
        JSON.stringify({ name: "   ", objectType: "cell", scriptSource: "" }),
      ),
    ).toThrow(/`name` is missing/);
  });

  it("refuses an objectType nothing can stamp", () => {
    expect(() =>
      importTemplate(
        JSON.stringify({
          name: "x",
          objectType: "constructor",
          scriptSource: "",
        }),
      ),
    ).toThrow(/objectType/);
    expect(() =>
      importTemplate(
        JSON.stringify({ name: "x", objectType: 7, scriptSource: "" }),
      ),
    ).toThrow(/objectType/);
  });

  it("refuses a missing or non-string scriptSource", () => {
    expect(() =>
      importTemplate(JSON.stringify({ name: "x", objectType: "cell" })),
    ).toThrow(/scriptSource/);
    expect(() =>
      importTemplate(
        JSON.stringify({ name: "x", objectType: "cell", scriptSource: 1 }),
      ),
    ).toThrow(/scriptSource/);
  });

  it("refuses wrong-typed optional fields rather than storing them", () => {
    expect(() =>
      importTemplate(
        JSON.stringify({
          name: "x",
          objectType: "cell",
          scriptSource: "",
          description: 5,
        }),
      ),
    ).toThrow(/description/);
    expect(() =>
      importTemplate(
        JSON.stringify({
          name: "x",
          objectType: "cell",
          scriptSource: "",
          metadata: [1, 2],
        }),
      ),
    ).toThrow(/metadata/);
  });
});

describe("the legitimate flows still work", () => {
  it("a normal restricted template round-trips through export/import", () => {
    const original: ObjectTemplate = createTemplateFromScript(
      {
        id: "s1",
        name: "My Script",
        objectType: "button",
        instanceId: "i1",
        source: "export function setup() {}",
        accessLevel: "restricted",
        description: "does a thing",
      },
      "My Template",
      { color: "red" },
    );
    const back = importTemplate(exportTemplate(original));
    expect(back.name).toBe("My Template");
    expect(back.objectType).toBe("button");
    expect(back.scriptSource).toBe("export function setup() {}");
    expect(back.description).toBe("does a thing");
    expect(back.metadata).toEqual({ color: "red" });
    expect(back.accessLevel).toBe("restricted");
  });

  it("a LOCAL template made from the user's own unlocked script keeps its tier", () => {
    // The boundary is the import door, not template creation: a script the user
    // wrote and escalated themselves, in trusted UI, never crossed a boundary.
    const local = createTemplateFromScript(
      {
        id: "s2",
        name: "Mine",
        objectType: "workbook",
        instanceId: null,
        source: "export function setup() {}",
        accessLevel: "unlocked",
      },
      "Mine",
    );
    expect(local.accessLevel).toBe("unlocked");
    expect(stampFromTemplate(local, "i2").accessLevel).toBe("unlocked");
  });

  it("createdAt is preserved when sane and synthesized when not", () => {
    const kept = importTemplate(hostileTemplateJson("restricted"));
    expect(kept.createdAt).toBe("2026-01-01T00:00:00.000Z");
    const synthesized = importTemplate(
      JSON.stringify({
        name: "x",
        objectType: "cell",
        scriptSource: "",
        createdAt: 12345,
      }),
    );
    expect(typeof synthesized.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(synthesized.createdAt))).toBe(false);
  });
});
