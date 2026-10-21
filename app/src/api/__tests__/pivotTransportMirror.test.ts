//! FILENAME: app/src/api/__tests__/pivotTransportMirror.test.ts
// PURPOSE: The pivot transport fields WP-A added (canvas pivot cells and
//          reference picks) exist on BOTH sides of the wire under the names
//          serde gives them, so a field renamed or dropped on one side fails
//          here instead of arriving as `undefined` in a menu.
// CONTEXT: Rust `app/src-tauri/src/pivot/types.rs` declares the structs with
//          `#[serde(rename_all = "camelCase")]`; the TypeScript mirrors live in
//          `app/src/api/pivotTypes.ts`. The fields pinned here:
//            PivotCellData.value_field_index      -> valueFieldIndex
//            PivotViewResponse.value_field_names  -> valueFieldNames
//            GetPivotDataFormulaResult.pivot_anchor_row/col -> pivotAnchorRow/Col
//            PivotRegionData.is_model             -> isModel
//            PivotFieldConfiguration.value_column_order -> valueColumnOrder
//            BiValueFieldRef.number_format        -> numberFormat (WP-C)
//            ZoneFieldInfo.number_format_from_model -> numberFormatFromModel
//            MeasureFieldInfo.format_string       -> BiMeasureFieldInfo.formatString
//          and P2 S7's member wire (identity from the key, display from the label):
//            PivotCellData.member                 -> member (optional)
//            FilterRowData.members                -> members (replaces uniqueValues)
//            FieldUniqueValuesResponse.members    -> members (replaces uniqueValues)
//            SlicerItem.key / label               -> key / label (replaces value),
//              in BOTH TS mirrors (Slicer and ControlsPane)
//            MemberRef.key / label                -> key / label (api_types.rs)
//          Read as TEXT, as `biPivotModelInfoMirrors.test.ts` and
//          `interpreterReachDrift.test.ts` read their sources: the Rust side
//          cannot be imported, and the contract is the field NAME.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");

/** The text between the `{` after `head` and its matching `}`. */
function blockAfter(source: string, head: string): string {
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`\`${head}\` not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated body after \`${head}\``);
}

/** `pub name: Type,` fields of a Rust struct body, comments stripped. */
export function rustFields(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .map((l) => /^pub\s+([a-z_][a-z0-9_]*)\s*:/.exec(l)?.[1])
    .filter((f): f is string => !!f);
}

/** `name?:` / `name:` members of a TypeScript interface body, comments stripped. */
export function tsFields(body: string): string[] {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split("\n")
    .map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(l)?.[1])
    .filter((f): f is string => !!f);
}

/** The attribute lines directly above `pub <field>:` in a Rust struct body. */
function attributesOf(body: string, field: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*pub\\s+${field}\\s*:`).test(l));
  if (at < 0) return [];
  const attrs: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("#[")) attrs.push(t);
    else if (t.startsWith("///") || t === "") continue;
    else break;
  }
  return attrs;
}

const camel = (snake: string) => snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const PINNED: ReadonlyArray<{ rust: string; ts: string; fields: string[]; optional: boolean }> = [
  { rust: "pub struct PivotCellData", ts: "export interface PivotCellData", fields: ["value_field_index"], optional: true },
  { rust: "pub struct PivotViewResponse", ts: "export interface PivotViewResponse", fields: ["value_field_names"], optional: true },
  {
    rust: "pub struct GetPivotDataFormulaResult",
    ts: "export interface GetPivotDataFormulaResult",
    fields: ["pivot_anchor_row", "pivot_anchor_col"],
    optional: false,
  },
  { rust: "pub struct PivotRegionData", ts: "export interface PivotRegionData", fields: ["is_model"], optional: false },
  {
    rust: "pub struct PivotFieldConfiguration",
    ts: "export interface PivotFieldConfiguration",
    fields: ["value_column_order"],
    optional: true,
  },
  // WP-C data format (BUG-0478): a value field's format override, whether a
  // format came from the model, and the model's own measure format.
  { rust: "pub struct BiValueFieldRef", ts: "export interface BiValueFieldRef", fields: ["number_format"], optional: true },
  {
    rust: "pub struct ZoneFieldInfo",
    ts: "export interface ZoneFieldInfo",
    fields: ["number_format_from_model"],
    optional: true,
  },
  { rust: "pub struct MeasureFieldInfo", ts: "export interface BiMeasureFieldInfo", fields: ["format_string"], optional: true },
  // P2 S7: the member shape on pivot headers and filter lists.
  { rust: "pub struct PivotCellData", ts: "export interface PivotCellData", fields: ["member"], optional: true },
  { rust: "pub struct FilterRowData", ts: "export interface FilterRowData", fields: ["members", "selected_values"], optional: false },
  {
    rust: "pub struct FieldUniqueValuesResponse",
    ts: "export interface FieldUniqueValuesResponse",
    fields: ["members"],
    optional: false,
  },
];

describe("the pivot transport fields mirror Rust under serde's camelCase names", () => {
  const rustSrc = read("src-tauri/src/pivot/types.rs");
  const tsSrc = read("src/api/pivotTypes.ts");

  it("the scans see real, non-trivial structs (the parser is not the thing failing)", () => {
    const cell = rustFields(blockAfter(rustSrc, "pub struct PivotCellData"));
    expect(cell).toContain("cell_type");
    expect(cell).toContain("group_path");
    expect(tsFields(blockAfter(tsSrc, "export interface PivotCellData"))).toContain("groupPath");
  });

  for (const pin of PINNED) {
    describe(pin.rust.replace("pub struct ", ""), () => {
      const rustBody = blockAfter(rustSrc, pin.rust);
      const tsBody = blockAfter(tsSrc, pin.ts);

      it("the struct renames ALL fields at the struct level (camelCase)", () => {
        const head = rustSrc.slice(Math.max(0, rustSrc.indexOf(pin.rust) - 200), rustSrc.indexOf(pin.rust));
        expect(head).toMatch(/#\[serde\(rename_all = "camelCase"\)\]\s*$/);
      });

      for (const field of pin.fields) {
        it(`${field} -> ${camel(field)}`, () => {
          expect(rustFields(rustBody), `Rust ${pin.rust} has no \`${field}\``).toContain(field);
          const attrs = attributesOf(rustBody, field);
          expect(
            attrs.filter((a) => /rename\s*=/.test(a)),
            `\`${field}\` carries a per-field rename; CLAUDE.md allows only the struct-level rename_all`,
          ).toEqual([]);
          if (pin.optional) {
            expect(
              attrs.some((a) => a.includes("skip_serializing_if")),
              `\`${field}\` is optional on the TS side, so Rust must omit it at its default`,
            ).toBe(true);
          }
          const tsMembers = tsFields(tsBody);
          expect(tsMembers, `TS ${pin.ts} has no \`${camel(field)}\``).toContain(camel(field));
          const optionalInTs = new RegExp(`^\\s*${camel(field)}\\?\\s*:`, "m").test(tsBody);
          expect(optionalInTs, `\`${camel(field)}\` optionality must follow the Rust side`).toBe(pin.optional);
        });
      }
    });
  }

  it("the member lists no longer carry the retired `uniqueValues` on either side", () => {
    for (const [rust, ts] of [
      ["pub struct FilterRowData", "export interface FilterRowData"],
      ["pub struct FieldUniqueValuesResponse", "export interface FieldUniqueValuesResponse"],
    ]) {
      expect(rustFields(blockAfter(rustSrc, rust))).not.toContain("unique_values");
      expect(tsFields(blockAfter(tsSrc, ts))).not.toContain("uniqueValues");
    }
  });

  it("the Pivot extension does not hand-write a second PivotRegionData (it re-exports the facade's)", () => {
    const ext = read("extensions/Pivot/types.ts");
    expect(ext).not.toMatch(/export\s+interface\s+PivotRegionData\b/);
    expect(ext).toMatch(/export\s+type\s*\{\s*PivotRegionData\s*\}/);
  });

  it("non-vacuity: the field scan finds a field that is missing and refuses a renamed one", () => {
    const planted = "    pub a_b: u32,\n    #[serde(rename = \"x\")]\n    pub c_d: u32,\n";
    expect(rustFields(planted)).toEqual(["a_b", "c_d"]);
    expect(attributesOf(planted, "c_d").some((a) => /rename\s*=/.test(a))).toBe(true);
    expect(attributesOf(planted, "a_b")).toEqual([]);
  });
});

