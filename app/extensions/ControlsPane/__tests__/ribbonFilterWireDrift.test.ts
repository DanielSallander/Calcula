//! FILENAME: app/extensions/ControlsPane/__tests__/ribbonFilterWireDrift.test.ts
// PURPOSE: Pin the ribbon-filter wire between Rust and TypeScript by NAME.
// CONTEXT: `UpdateRibbonFilterParams` (app/src-tauri/src/ribbon_filter/types.rs)
//          has no `deny_unknown_fields`, so a TypeScript key the Rust struct
//          does not know is SILENTLY ignored: a TS `crossFilterTargets` sent
//          to a Rust `dependent_filters` saves nothing and reports success.
//          The compiler sees neither side of that seam, so this test reads
//          both sources, converts the Rust snake_case field names to
//          camelCase (serde `rename_all = "camelCase"`) and asserts each Rust
//          struct and its TypeScript mirror carry exactly the same keys.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const RUST_TYPES = path.resolve(__dirname, "../../../src-tauri/src/ribbon_filter/types.rs");
const TS_TYPES = path.resolve(__dirname, "../lib/filterPaneTypes.ts");

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** The body between the `{` after `header` and its matching `}`. */
function bodyAfter(source: string, header: RegExp, what: string): string {
  const m = header.exec(source);
  if (!m) throw new Error(`${what} not found`);
  const open = source.indexOf("{", m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${what}: unbalanced braces`);
}

function stripLineComments(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** The serialized (camelCase) field names of a Rust `pub struct`. */
function rustStructKeys(source: string, struct: string): string[] {
  const body = stripLineComments(
    bodyAfter(source, new RegExp(`pub struct ${struct}\\s*\\{`), `Rust struct ${struct}`),
  );
  // Every field-level attribute must be one this conversion understands: a
  // per-field `rename` (forbidden by CLAUDE.md anyway) or `flatten` would make
  // the snake->camel mapping a lie.
  for (const attr of body.match(/#\[serde\(([^)]*)\)\]/g) ?? []) {
    expect(attr, `${struct}: unsupported serde attribute`).not.toMatch(/\b(rename|flatten|alias)\b/);
  }
  const keys: string[] = [];
  for (const m of body.matchAll(/^\s*pub\s+([a-z_][a-z0-9_]*)\s*:/gm)) {
    keys.push(snakeToCamel(m[1]));
  }
  return keys;
}

/** The property names of a TypeScript `export interface`. */
function tsInterfaceKeys(source: string, iface: string): string[] {
  const body = bodyAfter(source, new RegExp(`export interface ${iface}\\s*\\{`), `TS interface ${iface}`);
  const noComments = stripLineComments(body.replace(/\/\*[\s\S]*?\*\//g, ""));
  const keys: string[] = [];
  for (const m of noComments.matchAll(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/gm)) {
    keys.push(m[1]);
  }
  return keys;
}

const PAIRS: Array<{ rust: string; ts: string }> = [
  // The data struct the frontend reads (get/update results, the store).
  { rust: "RibbonFilter", ts: "RibbonFilter" },
  // The silent seam: unknown keys are ignored by serde.
  { rust: "UpdateRibbonFilterParams", ts: "UpdateRibbonFilterParams" },
  { rust: "CreateRibbonFilterParams", ts: "CreateRibbonFilterParams" },
];

describe("ribbon filter wire drift (Rust types.rs <-> filterPaneTypes.ts)", () => {
  const rust = fs.readFileSync(RUST_TYPES, "utf8");
  const ts = fs.readFileSync(TS_TYPES, "utf8");

  for (const { rust: rs, ts: tsName } of PAIRS) {
    it(`${tsName} carries exactly the keys of Rust ${rs}`, () => {
      const rustKeys = rustStructKeys(rust, rs);
      const tsKeys = tsInterfaceKeys(ts, tsName);
      // Neither side may be parsed as empty: that would pass vacuously.
      expect(rustKeys.length).toBeGreaterThan(3);
      expect(tsKeys.length).toBeGreaterThan(3);
      expect([...tsKeys].sort()).toEqual([...rustKeys].sort());
    });
  }

  it("names the dependents by their current wire names on both sides", () => {
    const update = rustStructKeys(rust, "UpdateRibbonFilterParams");
    expect(update).toContain("dependentFilters");
    expect(update).toContain("dependentSlicers");
    expect(tsInterfaceKeys(ts, "UpdateRibbonFilterParams")).toEqual(
      expect.arrayContaining(["dependentFilters", "dependentSlicers"]),
    );
  });

  it("the parsers see a renamed key (self-test on synthetic sources)", () => {
    const rs = `#[serde(rename_all = "camelCase")]
pub struct P {
    /// doc
    pub dependent_filters: Option<Vec<String>>,
    #[serde(default)]
    pub hide_no_data: Option<bool>,
}`;
    const tsSrc = `export interface P {
  /** doc: notAKey: here */
  crossFilterTargets?: string[];
  hideNoData?: boolean; // trailing: comment
}`;
    expect(rustStructKeys(rs, "P")).toEqual(["dependentFilters", "hideNoData"]);
    expect(tsInterfaceKeys(tsSrc, "P")).toEqual(["crossFilterTargets", "hideNoData"]);
  });
});
