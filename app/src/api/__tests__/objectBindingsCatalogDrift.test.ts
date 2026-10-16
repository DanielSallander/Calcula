//! FILENAME: app/src/api/__tests__/objectBindingsCatalogDrift.test.ts
// PURPOSE: The TS binding catalog (`@api/objectBindings` catalog.ts) is a
//          MIRROR of the Rust authority (app/src-tauri/src/object_bindings/
//          catalog.rs). This test reads the Rust sources at test time and
//          diffs them against the mirror BOTH ways -- every Rust row must be in
//          the mirror, in the same order, with the same type and flags, and the
//          mirror may hold nothing Rust does not -- plus the kind list, the kind
//          labels, the container roots, the pointer limits, the never-bindable
//          control keys (read from the controls.rs constants) and the event
//          name the bridge listens to.
// CONTEXT: The direction is Rust -> TS (the interpreterReachDrift /
//          backendCommandDrift precedent): Rust is where the door is, so when
//          this fails, change the MIRROR to match Rust, never the reverse.
//          The row parse is the same one-row-per-line regex Rust's own
//          `catalog_rows_are_one_per_line_and_parse` proves non-vacuous.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BINDABLE_PATHS,
  CONTAINER_ROOT_POINTER,
  MAX_BINDING_PATH_CHARS,
  MAX_BINDING_PATH_SEGMENTS,
  MAX_BINDING_PATH_SEGMENT_CHARS,
  OBJECT_BINDING_KINDS,
  OBJECT_BINDING_KIND_LABELS,
  isBindablePath,
  isNeverBindableControlKey,
  matchBindablePath,
  neverBindableControlReason,
  pointerSegments,
  escapePointerSegment,
  unescapePointerSegment,
  pageOverridesRefusal,
  pageButtonPointer,
  PAGE_OVERRIDE_IDENTITY_FIELDS,
  type BindableValueType,
} from "../objectBindings/catalog";
import { BACKEND_OBJECT_BINDINGS_EVENT } from "../objectBindings/bridge";
import type { ObjectBindingKind } from "../types";

const REPO = path.resolve(__dirname, "../../../..");
const CATALOG_RS = path.join(REPO, "app/src-tauri/src/object_bindings/catalog.rs");
const MOD_RS = path.join(REPO, "app/src-tauri/src/object_bindings/mod.rs");
const API_TYPES_RS = path.join(REPO, "app/src-tauri/src/api_types.rs");
const CONTROLS_RS = path.join(REPO, "app/src-tauri/src/controls.rs");

function read(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** `TimelineSlicer` -> `timelineSlicer` (serde rename_all = "camelCase"). */
function camel(variant: string): string {
  return variant.charAt(0).toLowerCase() + variant.slice(1);
}

interface ParsedRow {
  kind: string;
  pointer: string;
  valueType: BindableValueType;
  origin: string;
  protectEditObjects: boolean;
  lockObjectsPosition: boolean;
}

const ROW_RE =
  /^row\(K::(\w+), "([^"]+)", T::(\w+)(?:\(&\[([^\]]*)\]\))?, O::(\w+), (true|false), (true|false)\),$/;

function parseRustRows(): ParsedRow[] {
  const src = read(CATALOG_RS);
  const start = src.indexOf("pub const BINDABLE_PATHS");
  expect(start, "catalog.rs has no BINDABLE_PATHS").toBeGreaterThan(0);
  const open = src.indexOf("&[", src.indexOf("=", start));
  const close = src.indexOf("\n];", open);
  expect(close, "BINDABLE_PATHS has no closing `];` line").toBeGreaterThan(open);
  const lines = src
    .slice(src.indexOf("\n", open) + 1, close)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//"));
  return lines.map((line) => {
    const m = ROW_RE.exec(line);
    if (!m) throw new Error(`catalog.rs line is not ONE row in the parsed spelling: ${line}`);
    const members = m[4]
      ? m[4]
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter((s) => s !== "")
      : [];
    const t = m[3];
    const valueType: BindableValueType = t === "Enum" ? { enum: members } : (camel(t) as BindableValueType);
    return {
      kind: camel(m[1]),
      pointer: m[2],
      valueType,
      origin: camel(m[5]),
      protectEditObjects: m[6] === "true",
      lockObjectsPosition: m[7] === "true",
    };
  });
}

