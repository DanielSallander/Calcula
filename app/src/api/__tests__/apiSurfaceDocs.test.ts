//! FILENAME: app/src/api/__tests__/apiSurfaceDocs.test.ts
// PURPOSE: What @api DOCUMENTS about its menu and selection-owner surface is
//          true, and what it added is documented.
// CONTEXT: X17 (wave D). Wave C added `unregisterMenu` / `IMenuAPI.unregister`,
//          `onSelectionOwnershipChanged` / `notifySelectionOwnershipChanged` and
//          `SelectionOwner.receivesTyping`, CHANGED the meaning of
//          `unregisterMenuItem` / `IMenuAPI.unregisterItem` (an item at ANY
//          depth; a parent left empty goes with its last child), and wave D
//          gave `unregisterMenu` a `keepWhileShared` option for menus other
//          extensions add to. The extension guide (docs/EXTENSION_GUIDE.md) --
//          the page a third-party author reads -- knew none of it: its menu
//          section showed how to ADD a menu and an item and never how to take
//          them back, which every deactivate must.
//
//          Two directions, so the documentation cannot drift either way:
//            - every name the guide and the contract teach exists as an
//              export (a documented name that is not there is a lie);
//            - every member added to the surface is taught somewhere an
//              author reads.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

const GUIDE = read("../docs/EXTENSION_GUIDE.md");
const CONTRACT = read("src/api/contract.ts");
const OWNER_SEAM = read("src/api/selectionOwner.ts");
const OWNER_CORE = read("src/core/lib/selectionOwner.ts");

/** The IMenuAPI interface body, comments included. */
function menuApiBody(): string {
  const start = CONTRACT.indexOf("export interface IMenuAPI {");
  expect(start, "IMenuAPI is gone from contract.ts").toBeGreaterThanOrEqual(0);
  return CONTRACT.slice(start, CONTRACT.indexOf("\n}\n", start));
}

describe("the menu surface: taking back what an extension added", () => {
  it("IMenuAPI declares unregister (with keepWhileShared) and unregisterItem, and says what they do", () => {
    const body = menuApiBody();
    expect(body).toMatch(/unregister\(menuId: string, options\?: \{ keepWhileShared\?: boolean \}\): void;/);
    expect(body).toMatch(/unregisterItem\(menuId: string, itemId: string\): void;/);
    expect(body, "unregisterItem's changed meaning (any depth) is not stated").toMatch(/any depth/i);
    expect(body, "a parent emptied by the removal").toMatch(/left empty/i);
    expect(body, "keepWhileShared is not explained").toMatch(/keepWhileShared/);
    expect(body, "registerItem's merge of a shared parent is not stated").toMatch(/MERGES/);
  });

  it("the guide teaches unregisterMenu / unregisterMenuItem, the child-not-parent rule and keepWhileShared", () => {
    expect(GUIDE).toMatch(/unregisterMenuItem\(/);
    expect(GUIDE).toMatch(/unregisterMenu\(/);
    expect(GUIDE, "context.ui.menus.unregister / unregisterItem").toMatch(/context\.ui\.menus\.unregister(Item)?\b/);
    expect(GUIDE, "the CHILD id of a shared parent").toMatch(/shared\s+parent/i);
    expect(GUIDE).toMatch(/keepWhileShared/);
  });

  it("every menu function the guide names is an @api export", async () => {
    const api = await import("../index");
    for (const name of ["registerMenu", "registerMenuItem", "unregisterMenu", "unregisterMenuItem", "updateMenuItem"]) {
      if (GUIDE.includes(`${name}(`)) {
        expect(typeof (api as Record<string, unknown>)[name], `the guide teaches ${name}, which @api does not export`).toBe(
          "function",
        );
      }
    }
  }, 120_000);
});

describe("the selection-owner surface", () => {
  it("the guide teaches registerSelectionOwner (with receivesTyping), the door's question and the ownership events", () => {
    for (const name of [
      "registerSelectionOwner",
      "receivesTyping",
      "refuseIfSelectionOwned",
      "isSelectionOwned",
      "onSelectionOwnershipChanged",
      "notifySelectionOwnershipChanged",
    ]) {
      expect(GUIDE, `the extension guide never mentions ${name}`).toContain(name);
    }
    expect(GUIDE).toContain("@api/selectionOwner");
  });

  it("every selection-owner function the guide names is exported by @api/selectionOwner", async () => {
    const seam = await import("../selectionOwner");
    for (const name of [
      "registerSelectionOwner",
      "refuseIfSelectionOwned",
      "isSelectionOwned",
      "onSelectionOwnershipChanged",
      "notifySelectionOwnershipChanged",
    ]) {
      expect(typeof (seam as Record<string, unknown>)[name], `@api/selectionOwner does not export ${name}`).toBe("function");
    }
  }, 120_000);

  it("@api/selectionOwner's own usage header shows receivesTyping, which the type declares", () => {
    expect(OWNER_CORE).toMatch(/receivesTyping\?: \(\) => boolean;/);
    const header = OWNER_SEAM.slice(0, OWNER_SEAM.indexOf("import "));
    expect(header, "the owner example in the seam's header omits receivesTyping").toContain("receivesTyping");
  });
});
