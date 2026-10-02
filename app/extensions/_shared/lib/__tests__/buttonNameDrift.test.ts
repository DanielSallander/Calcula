//! FILENAME: app/extensions/_shared/lib/__tests__/buttonNameDrift.test.ts
// PURPOSE: The button rule lives in Rust (M6, phase 4 of BUG-0257:
//          app/src-tauri/src/scripting/control_action.rs). The TypeScript
//          copies of its identifier helpers that remain on the page -- the
//          Properties pane's sanitizeScriptName (it WRITES the `Name()` a
//          button calls), the shared sanitizeScriptName, and @api's
//          parseModuleScriptRuntime -- must answer every row of the fixture
//          the Rust tests read too, so the two sides cannot drift apart
//          unnoticed. (The approval screen's call-name reader, buttonCallName,
//          answers the same fixture in consentButtonActions.test.ts; the page's
//          old call-name copy was deleted with the page planners.)
// CONTEXT: Lives beside the shared helpers rather than in src/api/__tests__:
//          @api may not import an extension (the API-neutrality lint covers its
//          tests too), and this test must RUN the TypeScript functions, not
//          re-read them as text.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { sanitizeScriptName as propertiesPaneSanitize } from "../../../Controls/PropertiesPane/CodePropertyInput";
import { sanitizeScriptName as sharedSanitize } from "../buttonScriptRun";
import { parseModuleScriptRuntime } from "@api/workbookScripts";

interface Fixture {
  sanitize: { name: string; expected: string }[];
  callName: { code: string; expected: string | null }[];
  runtime: { description: string | null; expected: string | null }[];
}

const FIXTURE_PATH = path.resolve(__dirname, "../../../../src-tauri/src/scripting/fixtures/button_names.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

describe("the button-name fixture Rust decides by", () => {
  it("is the file the Rust tests include", () => {
    const rustTests = fs.readFileSync(
      path.resolve(__dirname, "../../../../src-tauri/src/scripting/control_action_tests.rs"),
      "utf8",
    );
    expect(rustTests).toContain('include_str!("fixtures/button_names.json")');
    expect(fixture.sanitize.length).toBeGreaterThanOrEqual(6);
    expect(fixture.callName.length).toBeGreaterThanOrEqual(6);
    expect(fixture.runtime.length).toBeGreaterThanOrEqual(6);
  });

  it("sanitizes every name as both TypeScript copies do (per UTF-16 unit: an emoji is two underscores)", () => {
    for (const row of fixture.sanitize) {
      expect(propertiesPaneSanitize(row.name), `Properties pane: ${JSON.stringify(row.name)}`).toBe(row.expected);
      expect(sharedSanitize(row.name), `shared helper: ${JSON.stringify(row.name)}`).toBe(row.expected);
    }
  });

  it("parses the runtime marker as Rust does", () => {
    for (const row of fixture.runtime) {
      expect(parseModuleScriptRuntime(row.description), JSON.stringify(row.description)).toBe(row.expected);
    }
  });

  it("carries no 'TypeScript differs' exception any more: every remaining copy answers every row", () => {
    expect(fs.readFileSync(FIXTURE_PATH, "utf8")).not.toContain("tsDiffers");
  });
});