/** The string items of a Rust `&[...]` const body, resolving `NAME` consts in the same file. */
function rustStrList(src: string, name: string): string[] {
  const re = new RegExp(`pub const ${name}: &\\[&str\\]\\s*=\\s*&\\[([^\\]]*)\\];`);
  const m = re.exec(src);
  if (!m) throw new Error(`no const ${name}`);
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((item) => {
      if (item.startsWith('"')) return item.replace(/^"|"$/g, "");
      return rustStr(src, item);
    });
}

/** A Rust `pub const NAME: &str = "...";` value. */
function rustStr(src: string, name: string): string {
  const m = new RegExp(`pub const ${name}: &str = "([^"]*)";`).exec(src);
  if (!m) throw new Error(`no &str const ${name}`);
  return m[1];
}

describe("the TS binding catalog mirrors Rust's", () => {
  it("has every Rust row, in order, with the same type, origin and flags -- and nothing else", () => {
    const rust = parseRustRows();
    expect(rust.length, "the Rust parse found too few rows: the parse is broken").toBeGreaterThan(50);
    const ts = BINDABLE_PATHS.map((r) => ({
      kind: r.kind,
      pointer: r.pointer,
      valueType: r.valueType,
      origin: r.origin,
      protectEditObjects: r.protectEditObjects,
      lockObjectsPosition: r.lockObjectsPosition,
    }));
    // Both directions, with a readable diff when they part.
    const key = (r: ParsedRow) => `${r.kind} ${r.pointer}`;
    const missingInTs = rust.filter((r) => !ts.some((t) => key(t) === key(r))).map(key);
    const extraInTs = ts.filter((t) => !rust.some((r) => key(r) === key(t))).map(key);
    expect(missingInTs, "Rust rows the TS mirror lacks").toEqual([]);
    expect(extraInTs, "TS rows Rust does not have (Rust would refuse them)").toEqual([]);
    expect(ts).toEqual(rust);
  });

  it("the row parser refuses a row split over two lines (it cannot pass by skipping lines)", () => {
    expect(ROW_RE.test('row(K::Chart, "/spec/title", T::Text,')).toBe(false);
    expect(ROW_RE.test("O::Family, true, false),")).toBe(false);
    expect(ROW_RE.test('row(K::Chart, "/spec/title", T::Text, O::Family, true, false),')).toBe(true);
  });

  it("knows the same kinds, in the same order, with the same sentence labels", () => {
    const api = read(API_TYPES_RS);
    const body = /pub enum ObjectBindingKind \{([^}]*)\}/.exec(api);
    expect(body, "api_types.rs has no ObjectBindingKind enum").not.toBeNull();
    const variants = body![1]
      .split(",")
      .map((s) => s.replace(/\/\/.*$/gm, "").trim())
      .filter((s) => s !== "");
    expect(OBJECT_BINDING_KINDS).toEqual(variants.map(camel));

    const mod = read(MOD_RS);
    const labelFn = /pub fn label\(self\) -> &'static str \{([\s\S]*?)\n    \}/.exec(mod);
    expect(labelFn, "mod.rs has no ObjectBindingKind::label").not.toBeNull();
    const labels: Record<string, string> = {};
    for (const m of labelFn![1].matchAll(/ObjectBindingKind::(\w+) => "([^"]*)"/g)) labels[camel(m[1])] = m[2];
    expect(Object.keys(labels).length).toBe(OBJECT_BINDING_KINDS.length);
    expect(OBJECT_BINDING_KIND_LABELS).toEqual(labels);
  });

  it("puts every kind's container root where Rust's container_root does", () => {
    const src = read(CATALOG_RS);
    const fn = /pub fn container_root\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(src);
    expect(fn, "catalog.rs has no container_root").not.toBeNull();
    const roots: Record<string, string | null> = {};
    for (const m of fn![1].matchAll(/ObjectBindingKind::(\w+) => (Some\("([^"]*)"\)|None)/g)) {
      roots[camel(m[1])] = m[3] ?? null;
    }
    expect(Object.keys(roots).sort()).toEqual([...OBJECT_BINDING_KINDS].sort());
    expect(CONTAINER_ROOT_POINTER).toEqual(roots);
  });

  it("checks pointers against the same limits", () => {
    const src = read(CATALOG_RS);
    const num = (name: string) => Number(new RegExp(`pub const ${name}: usize = (\\d+);`).exec(src)?.[1]);
    expect(MAX_BINDING_PATH_CHARS).toBe(num("MAX_BINDING_PATH_CHARS"));
    expect(MAX_BINDING_PATH_SEGMENTS).toBe(num("MAX_BINDING_PATH_SEGMENTS"));
    expect(MAX_BINDING_PATH_SEGMENT_CHARS).toBe(num("MAX_BINDING_PATH_SEGMENT_CHARS"));
  });

  it("listens to the event name Rust emits", () => {
    const mod = read(MOD_RS);
    expect(rustStr(mod, "OBJECT_BINDINGS_CHANGED_EVENT")).toBe(BACKEND_OBJECT_BINDINGS_EVENT);
  });
});

