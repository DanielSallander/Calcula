//! FILENAME: app/extensions/Controls/__tests__/controlInsertSelectionOwner.test.ts
// PURPOSE: Wave-B B8 -- the Insert-menu control doors (Button, Shape, Image)
//          refuse, with ONE toast, while a feature owns the selection
//          (@api/selectionOwner), instead of placing the control at Core's
//          hidden cell. Driven with the REAL seam and a test owner; the doors
//          are pinned to the helper by their source.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const toasts: string[] = [];
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import { registerSelectionOwner } from "@api/selectionOwner";
import { insertAnchorOrRefuse } from "../lib/insertAnchor";

let release: (() => void) | null = null;
let owned = false;

beforeEach(() => {
  toasts.length = 0;
  owned = false;
  release = registerSelectionOwner({
    id: "testOwner",
    label: "a test object's cells",
    ownsSelection: () => owned,
  });
});

afterEach(() => {
  release?.();
  release = null;
});

describe("insertAnchorOrRefuse", () => {
  it("refuses with one toast and never reads Core's selection while an owner holds it", () => {
    owned = true;
    const read = vi.fn(() => ({ endRow: 4, endCol: 2 }));
    expect(insertAnchorOrRefuse("Insert Button", read)).toBeNull();
    expect(read, "the door read Core's hidden cell anyway").not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("Insert Button");
  });

  it("control: Core's own selection is the anchor, and nothing is announced", () => {
    const read = vi.fn(() => ({ endRow: 4, endCol: 2 }));
    expect(insertAnchorOrRefuse("Insert Button", read)).toEqual({ endRow: 4, endCol: 2 });
    expect(toasts).toHaveLength(0);
  });
});

describe("every Insert-menu control door asks the seam before it reads the selection", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
  const bodyOf = (name: string) => {
    const s = src.indexOf(`async function ${name}(`);
    expect(s, `${name} not found`).toBeGreaterThan(-1);
    return src.slice(s, src.indexOf("\n}\n", s));
  };

  for (const [door, action] of [
    ["insertButton", "Insert Button"],
    ["insertShape", "Insert Shape"],
    ["insertImage", "Insert Image"],
  ] as const) {
    it(`${door} goes through insertAnchorOrRefuse("${action}")`, () => {
      const body = bodyOf(door);
      expect(body).toContain(`insertAnchorOrRefuse("${action}"`);
      expect(body, `${door} still reads Core's selection directly`).not.toMatch(
        /const sel = getCurrentSelectionFromInterceptor\(\);/,
      );
    });
  }

  it("insertImage refuses BEFORE it opens the file picker", () => {
    const body = bodyOf("insertImage");
    const refuse = body.indexOf('refuseIfSelectionOwned("Insert Image")');
    const picker = body.indexOf("pickValidatedImage(");
    expect(refuse, "insertImage does not ask the seam before the picker").toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(picker);
  });

  // Found live 2026-09-29 (e2e fixall-canvas B5): on a sheet protected against
  // object edits the backend refuses the button, and Insert > Controls > Button
  // dropped the rejection -- nothing appeared and nothing said why. Every door
  // catches its create and SAYS the refusal, once, as the shape door always did.
  for (const [door, create] of [
    ["insertButton", "createButtonControlAt("],
    ["insertShape", "createShapeControlAt("],
  ] as const) {
    it(`${door} catches a refused ${create.slice(0, -1)} and says it in a toast`, () => {
      const body = bodyOf(door);
      const at = body.indexOf(create);
      expect(at, `${door} no longer creates through ${create}`).toBeGreaterThan(-1);
      const tryAt = body.lastIndexOf("try {", at);
      const catchAt = body.indexOf("} catch", at);
      expect(tryAt, `${door}: the create is not inside a try`).toBeGreaterThan(-1);
      expect(catchAt, `${door}: the refusal is not caught`).toBeGreaterThan(at);
      expect(body.slice(catchAt), `${door}: the caught refusal is not SAID`).toContain("showToast(");
    });
  }
});
