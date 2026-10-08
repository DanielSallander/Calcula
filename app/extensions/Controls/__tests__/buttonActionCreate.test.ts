//! FILENAME: app/extensions/Controls/__tests__/buttonActionCreate.test.ts
// PURPOSE: A declarative button action (Canvas contract §3/§4.4) is WRITTEN by
//          the one button recipe (createButtonControlAt, the
//          @api/buttonControlService provider) as its three properties, and is
//          KNOWN to the floating store from every door a button enters it by:
//          creation, the load of a sheet, and a paste/duplicate. The store is
//          what the click reads, so a door that forgets it is a button that
//          silently falls back to "nothing to run".
// CONTEXT: The real create function from index.ts against the in-memory
//          control-metadata stand-in controlPlacement.test.ts uses; the load
//          and the click are pinned in index.ts's source (importing them runs
//          the whole extension), the same idiom as shapeCreation.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

interface Meta {
  controlType: string;
  properties: Record<string, { valueType: string; value: string }>;
}

const backend = new Map<string, Meta>();
const key = (s: number, r: number, c: number) => `${s}:${r}:${c}`;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

vi.mock("../lib/controlApi", () => ({
  async getControlMetadata(s: number, r: number, c: number) {
    await tick();
    return backend.get(key(s, r, c)) ?? null;
  },
  async setControlMetadata(s: number, r: number, c: number, meta: Meta) {
    await tick();
    backend.set(key(s, r, c), JSON.parse(JSON.stringify(meta)));
    return meta;
  },
  async removeControlMetadata(s: number, r: number, c: number) {
    await tick();
    return backend.delete(key(s, r, c));
  },
  async getAllControls(s: number) {
    await tick();
    return [...backend.entries()]
      .map(([k, metadata]) => {
        const [sheetIndex, row, col] = k.split(":").map(Number);
        return { sheetIndex, row, col, metadata };
      })
      .filter((e) => e.sheetIndex === s);
  },
  setControlProperty: vi.fn(),
  resolveControlProperties: vi.fn(async () => ({})),
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({
    config: { defaultCellWidth: 100, defaultCellHeight: 24, activeSheet: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
  }),
}));

vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

import { createButtonControlAt } from "../index";
import { getAllFloatingControls, getFloatingControl, removeFloatingControl } from "../lib/floatingStore";

const INDEX_SRC = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
const CLIPBOARD_SRC = fs.readFileSync(path.resolve(__dirname, "../lib/controlClipboard.ts"), "utf8");

function props(s: number, r: number, c: number): Record<string, string> {
  const meta = backend.get(key(s, r, c));
  expect(meta, `no control metadata at ${key(s, r, c)}`).toBeDefined();
  return Object.fromEntries(Object.entries(meta!.properties).map(([k, v]) => [k, v.value]));
}

/** The body of one top-level function in index.ts. */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated ${signature}`);
}

beforeEach(() => {
  backend.clear();
  for (const c of getAllFloatingControls()) removeFloatingControl(c.id);
});

describe("createButton with an action", () => {
  // SABOTAGE: drop the `...buttonActionProperties(...)` spread from
  // createButtonControlAt -> no `action` property is written.
  it("writes the three action properties and an EMPTY onSelect, and the store knows the action", async () => {
    const h = await createButtonControlAt({
      sheetIndex: 2,
      label: "Details",
      x: 32,
      y: 48,
      action: { kind: "navigate", sheetId: "id-details", sheetName: "Details" },
    });
    const p = props(2, h.row, h.col);
    expect(p.action).toBe("navigate");
    expect(p.actionTarget).toBe("id-details");
    expect(p.actionTargetName).toBe("Details");
    expect(p.onSelect).toBe("");
    expect(p).not.toHaveProperty("macroRef");
    expect(p.text).toBe("Details");
    // SABOTAGE: drop `buttonAction` from the addFloatingControl call -> red.
    expect(getFloatingControl(h.instanceId)?.buttonAction).toEqual({
      kind: "navigate",
      sheetId: "id-details",
      sheetName: "Details",
    });
  });

  it("a button without an action writes no action properties at all", async () => {
    const h = await createButtonControlAt({ sheetIndex: 0, label: "Plain", x: 0, y: 0 });
    const p = props(0, h.row, h.col);
    expect(p).not.toHaveProperty("action");
    expect(p).not.toHaveProperty("actionTarget");
    expect(getFloatingControl(h.instanceId)?.buttonAction).toBeUndefined();
  });

  // SABOTAGE: drop the checkCreateButtonAction refusal -> a button with both
  // code and an action is written, and which one a click runs is a rule
  // nobody can see.
  it("refuses an action beside code BEFORE anything is written", async () => {
    await expect(
      createButtonControlAt({ sheetIndex: 0, label: "X", x: 0, y: 0, onSelect: "Run();", action: { kind: "back" } }),
    ).rejects.toThrow(/onSelect/);
    expect(backend.size).toBe(0);
    expect(getAllFloatingControls()).toEqual([]);
  });
});

describe("the store learns the action from every door a button enters by", () => {
  // SABOTAGE: drop `buttonAction:` from loadFloatingControls -> a saved
  // navigation button reopens as a button with nothing to run.
  it("the load of a sheet", () => {
    const body = functionBody(INDEX_SRC, "async function loadFloatingControls(");
    expect(body).toMatch(/buttonAction:\s*buttonActionOfControl\(/);
  });

  it("a paste or duplicate", () => {
    const body = functionBody(CLIPBOARD_SRC, "async function createControlCopy(");
    expect(body).toMatch(/buttonActionOfControl\(metadata\.controlType, metadata\.properties\)/);
  });

  it("a Properties-pane change", () => {
    expect(INDEX_SRC).toMatch(/"controls:action-changed"/);
  });
});

describe("the run-mode click", () => {
  // The declarative action is decided BEFORE the script door: a navigation
  // button must work with Script Security off and on a subscribed report.
  // SABOTAGE: move the tryStoredButtonAction line below runFloatingButtonClick.
  it("tries the stored action first, and asks the door only when there is none", () => {
    const at = INDEX_SRC.indexOf("const handleButtonPress = (e: Event) => {");
    expect(at).toBeGreaterThan(-1);
    const body = INDEX_SRC.slice(at, INDEX_SRC.indexOf("window.addEventListener(\"floatingObject:bodyDragStart\"", at));
    const tried = body.indexOf("tryStoredButtonAction(controlId, controlSheet)");
    const door = body.indexOf("runFloatingButtonClick(");
    expect(tried, "the stored action is never tried").toBeGreaterThan(-1);
    expect(door).toBeGreaterThan(tried);
  });

  // Review finding (2026-10-08): the `button:clicked` hook -- which every
  // object script mounted on the button answers with its onClick -- fired
  // BEFORE the action was tried, so a Back / Go to page button ALSO ran the
  // object scripts bound to it, while the Properties pane said "A click
  // performs this action" and @api/buttonControlService said a button with an
  // action "has no code". ONE BUTTON, ONE THING: a button with an action
  // performs it and runs no code of any kind -- no macro, no inline code, no
  // object script. The hook fires only for a button with no action.
  // SABOTAGE: move the emit back above the tryStoredButtonAction line.
  it("a button with an action runs no object script: the onClick hook fires only when there is no action", () => {
    const at = INDEX_SRC.indexOf("const handleButtonPress = (e: Event) => {");
    const body = INDEX_SRC.slice(at, INDEX_SRC.indexOf("window.addEventListener(\"floatingObject:bodyDragStart\"", at));
    const tried = body.indexOf("if (tryStoredButtonAction(controlId, controlSheet)) return;");
    const hook = body.indexOf('emitAppEvent("button:clicked"');
    expect(tried, "the action is tried with an early return").toBeGreaterThan(-1);
    expect(hook, "the onClick hook is gone").toBeGreaterThan(-1);
    expect(hook, "the onClick hook fires before the action is tried").toBeGreaterThan(tried);
    expect(body.split('emitAppEvent("button:clicked"').length - 1, "one hook, on the code path only").toBe(1);
  });

  // The script door's census (controlActionDoor.test.ts) forbids the floating
  // click to read the button's metadata at all -- so the store must be right
  // from EVERY door, and there is no fresh-read fallback to hide a door that
  // forgot. This is the last one: a button toggled out of its cell.
  it("never reads the button's metadata on the click; the toggle out of a cell carries the action", () => {
    const click = functionBody(INDEX_SRC, "async function runFloatingButtonClick(");
    expect(click).not.toContain("getControlMetadata(");
    const toggle = functionBody(INDEX_SRC, "async function handleEmbeddedToggle(");
    expect(toggle).toContain('buttonAction: buttonActionOfControl("button", afterPin?.properties)');
  });
});