describe("the never-bindable control keys are Rust's, read from the controls.rs constants", () => {
  const controls = read(CONTROLS_RS);
  const catalog = read(CATALOG_RS);
  const executable = rustStrList(controls, "EXECUTABLE_CONTROL_PROPERTIES");
  const action = rustStrList(controls, "BUTTON_ACTION_PROPERTIES");
  const positions = rustStrList(controls, "POSITION_SIZE_PROPERTIES").filter((k) => k !== "width" && k !== "height");
  const pin = rustStr(controls, "PIN_TO_GRID_PROPERTY");
  const identity = (() => {
    const m = /const CONTROL_IDENTITY_KEYS: &\[&str\] = &\[([^\]]*)\];/.exec(catalog);
    if (!m) throw new Error("catalog.rs has no CONTROL_IDENTITY_KEYS");
    return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter((s) => s !== "");
  })();
  // HELD_CONTROL_PROPERTIES spans two lines in controls.rs; read it whole.
  const held = (() => {
    const m = /pub const HELD_CONTROL_PROPERTIES: &\[&str\] =\s*&\[([^\]]*)\];/.exec(controls);
    if (!m) throw new Error("controls.rs has no HELD_CONTROL_PROPERTIES");
    return m[1].split(",").map((s) => s.trim()).filter((s) => s !== "").map((n) => rustStr(controls, n));
  })();

  it("reads a non-vacuous key list from Rust", () => {
    expect(executable).toEqual(expect.arrayContaining(["onSelect", "macroRef"]));
    expect(held).toEqual(expect.arrayContaining(["heldOnSelect", "heldMacroRef", "heldFrom"]));
    expect(action.length).toBeGreaterThanOrEqual(3);
    expect(positions).toEqual(expect.arrayContaining(["x", "y"]));
    expect(identity).toContain("uid");
  });

  it("refuses each with the Rust reason class, by the same sentence", () => {
    for (const k of executable) expect(neverBindableControlReason(k)).toBe(`'${k}' is code; code is never bound.`);
    for (const k of held) {
      expect(neverBindableControlReason(k)).toBe(`'${k}' holds an application's code compartment; it is never bound.`);
    }
    for (const k of action) {
      expect(neverBindableControlReason(k)).toBe(`'${k}' is a button's action wiring; an action is never bound.`);
    }
    expect(neverBindableControlReason(pin)).toBe(`'${pin}' decides how the control follows its cells; it is not bindable.`);
    for (const k of positions) {
      expect(neverBindableControlReason(k)).toBe(
        `'${k}' places the control; its position is not bindable (only width and height are).`,
      );
    }
    for (const k of identity) expect(neverBindableControlReason(k)).toBe(`'${k}' is the control's identity; it is never bound.`);
  });

  it("refuses nothing else: width, height and every control catalog key stay bindable", () => {
    const all = new Set([...executable, ...held, ...action, pin, ...positions, ...identity]);
    for (const r of BINDABLE_PATHS.filter((x) => x.kind === "control")) {
      const key = r.pointer.replace(/^\/properties\//, "").split("/")[0];
      expect(all.has(key), `catalog row ${r.pointer} names a never-bindable key`).toBe(false);
      expect(isNeverBindableControlKey(key), key).toBe(false);
    }
    expect(isNeverBindableControlKey("width")).toBe(false);
    expect(isNeverBindableControlKey("height")).toBe(false);
  });
});

/**
 * The SHARED FIXTURE: the paths D §3.4 lists and their outcome. The Rust half
 * of each line is asserted by catalog_tests.rs (named per line); this half
 * proves the mirror agrees, so the UI and the script validator refuse exactly
 * what the Rust door refuses.
 */
