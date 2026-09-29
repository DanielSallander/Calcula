//! FILENAME: app/src/api/__tests__/apiVersion.test.ts
// PURPOSE: API_VERSION moved to 1.2.0 for what waves C-E ADDED to @api, and
//          version.ts says what those additions are -- each one real.
// CONTEXT: Y12 (wave E; wave D shell fix-up). Waves C and D added to the
//          extension surface (unregisterMenu / IMenuAPI.unregister with
//          keepWhileShared, the selection-ownership events,
//          SelectionOwner.receivesTyping, ExtensionRegistry.unregisterCommand,
//          the object clipboard, undo-transaction tickets) and wave E added
//          more (ownUndoTransaction, executeCommandAnywhere, the object
//          clipboard's door rule) while API_VERSION stayed 1.1.0. An extension
//          that used one could not SAY so: `apiVersion: "^1.2.0"` would have
//          been refused by this very host, and "^1.1.0" loads on a 1.1.0 host
//          that has none of it -- the extension then calls `undefined`. The
//          changelog is data so this test can check that every name it lists
//          exists (a listed name that is not there is a lie).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as version from "../version";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

type Entry = { name: string; module?: string; declaredIn?: string; pattern?: string };
type Changelog = ReadonlyArray<{ version: string; added: readonly Entry[] }>;
const CHANGELOG = (version as unknown as { API_CHANGELOG?: Changelog }).API_CHANGELOG;

/** Resolve an "@api/x" module name to a dynamic import of src/api/x. */
async function load(mod: string): Promise<Record<string, unknown>> {
  const rel = mod === "@api" ? "index" : mod.replace(/^@api\//, "");
  return (await import(/* @vite-ignore */ `../${rel}`)) as Record<string, unknown>;
}

describe("API_VERSION", () => {
  it("is 1.2.0", () => {
    expect(version.API_VERSION).toBe("1.2.0");
  });

  it("carries a changelog whose newest entry IS the current version", () => {
    expect(Array.isArray(CHANGELOG), "version.ts exports no API_CHANGELOG").toBe(true);
    expect(CHANGELOG![0].version).toBe(version.API_VERSION);
  });
});

describe("the 1.2.0 changelog names what was added, and every name is real", () => {
  const REQUIRED = [
    "unregisterMenu",
    "IMenuAPI.unregister",
    "onSelectionOwnershipChanged",
    "notifySelectionOwnershipChanged",
    "SelectionOwner.receivesTyping",
    "ExtensionRegistry.unregisterCommand",
    "copySelectedObjects",
    "pasteObjectClipboard",
    "clipboardDoorCommand",
    "readUndoBeginAnswer",
    "ownUndoTransaction",
    "executeCommandAnywhere",
  ];

  it("lists every wave C-E addition", () => {
    const names = new Set(CHANGELOG?.[0]?.added.map((e) => e.name) ?? []);
    for (const n of REQUIRED) expect(names.has(n), `1.2.0's changelog does not list ${n}`).toBe(true);
  });

  it("every runtime export it lists exists where it says", async () => {
    for (const e of CHANGELOG?.[0]?.added ?? []) {
      if (!e.module) continue;
      const mod = await load(e.module);
      const exportName = e.name.includes(".") ? e.name.split(".")[0] : e.name;
      const value = mod[exportName];
      expect(value, `${e.name} is listed as exported by ${e.module}, which does not export it`).toBeDefined();
      if (e.name.includes(".")) {
        const member = e.name.split(".")[1];
        expect(
          (value as Record<string, unknown>)[member],
          `${e.name}: ${exportName} has no member ${member}`,
        ).toBeDefined();
      }
    }
  }, 120_000);

  it("every declared (type-only) member it lists is declared where it says", () => {
    for (const e of CHANGELOG?.[0]?.added ?? []) {
      if (!e.declaredIn) continue;
      expect(e.pattern, `${e.name} names a file but no declaration pattern`).toBeTruthy();
      expect(read(e.declaredIn), `${e.name} is not declared in ${e.declaredIn}`).toMatch(new RegExp(e.pattern!));
    }
  });
});
