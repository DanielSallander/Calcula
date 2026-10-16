//! FILENAME: app/src/api/__tests__/visualContainerLimitsDrift.test.ts
// PURPOSE: The visual container is ONE schema in two languages: the TS
//          @api/visualContainer and the Rust leaf crate core/visual-format.
//          Nothing but this test keeps them the same -- the compiler cannot
//          see across the boundary -- so it reads the Rust source as TEXT and
//          diffs, BOTH directions (the crossLayerConstantDrift.test.ts shape):
//            1. every `pub const NAME: f64|usize = N;` limit against
//               VISUAL_CONTAINER_LIMITS (SCREAMING_SNAKE there, camelCase here);
//            2. FIELD_POINTERS (pointer + type + enum values, in ORDER) against
//               VISUAL_CONTAINER_FIELD_IDS / VISUAL_CONTAINER_FIELD_TYPES;
//            3. the numeric ranges of `field_range` against
//               VISUAL_CONTAINER_FIELD_RANGES;
//            4. CONTROL_CONTAINER_PROPERTY_KEYS against its Rust twin.
//          A failure names the file to edit.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  CONTROL_CONTAINER_PROPERTY_KEYS,
  VISUAL_CONTAINER_FIELD_IDS,
  VISUAL_CONTAINER_FIELD_RANGES,
  VISUAL_CONTAINER_FIELD_TYPES,
  VISUAL_CONTAINER_LIMITS,
  containerFieldPointer,
  type ContainerFieldId,
} from "../visualContainer";

const REPO = path.resolve(__dirname, "../../../..");
const RUST_REL = "core/visual-format/src/lib.rs";
const RUST = fs.readFileSync(path.join(REPO, RUST_REL), "utf8").replace(/\r\n/g, "\n");
const TS_REL = "app/src/api/visualContainer.ts";
const FIX = `Edit ${RUST_REL} and ${TS_REL} together.`;

/** PADDING_MAX -> paddingMax. */
const screamingToCamel = (s: string): string =>
  s.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** The body of a `pub const NAME: ... = &[ ... ];` table, line by line (comments dropped). */
function rustTableLines(name: string): string[] {
  const start = RUST.indexOf(`pub const ${name}:`);
  expect(start, `${name} is gone from ${RUST_REL}`).toBeGreaterThan(-1);
  const open = RUST.indexOf("&[\n", start);
  const close = RUST.indexOf("\n];", open);
  expect(open > start && close > open, `${name} is no longer a one-row-per-line table`).toBe(true);
  return RUST.slice(open + 3, close)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//"));
}

/** Every `const NAME: f64|usize = N;` in the file (pub or private), for resolving range bounds. */
function rustNumericConsts(): Map<string, { value: number; pub: boolean }> {
  const out = new Map<string, { value: number; pub: boolean }>();
  for (const m of RUST.matchAll(/^(pub )?const ([A-Z][A-Z0-9_]*): (?:f64|usize) = ([0-9.]+);/gm)) {
    out.set(m[2], { value: Number(m[3]), pub: m[1] !== undefined });
  }
  return out;
}

describe("limits: core/visual-format pub consts == VISUAL_CONTAINER_LIMITS", () => {
  it("every Rust limit is in the TS object with the same value", () => {
    const consts = [...rustNumericConsts()].filter(([, c]) => c.pub);
    expect(consts.length, `no pub limits parsed from ${RUST_REL}`).toBeGreaterThanOrEqual(14);
    const ts = VISUAL_CONTAINER_LIMITS as Record<string, number>;
    for (const [name, { value }] of consts) {
      const key = screamingToCamel(name);
      expect(ts[key], `Rust ${name} has no TS VISUAL_CONTAINER_LIMITS.${key}. ${FIX}`).toBeDefined();
      expect(ts[key], `${name} = ${value} in Rust but ${key} = ${ts[key]} in TS. ${FIX}`).toBe(value);
    }
  });

  it("every TS limit is a Rust pub const", () => {
    const consts = rustNumericConsts();
    for (const [key, value] of Object.entries(VISUAL_CONTAINER_LIMITS)) {
      const name = key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
      const rust = consts.get(name);
      expect(rust?.pub, `TS VISUAL_CONTAINER_LIMITS.${key} has no Rust pub const ${name}. ${FIX}`).toBe(true);
      expect(rust!.value, `${key}`).toBe(value);
    }
  });
});