const PATH_FIXTURE: Array<[ObjectBindingKind, string, boolean, string, string]> = [
  // kind, path, bindable?, a word the refusal must contain, the Rust test that pins it
  ["chart", "/spec/series/3/name", true, "", "match_path_accepts_an_array_index_under_series"],
  ["chart", "/spec/series/x/name", false, "bindable properties are", "match_path_refuses_a_non_index_under_series"],
  ["chart", "/spec/series/12345/name", false, "bindable properties are", "match_path_refuses_a_non_index_under_series"],
  ["control", "/properties/name", false, "identity", "match_path_refuses_control_identity_code_held_action_and_position"],
  ["control", "/properties/onSelect", false, "code", "match_path_refuses_control_identity_code_held_action_and_position"],
  ["control", "/properties/heldOnSelect", false, "code compartment", "match_path_refuses_control_identity_code_held_action_and_position"],
  ["control", "/properties/action", false, "action", "match_path_refuses_control_identity_code_held_action_and_position"],
  ["control", "/properties/x", false, "position", "match_path_refuses_control_identity_code_held_action_and_position"],
  ["control", "/properties/pinToGrid", false, "follows its cells", "match_path_refuses_control_identity_code_held_action_and_position"],
  ["chart", "/spec/series/0/name", true, "", "the_identity_refusal_does_not_leak_into_other_kinds"],
  ["control", "/properties/foo", false, "/properties/text", "match_path_refuses_an_undeclared_control_key"],
  ["control", "/properties/pageOverrides", false, "never bound", "page_overrides_itself_is_refused_by_name"],
  ["control", "/properties/pageOverrides/7f9c2a64-3b1e-4d5a-9c8e-0a1b2c3d4e5f/text", true, "", "per_button_paths_are_keyed_by_page"],
  ["control", "/properties/pageOverrides/name:Sales/hidden", true, "", "per_button_paths_are_keyed_by_page"],
  ["control", "/properties/pageOverrides/name:Q1~1Q2/fill", true, "", "per_button_paths_are_keyed_by_page"],
  ["control", "/properties/pageOverrides/0/text", false, "bindable properties are", "per_button_paths_are_keyed_by_page"],
  ["control", "/properties/pageOverrides/Sales/text", false, "bindable properties are", "per_button_paths_are_keyed_by_page"],
  ["control", "/properties/pageOverrides/name:/text", false, "bindable properties are", "per_button_paths_are_keyed_by_page"],
  ["control", `/properties/pageOverrides/name:${"x".repeat(32)}/text`, false, "bindable properties are", "per_button_paths_are_keyed_by_page"],
  ["control", "/properties/pageOverrides/name:Sales/caption", false, "bindable properties are", "per_button_paths_are_keyed_by_page"],
  ["control", "/properties/pageOverrides/7f9c2a64-3b1e-4d5a-9c8e-0a1b2c3d4e5f/sheetId", false, "never bound", "per_button_identity_fields_are_refused_by_name"],
  ["control", "/properties/pageOverrides/name:Sales/sheetName", false, "never bound", "per_button_identity_fields_are_refused_by_name"],
  ["control", "/properties/width", true, "", "row_flags_match_the_family_gates"],
  ["chart", "/spec/seriesColors/Revenue 2024", true, "", "a_series_color_key_is_a_name_not_an_index"],
  ["chart", "/spec/seriesColors/a~1b", false, "bindable properties are", "a_series_color_key_is_a_name_not_an_index"],
  ["pivot", "/canvasFrame/x", false, "bindable properties are", "pivot_geometry_is_not_bindable"],
  ["pivot", "/canvasFrame/container/border/radius", true, "", "pivot_geometry_is_not_bindable"],
  ["control", "/properties/containerTitleFontSize", true, "", "control_container_keys_are_typed_family_rows"],
  ["control", "/properties/containerLockAspect", false, "bindable properties are", "control_container_keys_are_typed_family_rows"],
  ["chart", "/spec/container/title/text", false, "bindable properties are", "chart_title_text_has_one_spelling"],
  ["chart", "/spec/container/title/show", true, "", "chart_title_text_has_one_spelling"],
  ["chart", "", false, "JSON Pointer", "match_path_refuses_malformed_pointers"],
  ["chart", "spec/title", false, "JSON Pointer", "match_path_refuses_malformed_pointers"],
  ["chart", "/spec//title", false, "1 to 64", "match_path_refuses_malformed_pointers"],
  ["chart", "/spec/ti~2tle", false, "~0", "match_path_refuses_malformed_pointers"],
  ["chart", "/spec/title~", false, "~0", "match_path_refuses_malformed_pointers"],
  ["chart", "/a".repeat(9), false, "too deep", "match_path_refuses_malformed_pointers"],
  ["chart", `/${"a".repeat(65)}`, false, "1 to 64", "match_path_refuses_malformed_pointers"],
  ["chart", "/abcdefgh".repeat(30), false, "256", "match_path_refuses_malformed_pointers"],
];