/** Exact field pin: the Rust struct's fields, camel-cased, are EXACTLY the TS interface's. */
function expectSameFields(rustSrc: string, rustHead: string, tsSrc: string, tsHead: string): void {
  const rustBody = blockAfter(rustSrc, rustHead);
  const head = rustSrc.slice(Math.max(0, rustSrc.indexOf(rustHead) - 200), rustSrc.indexOf(rustHead));
  expect(head, `${rustHead} renames at the struct level`).toMatch(/#\[serde\(rename_all = "camelCase"\)\]\s*$/);
  for (const field of rustFields(rustBody)) {
    expect(
      attributesOf(rustBody, field).filter((a) => /rename\s*=/.test(a)),
      `${field} carries a per-field rename`,
    ).toEqual([]);
  }
  expect([...tsFields(blockAfter(tsSrc, tsHead))].sort(), `${tsHead} mirrors ${rustHead}`).toEqual(
    rustFields(rustBody).map(camel).sort(),
  );
}

describe("the member shape mirrors Rust (P2 S7: key = identity, label = display)", () => {
  it("MemberRef { key, label } (api_types.rs -> app/src/api/types.ts)", () => {
    const rustSrc = read("src-tauri/src/api_types.rs");
    expect(rustFields(blockAfter(rustSrc, "pub struct MemberRef"))).toEqual(["key", "label"]);
    expectSameFields(rustSrc, "pub struct MemberRef", read("src/api/types.ts"), "export interface MemberRef");
  });

  it("SlicerItem { key, label, selected, hasData } in BOTH TS mirrors (slicer/types.rs)", () => {
    const rustSrc = read("src-tauri/src/slicer/types.rs");
    const fields = rustFields(blockAfter(rustSrc, "pub struct SlicerItem"));
    expect(fields).toContain("key");
    expect(fields).toContain("label");
    expect(fields, "the retired `value` is gone from the wire").not.toContain("value");
    expectSameFields(rustSrc, "pub struct SlicerItem", read("extensions/Slicer/lib/slicerTypes.ts"), "export interface SlicerItem");
    expectSameFields(
      rustSrc,
      "pub struct SlicerItem",
      read("extensions/ControlsPane/lib/filterPaneTypes.ts"),
      "export interface SlicerItem",
    );
  });

  it("non-vacuity: a renamed Rust field fails the exact pin", () => {
    const rust = '#[serde(rename_all = "camelCase")]\npub struct MemberRef {\n    pub key: String,\n    pub text: String,\n}\n';
    const ts = "export interface MemberRef {\n  key: string;\n  label: string;\n}\n";
    expect(() => expectSameFields(rust, "pub struct MemberRef", ts, "export interface MemberRef")).toThrow();
    const same = '#[serde(rename_all = "camelCase")]\npub struct MemberRef {\n    pub key: String,\n    pub label: String,\n}\n';
    expect(() => expectSameFields(same, "pub struct MemberRef", ts, "export interface MemberRef")).not.toThrow();
  });
});
