//! FILENAME: app/src/api/__tests__/buttonActionPrefixDrift.test.ts
// PURPOSE: M6 (phase 4 of BUG-0257): the approval id of inline button code is
//          spelled ONCE in Rust (`BUTTON_ACTION_CONSENT_PREFIX` +
//          `button_action_consent_id`, app/src-tauri/src/scripting/control_action.rs)
//          and mirrored in @api/heldButtonCode. The approval screen records
//          what the TypeScript side computes and the Rust button door asks for
//          what Rust computes, so a drift between them is an approval that
//          never counts: Allow pressed, every click still refused.
// CONTEXT: Read from the Rust source at test time, like every other mirror in
//          this folder. Also pinned here: the property names the approvability
//          rule reads (controls.rs), the door's precedence those names feed
//          (control_action::decide_control), and the stamp fields Rust's
//          `HeldFrom::decode` REQUIRES -- the strict TypeScript reader must
//          refuse exactly what Rust refuses, or the screen offers code the door
//          answers `stampUnreadable`.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  BUTTON_ACTION_CONSENT_PREFIX,
  HELD_FROM_PROPERTY,
  HELD_MACRO_REF_PROPERTY,
  HELD_ON_SELECT_PROPERTY,
  buttonActionConsentId,
  heldInlineVerdict,
  parseHeldFromStrict,
} from "../heldButtonCode";
import { SCRIPT_SURFACES } from "../scriptSurfaces";

