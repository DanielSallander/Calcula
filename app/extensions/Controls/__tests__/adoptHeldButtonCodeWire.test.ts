//! FILENAME: app/extensions/Controls/__tests__/adoptHeldButtonCodeWire.test.ts
// PURPOSE: "Make this my own" (phase 4 of BUG-0257) over the wire: the
//          arguments `adoptHeldButtonCode` sends are EXACTLY the parameters of
//          the Rust command `controls::adopt_held_button_code`, in Tauri's
//          camelCase -- read from app/src-tauri/src/controls.rs at test time.
// CONTEXT: Tauri matches command arguments by name. A renamed field on one
//          side does not fail loudly: an `Option<String>` that finds no
//          argument deserializes as None, so a TS `shownOnSelect` renamed
//          `onSelect` would reach Rust as "nothing was shown" -- and Rust would
//          refuse every adoption as "changed after it was shown". The command
//          must also exist where the page calls it (registered in lib.rs).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { adoptHeldButtonCode } from "../lib/controlApi";
import { controlsBackend } from "../lib/controlsBackend";

const SRC_TAURI = path.resolve(__dirname, "../../../src-tauri/src");
const COMMAND = "adopt_held_button_code";

/** Tauri's own conversion of a Rust argument name. */
const camel = (snake: string): string => snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** The command's parameters as Rust declares them: (name, type), Tauri-injected ones left out. */
function rustParameters(): { name: string; type: string }[] {
  const src = fs.readFileSync(path.join(SRC_TAURI, "controls.rs"), "utf8");
  const head = `pub fn ${COMMAND}(`;
  const start = src.indexOf(head);
  expect(start, `controls.rs no longer declares ${head}`).toBeGreaterThan(-1);
  // The attribute that makes it a command sits just above it.
  expect(src.slice(Math.max(0, start - 200), start)).toContain("#[tauri::command]");
  const end = src.indexOf(") -> Result<ControlMetadata, String>", start);
  expect(end, "the command no longer answers Result<ControlMetadata, String>").toBeGreaterThan(start);
  return src
    .slice(start + head.length, end)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const colon = p.indexOf(":");
      return { name: p.slice(0, colon).trim(), type: p.slice(colon + 1).trim() };
    })
    .filter((p) => !/^State</.test(p.type) && !/^tauri::(Window|AppHandle|WebviewWindow)$/.test(p.type));
}

async function sentArgs(shownOnSelect: string | null, shownMacroRef: string | null) {
  const sent: { cmd: string; args?: Record<string, unknown> }[] = [];
  controlsBackend.set(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    sent.push({ cmd, args });
    return { controlType: "button", properties: {} } as T;
  });
  await adoptHeldButtonCode(3, 7, 2, shownOnSelect, shownMacroRef);
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe("adopt_held_button_code: the page's arguments are the Rust command's parameters", () => {
  it("Rust declares the parameters the dialog's texts travel in", () => {
    expect(rustParameters()).toEqual([
      { name: "sheet_index", type: "usize" },
      { name: "row", type: "u32" },
      { name: "col", type: "u32" },
      { name: "shown_on_select", type: "Option<String>" },
      { name: "shown_macro_ref", type: "Option<String>" },
    ]);
  });

  // SABOTAGE: rename `shownOnSelect` to `onSelect` in controlApi.adoptHeldButtonCode
  // -> the key sets differ -> red.
  it("the page sends exactly those names, camelCased, and nothing else", async () => {
    const { cmd, args } = await sentArgs("Report();", "macro-report");
    expect(cmd).toBe(COMMAND);
    expect(Object.keys(args ?? {}).sort()).toEqual(rustParameters().map((p) => camel(p.name)).sort());
    expect(args).toEqual({ sheetIndex: 3, row: 7, col: 2, shownOnSelect: "Report();", shownMacroRef: "macro-report" });
  });

  // An Option the dialog did not show is sent as null -- never "" and never a
  // re-read value -- which Rust reads as None, "not shown".
  it("a slot the dialog did not show travels as null", async () => {
    const { args } = await sentArgs("Report();", null);
    expect(args).toEqual({ sheetIndex: 3, row: 7, col: 2, shownOnSelect: "Report();", shownMacroRef: null });
  });

  it("the command is registered where the page calls it", () => {
    const lib = fs.readFileSync(path.join(SRC_TAURI, "lib.rs"), "utf8");
    const registered = lib
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter((line) => line === `controls::${COMMAND},`);
    expect(registered, `generate_handler! does not register controls::${COMMAND}`).toHaveLength(1);
  });
});
