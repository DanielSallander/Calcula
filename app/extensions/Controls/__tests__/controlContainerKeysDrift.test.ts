//! FILENAME: app/extensions/Controls/__tests__/controlContainerKeysDrift.test.ts
// PURPOSE: The control container keys Controls READS and WRITES
//          (lib/controlContainerDefaults.ts) are exactly the ones Rust checks
//          (`visual_format::CONTROL_CONTAINER_PROPERTY_KEYS`, which
//          `set_control_property_core` / `set_control_appearance_core` run
//          `check_control_container_value` over) -- both directions (WP-C S13).
// CONTEXT: Rust is the authority on a `container*` value (TS checks first).
//          A key Controls wrote that Rust did not list would reach the store
//          UNCHECKED; a key Rust lists that Controls never reads would be a
//          format the pane writes and the control never paints. So the Rust
//          table is parsed from its source (one row per line) and diffed both
//          ways against what Controls actually asks `controlContainerKey` for,
//          kind by kind -- not only against the @api list.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  CONTROL_CONTAINER_PROPERTY_KEYS,
  VISUAL_CONTAINER_FIELD_IDS,
  controlContainerKey,
} from "@api/visualContainer";
import { SCRIPT_SHAPE_PROPERTY_KEYS } from "@api/scriptHost/validators";
import {
  CONTROL_CONTAINER_KINDS,
  controlContainerWrites,
  readControlContainer,
} from "../lib/controlContainerDefaults";

const REPO = path.resolve(__dirname, "../../../..");
const RUST_REL = "core/visual-format/src/lib.rs";
const RUST = fs.readFileSync(path.join(REPO, RUST_REL), "utf8").replace(/\r\n/g, "\n");

/** The rows of `pub const CONTROL_CONTAINER_PROPERTY_KEYS: &[&str] = &[ ... ];`. */
function rustControlContainerKeys(): string[] {
  const start = RUST.indexOf("pub const CONTROL_CONTAINER_PROPERTY_KEYS:");
  expect(start, `CONTROL_CONTAINER_PROPERTY_KEYS is gone from ${RUST_REL}`).toBeGreaterThan(-1);
  const open = RUST.indexOf("&[\n", start);
  const close = RUST.indexOf("\n];", open);
  expect(open > start && close > open, "the Rust table is no longer one row per line").toBe(true);
  return RUST.slice(open + 3, close)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//"))
    .map((l) => {
      const m = /^"([A-Za-z]+)",$/.exec(l);
      expect(m, `unparseable row: ${l}`).not.toBeNull();
      return m![1];
    });
}

/** The keys a control kind stores container fields under (the paint keys are not `container*`). */
function containerKeysControlsUses(): Set<string> {
  const used = new Set<string>();
  for (const kind of CONTROL_CONTAINER_KINDS) {
    for (const id of VISUAL_CONTAINER_FIELD_IDS) {
      const key = controlContainerKey(kind === "pageNavigator" ? "pageNavigator" : kind, id);
      if (key && key.startsWith("container")) used.add(key);
    }
  }
  return used;
}

describe("control container keys: Rust == what Controls reads and writes", () => {
  const rust = rustControlContainerKeys();

  it("parses the Rust table (non-vacuous)", () => {
    expect(rust.length).toBe(VISUAL_CONTAINER_FIELD_IDS.length);
    expect(rust).toContain("containerTitleText");
    expect(rust).toContain("containerBackgroundColor");
  });

  it("every key Controls stores a container field under is a Rust key", () => {
    const missingInRust = [...containerKeysControlsUses()].filter((k) => !rust.includes(k));
    expect(missingInRust, `edit ${RUST_REL}: Controls writes keys Rust never checks`).toEqual([]);
  });

  it("every Rust key is one Controls stores a field under (the navigator spells them all)", () => {
    const used = containerKeysControlsUses();
    const unused = rust.filter((k) => !used.has(k));
    expect(unused, "Rust checks keys no control kind ever reads or writes").toEqual([]);
  });

  it("is the same list, in the same order, as @api/visualContainer's", () => {
    expect(rust).toEqual([...CONTROL_CONTAINER_PROPERTY_KEYS]);
  });

  it("every key the provider's writer can produce is either a Rust container key or a family paint key", () => {
    const allowedPaint = new Set(["fill", "stroke", "strokeWidth", "borderColor"]);
    const everything: Record<string, unknown> = {};
    for (const id of VISUAL_CONTAINER_FIELD_IDS) {
      const [group, leaf] = id.includes(".") ? id.split(".") : [id, null];
      if (leaf === null) everything[group] = true;
      else everything[group] = { ...((everything[group] as Record<string, unknown>) ?? {}), [leaf]: null };
    }
    for (const kind of CONTROL_CONTAINER_KINDS) {
      // `padding: "6"` so a write of the navigator's padding key (to "") would
      // be a CHANGE and show up -- a writer that touched it must go red here.
      const props = { fill: "#123456", stroke: "#654321", strokeWidth: "3", padding: "6" };
      const writes = controlContainerWrites(kind, props, everything);
      for (const w of writes) {
        expect(rust.includes(w.key) || allowedPaint.has(w.key), `${kind} wrote "${w.key}"`).toBe(true);
      }
      // A navigator's padding is WP-B's `padding` key: never written from the Format pane.
      if (kind === "pageNavigator") expect(writes.map((w) => w.key)).not.toContain("padding");
    }
  });

  it("every Rust key is one a SCRIPT may write through shape.setProperty", () => {
    for (const k of rust) expect(SCRIPT_SHAPE_PROPERTY_KEYS, k).toContain(k);
  });

  it("reading a key back gives the field it was written for (round trip)", () => {
    const props: Record<string, string> = {};
    props.containerTitleShow = "true";
    props.containerTitleText = "Hello";
    props.containerShadowBlur = "12";
    const stored = readControlContainer("image", props);
    expect(stored.title).toMatchObject({ show: true, text: "Hello" });
    expect(stored.shadow).toMatchObject({ blur: 12 });
  });
});