const SRC_TAURI = path.resolve(__dirname, "../../../src-tauri/src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC_TAURI, rel), "utf8");

const CONTROL_ACTION = read("scripting/control_action.rs");
const CONTROLS = read("controls.rs");
const HELD = read("held_button_code.rs");

/** The string value of `pub(crate)? const NAME: &str = "...";` in a Rust source. */
function rustStrConst(source: string, name: string): string {
  const match = new RegExp(`pub(?:\\(crate\\))?\\s+const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]*)";`).exec(source);
  if (!match) throw new Error(`const ${name} not found`);
  return match[1];
}

describe("the button-action approval id", () => {
  // SABOTAGE: change BUTTON_ACTION_CONSENT_PREFIX in @api/heldButtonCode.ts to
  // "buttonAction/" -> red.
  it("has ONE prefix, spelled the same on both sides", () => {
    expect(BUTTON_ACTION_CONSENT_PREFIX).toBe(rustStrConst(CONTROL_ACTION, "BUTTON_ACTION_CONSENT_PREFIX"));
  });

  it("is the prefix followed by the lowercase sha256 hex of the exact UTF-8 bytes, as Rust builds it", () => {
    // Rust: format!("{BUTTON_ACTION_CONSENT_PREFIX}{}", calp::integrity::sha256_hex(code.as_bytes()))
    expect(CONTROL_ACTION).toContain(
      'format!("{BUTTON_ACTION_CONSENT_PREFIX}{}", calp::integrity::sha256_hex(code.as_bytes()))',
    );
    const code = "Calcula.setCellValue('A1', 'Café 😀');";
    const hex = createHash("sha256").update(code, "utf8").digest("hex");
    expect(buttonActionConsentId(hex)).toBe(`buttonAction:${hex}`);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is a trust id no `<surfaceId>:<id>` can spell -- no surface id is 'buttonAction', none holds a ':'", () => {
    for (const surface of SCRIPT_SURFACES) {
      expect(surface.id).not.toBe("buttonAction");
      expect(surface.id).not.toContain(":");
    }
  });
});

describe("the names and the precedence the approvability rule reads", () => {
  it("spells the held compartment and the live slots as controls.rs does", () => {
    expect(HELD_ON_SELECT_PROPERTY).toBe(rustStrConst(CONTROLS, "HELD_ON_SELECT_PROPERTY"));
    expect(HELD_MACRO_REF_PROPERTY).toBe(rustStrConst(CONTROLS, "HELD_MACRO_REF_PROPERTY"));
    expect(HELD_FROM_PROPERTY).toBe(rustStrConst(CONTROLS, "HELD_FROM_PROPERTY"));
    // The live slots are private to the TypeScript module; their spelling is
    // asserted through behaviour: a live link and live code each win.
    expect(rustStrConst(CONTROLS, "ON_SELECT_PROPERTY")).toBe("onSelect");
    expect(rustStrConst(CONTROLS, "MACRO_REF_PROPERTY")).toBe("macroRef");
    const stamp = { valueType: "static", value: JSON.stringify({ workspace: "w", application: "A", version: "1" }) };
    const held = { valueType: "static", value: "X();" };
    expect(heldInlineVerdict("button", { heldOnSelect: held, heldFrom: stamp })).toMatchObject({ runs: true });
    expect(heldInlineVerdict("button", { heldOnSelect: held, heldFrom: stamp, onSelect: held })).toMatchObject({
      runs: false,
    });
    expect(heldInlineVerdict("button", { heldOnSelect: held, heldFrom: stamp, macroRef: held })).toMatchObject({
      runs: false,
    });
  });

  it("follows the door's order: not a button, then a link, then the user's own code, then the stamp, then the type", () => {
    const decide = CONTROL_ACTION.slice(CONTROL_ACTION.indexOf("fn decide_control("));
    const at = (needle: string): number => {
      const i = decide.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('if meta.control_type != "button" {'),
      at("if slot(MACRO_REF_PROPERTY).is_some() || slot(HELD_MACRO_REF_PROPERTY).is_some() {"),
      at("if let Some(live) = slot(ON_SELECT_PROPERTY) {"),
      at("HeldFrom::decode(&p.value)"),
      at('if held.value_type != "static" || from.value_type_of(ON_SELECT_PROPERTY) != "static" {'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("the stamp fields Rust requires", () => {
  /** HeldFrom's fields, and which carry `#[serde(default...)]`. */
  function heldFromFields(): Array<{ name: string; defaulted: boolean }> {
    const start = HELD.indexOf("pub struct HeldFrom {");
    expect(start).toBeGreaterThan(-1);
    const body = HELD.slice(start, HELD.indexOf("\n}\n", start));
    const fields: Array<{ name: string; defaulted: boolean }> = [];
    let defaulted = false;
    for (const line of body.split(/\r?\n/).slice(1)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#[serde(default")) defaulted = true;
      const field = /^pub\s+(\w+)\s*:/.exec(trimmed);
      if (field) {
        fields.push({ name: field[1], defaulted });
        defaulted = false;
      }
    }
    return fields;
  }

  const camel = (snake: string): string => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

  it("the struct still has the shape this mirror knows (rename_all camelCase, three required, one defaulted)", () => {
    expect(HELD).toMatch(/#\[serde\(rename_all = "camelCase"\)\]\s*pub struct HeldFrom \{/);
    expect(heldFromFields()).toEqual([
      { name: "workspace", defaulted: false },
      { name: "application", defaulted: false },
      { name: "version", defaulted: false },
      { name: "value_types", defaulted: true },
    ]);
  });

  // SABOTAGE: let parseHeldFromStrict default a missing `workspace` to "" (the
  // lax reader's behaviour) -> red.
  it("the strict reader refuses a stamp missing any field Rust requires, and accepts one missing only a defaulted field", () => {
    const full: Record<string, unknown> = { workspace: "w", application: "A", version: "1", valueTypes: {} };
    for (const { name, defaulted } of heldFromFields()) {
      const key = camel(name);
      const without = { ...full };
      delete without[key];
      const parsed = parseHeldFromStrict(JSON.stringify(without));
      if (defaulted) expect(parsed, `${key} is defaulted in Rust`).not.toBeNull();
      else expect(parsed, `${key} is required in Rust`).toBeNull();
    }
  });
});