/** "FieldType::Enum(&[\"a\", \"b\"])" -> { enum: [a, b] }; "FieldType::Number" -> "number". */
function parseRustFieldRow(line: string): { pointer: string; type: unknown } {
  const m = /^\("([^"]+)",\s*FieldType::(\w+)(?:\(&\[(.*)\]\))?\),$/.exec(line);
  expect(m, `unparseable FIELD_POINTERS row in ${RUST_REL}: ${line}`).not.toBeNull();
  const [, pointer, variant, enumBody] = m!;
  if (variant === "Enum") {
    const values = [...enumBody.matchAll(/"([^"]*)"/g)].map((v) => v[1]);
    return { pointer, type: { enum: values } };
  }
  return { pointer, type: variant.toLowerCase() };
}

describe("fields: Rust FIELD_POINTERS == VISUAL_CONTAINER_FIELD_IDS + VISUAL_CONTAINER_FIELD_TYPES", () => {
  const rows = rustTableLines("FIELD_POINTERS").map(parseRustFieldRow);

  it("the same pointers, in the same ORDER (validation reports the first bad leaf in this order)", () => {
    expect(rows.map((r) => r.pointer), FIX).toEqual(VISUAL_CONTAINER_FIELD_IDS.map(containerFieldPointer));
  });

  it("the same type (and enum values) per field, both directions", () => {
    const ts = new Map<string, unknown>(
      VISUAL_CONTAINER_FIELD_IDS.map((id) => {
        const t = VISUAL_CONTAINER_FIELD_TYPES[id];
        return [containerFieldPointer(id), typeof t === "string" ? t : { enum: [...t.enum] }];
      }),
    );
    for (const row of rows) {
      expect(ts.has(row.pointer), `Rust field ${row.pointer} is not a TS field id. ${FIX}`).toBe(true);
      expect(ts.get(row.pointer), `${row.pointer}: Rust and TS types differ. ${FIX}`).toEqual(row.type);
    }
    expect(rows.length, `TS has fields Rust lacks. ${FIX}`).toBe(ts.size);
    // Every TS type key exists for exactly the field ids (no stale entry).
    expect(Object.keys(VISUAL_CONTAINER_FIELD_TYPES).sort()).toEqual([...VISUAL_CONTAINER_FIELD_IDS].sort());
  });

  it("the numeric ranges: Rust field_range == VISUAL_CONTAINER_FIELD_RANGES, both directions", () => {
    const fnStart = RUST.indexOf("pub fn field_range(");
    expect(fnStart, `field_range is gone from ${RUST_REL}`).toBeGreaterThan(-1);
    const body = RUST.slice(fnStart, RUST.indexOf("\n}\n", fnStart));
    const consts = rustNumericConsts();
    const resolve = (tok: string): number => {
      const t = tok.trim();
      if (/^-?[0-9.]+$/.test(t)) return Number(t);
      const c = consts.get(t);
      expect(c, `field_range uses an unknown bound ${t}`).toBeDefined();
      return c!.value;
    };
    const rust = new Map<string, [number, number]>();
    for (const m of body.matchAll(/^\s*((?:"[^"]+"\s*\|?\s*)+)=>\s*\(([^,]+),\s*([^)]+)\),/gm)) {
      const range: [number, number] = [resolve(m[2]), resolve(m[3])];
      for (const p of m[1].matchAll(/"([^"]+)"/g)) rust.set(p[1], range);
    }
    expect(rust.size, `no ranges parsed from field_range in ${RUST_REL}`).toBe(17);
    const ts = new Map<string, readonly [number, number]>(
      (Object.entries(VISUAL_CONTAINER_FIELD_RANGES) as Array<[ContainerFieldId, readonly [number, number]]>).map(
        ([id, r]) => [containerFieldPointer(id), r],
      ),
    );
    for (const [pointer, range] of rust) {
      expect(ts.get(pointer), `${pointer}: Rust range ${range} differs from TS. ${FIX}`).toEqual(range);
    }
    for (const pointer of ts.keys()) {
      expect(rust.has(pointer), `TS range for ${pointer} has no Rust field_range arm. ${FIX}`).toBe(true);
    }
    // Every number / integer field has a range on the TS side too.
    for (const id of VISUAL_CONTAINER_FIELD_IDS) {
      const t = VISUAL_CONTAINER_FIELD_TYPES[id];
      expect(t === "number" || t === "integer", id).toBe(VISUAL_CONTAINER_FIELD_RANGES[id] !== undefined);
    }
  });
});

describe("controls: Rust CONTROL_CONTAINER_PROPERTY_KEYS == the TS twin", () => {
  it("the same keys, in the same order (index for index with the field ids)", () => {
    const rust = rustTableLines("CONTROL_CONTAINER_PROPERTY_KEYS").map((l) => {
      const m = /^"([A-Za-z]+)",$/.exec(l);
      expect(m, `unparseable CONTROL_CONTAINER_PROPERTY_KEYS row: ${l}`).not.toBeNull();
      return m![1];
    });
    expect(rust, FIX).toEqual([...CONTROL_CONTAINER_PROPERTY_KEYS]);
  });
});