describe("the shared path fixture: the mirror refuses exactly what the Rust door refuses", () => {
  it("names a Rust test for every line, and that test exists", () => {
    const tests = read(path.join(REPO, "app/src-tauri/src/object_bindings/catalog_tests.rs"));
    for (const [, , , , rustTest] of PATH_FIXTURE) {
      expect(tests, `catalog_tests.rs has no fn ${rustTest}`).toMatch(new RegExp(`fn ${rustTest}\\(`));
    }
  });

  for (const [kind, p, ok, word] of PATH_FIXTURE) {
    it(`${kind} ${p.length > 40 ? p.slice(0, 40) + "..." : JSON.stringify(p)} -> ${ok ? "bindable" : "refused"}`, () => {
      const r = matchBindablePath(kind, p);
      expect(r.ok).toBe(ok);
      expect(isBindablePath(kind, p) !== null).toBe(ok);
      if (!r.ok) expect(r.error).toContain(word);
    });
  }

  it("every row is reachable from a concrete path built from its pattern", () => {
    for (const r of BINDABLE_PATHS) {
      const segs = r.pointer.replace(/^\//, "").split("/");
      const concrete = segs.map((s, i) =>
        s !== "*" ? s : segs[i - 1] === "seriesColors" ? "Revenue" : segs[i - 1] === "pageOverrides" ? "name:Sales" : "0",
      );
      const hit = isBindablePath(r.kind, "/" + concrete.join("/"));
      expect(hit?.pointer, r.pointer).toBe(r.pointer);
    }
  });

  it("refuses a navigator's whole pageOverrides and its identity fields with Rust's sentences (D §3.18a)", () => {
    const catalog = read(CATALOG_RS);
    const pageOverridesRs = read(path.join(REPO, "app/src-tauri/src/object_bindings/page_overrides.rs"));
    expect(rustStrList(pageOverridesRs, "PAGE_OVERRIDE_IDENTITY_FIELDS")).toEqual([...PAGE_OVERRIDE_IDENTITY_FIELDS]);
    const fn = /pub fn page_overrides_refusal\([\s\S]*?\n\}/.exec(catalog);
    expect(fn, "catalog.rs has no page_overrides_refusal").not.toBeNull();
    // The whole-list sentence, joined from Rust's continued string literal.
    const whole = /"('\/properties\/pageOverrides'[^"]*?)\\\s*\n\s*([^"]*)"/.exec(fn![0]);
    expect(whole, "the whole-list sentence").not.toBeNull();
    expect(pageOverridesRefusal(["properties", "pageOverrides"])).toBe(`${whole![1]}${whole![2]}`);
    expect(fn![0]).toContain(`"'{field}' names the page a button setting is about; it is never bound."`);
    expect(pageOverridesRefusal(["properties", "pageOverrides", "x", "sheetId"])).toBe(
      "'sheetId' names the page a button setting is about; it is never bound.",
    );
    expect(pageOverridesRefusal(["properties", "pageOverrides", "x", "text"])).toBeNull();
    expect(pageOverridesRefusal(["properties", "text"])).toBeNull();
    // The pane's pointer for one page button escapes the page key like Rust's per_button_pointer.
    expect(pageButtonPointer("name:Q1/Q2", "fill")).toBe("/properties/pageOverrides/name:Q1~1Q2/fill");
    expect(isBindablePath("control", pageButtonPointer("name:Q1/Q2", "fill"))?.pointer).toBe("/properties/pageOverrides/*/fill");
  });

  it("escapes RFC 6901 segments like Rust", () => {
    expect(unescapePointerSegment("a~1b~0c")).toBe("a/b~c");
    expect(escapePointerSegment("a/b~c")).toBe("a~1b~0c");
    expect(unescapePointerSegment("bad~")).toBeNull();
    const ok = pointerSegments("/a".repeat(MAX_BINDING_PATH_SEGMENTS));
    expect(ok.ok && ok.segments.length).toBe(MAX_BINDING_PATH_SEGMENTS);
  });
});
