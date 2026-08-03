//! FILENAME: app/extensions/MacroRecorder/__tests__/buttonScript.test.ts
// PURPOSE: "Save as button script" goes through the Controls-owned seam, binds
//          the object script to the instanceId the SEAM returned, and rolls the
//          button back when the script cannot be stored.
// CONTEXT: The reported bug: "When I saved it as a button it did not create an
//          actual button. Nothing appeared." The recorder was writing another
//          extension's control metadata by hand — a successful backend call that
//          rendered nothing. These tests pin the two properties that made that
//          possible: the recorder must not build the control itself, and it must
//          not invent the instanceId it binds to.

import { describe, it, expect, beforeEach, vi } from "vitest";

const objectScripts: Array<Record<string, unknown>> = [];
const manager = {
  registered: [] as string[],
  mounted: [] as string[],
};

vi.mock("@api", () => ({
  saveObjectScript: async (definition: Record<string, unknown>) => {
    if (definition.id === "macro-control-0-9-9") throw new Error("script store is full");
    objectScripts.push(definition);
  },
  ObjectScriptManager: {
    registerScript: (d: { id: string }) => manager.registered.push(d.id),
    mountScript: async (id: string) => {
      manager.mounted.push(id);
    },
    isScriptMounted: (id: string) => manager.mounted.includes(id),
  },
}));

import {
  registerButtonControlProvider,
  resetButtonControlProvider,
} from "@api/buttonControlService";
import type { CreateButtonControlRequest } from "@api/buttonControlService";
import { saveAsButtonScript, saveAsInlineButton } from "../lib/buttonScript";

const created: CreateButtonControlRequest[] = [];
const removed: Array<{ sheetIndex: number; row: number; col: number }> = [];

function installProvider(): void {
  registerButtonControlProvider({
    async createButton(request) {
      created.push(request);
      return {
        // Deliberately NOT the format the recorder used to hard-code: the whole
        // point is that the id comes from the owner, whatever it looks like.
        instanceId: `control-${request.sheetIndex}-${request.row}-${request.col}`,
        sheetIndex: request.sheetIndex,
        row: request.row,
        col: request.col,
        x: 0,
        y: 0,
        width: 80,
        height: 28,
      };
    },
    async removeButton(anchor) {
      removed.push(anchor);
    },
  });
}

beforeEach(() => {
  objectScripts.length = 0;
  created.length = 0;
  removed.length = 0;
  manager.registered.length = 0;
  manager.mounted.length = 0;
  resetButtonControlProvider();
});

describe("saveAsButtonScript", () => {
  it("REFUSES loudly when the Controls extension is not loaded", async () => {
    await expect(
      saveAsButtonScript({
        name: "Macro1245",
        source: "function setup(button) {}",
        sheetIndex: 0,
        row: 2,
        col: 3,
      }),
    ).rejects.toThrow(/Controls extension/);
    // Nothing half-made: no script stored for a button that does not exist.
    expect(objectScripts).toEqual([]);
  });

  it("asks the seam for the button instead of writing control metadata", async () => {
    installProvider();
    await saveAsButtonScript({
      name: "Macro1245",
      source: "function setup(button) {}",
      sheetIndex: 1,
      row: 4,
      col: 2,
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      sheetIndex: 1,
      row: 4,
      col: 2,
      label: "Macro1245",
    });
  });

  it("leaves onSelect empty so the click cannot run the macro twice", async () => {
    installProvider();
    await saveAsButtonScript({
      name: "Macro1245",
      source: "function setup(button) {}",
      sheetIndex: 0,
      row: 0,
      col: 0,
    });
    expect(created[0].onSelect ?? "").toBe("");
  });

  it("binds the object script to the instanceId the SEAM returned", async () => {
    installProvider();
    const result = await saveAsButtonScript({
      name: "Macro1245",
      source: "function setup(button) {}",
      sheetIndex: 1,
      row: 4,
      col: 2,
    });

    expect(result.instanceId).toBe("control-1-4-2");
    expect(objectScripts).toHaveLength(1);
    expect(objectScripts[0]).toMatchObject({
      objectType: "button",
      instanceId: "control-1-4-2",
      accessLevel: "unlocked",
      id: "macro-control-1-4-2",
    });
  });

  it("mounts the script so the very next click runs it", async () => {
    installProvider();
    const result = await saveAsButtonScript({
      name: "Macro1245",
      source: "function setup(button) {}",
      sheetIndex: 0,
      row: 1,
      col: 1,
    });
    expect(manager.registered).toEqual(["macro-control-0-1-1"]);
    expect(manager.mounted).toEqual(["macro-control-0-1-1"]);
    expect(result.mounted).toBe(true);
  });

  it("rolls the button back when the script cannot be stored", async () => {
    installProvider();
    await expect(
      saveAsButtonScript({
        name: "Macro1245",
        source: "function setup(button) {}",
        sheetIndex: 0,
        row: 9,
        col: 9,
      }),
    ).rejects.toThrow(/script store is full/);

    // A dead button is worse than an error.
    expect(removed).toEqual([{ sheetIndex: 0, row: 9, col: 9 }]);
  });
});

describe("saveAsInlineButton", () => {
  it("REFUSES loudly when the Controls extension is not loaded", async () => {
    await expect(
      saveAsInlineButton({
        name: "Macro1245",
        source: "Calcula.setCellValue(0,0,'x')",
        sheetIndex: 0,
        row: 0,
        col: 0,
      }),
    ).rejects.toThrow(/Controls extension/);
  });

  it("binds QuickJS source to the control's own onSelect and mounts nothing", async () => {
    installProvider();
    const result = await saveAsInlineButton({
      name: "Macro1245",
      source: "Calcula.setCellValue(0,0,'x')",
      sheetIndex: 0,
      row: 3,
      col: 3,
    });

    expect(result.instanceId).toBe("control-0-3-3");
    expect(created[0].onSelect).toBe("Calcula.setCellValue(0,0,'x')");
    // No object script: this runtime does not need one.
    expect(objectScripts).toEqual([]);
    expect(manager.mounted).toEqual([]);
  });
});
