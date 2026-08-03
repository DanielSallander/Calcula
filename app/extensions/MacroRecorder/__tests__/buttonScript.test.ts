//! FILENAME: app/extensions/MacroRecorder/__tests__/buttonScript.test.ts
// PURPOSE: "Add a button that runs this macro" LINKS the button to the canonical
//          macro by id, through the Controls-owned seam — it does NOT copy the
//          macro's body onto the button.
// CONTEXT: The model is VBA's: a macro lives ONCE (a module script), and a button
//          references it. These tests pin the properties that make "link, not
//          copy" true and Facade-clean: the recorder must not build the control
//          itself, it must pass the macro id as `macroRef`, and it must NOT store
//          any per-button object script (the old copy-model artifact that
//          silently drifted from the macro).

import { describe, it, expect, beforeEach, vi } from "vitest";

// A macro-linked button stores NOTHING but the reference. If buttonScript ever
// reached for saveObjectScript again (the old copy path), this spy would catch
// it — the mock throws to make an accidental use loud.
const saveObjectScriptSpy = vi.fn(async () => {
  throw new Error("linkMacroButton must not store a per-button object script");
});
vi.mock("@api", () => ({
  saveObjectScript: saveObjectScriptSpy,
}));

import {
  registerButtonControlProvider,
  resetButtonControlProvider,
} from "@api/buttonControlService";
import type { CreateButtonControlRequest } from "@api/buttonControlService";
import { linkMacroButton } from "../lib/buttonScript";

const created: CreateButtonControlRequest[] = [];

function installProvider(): void {
  registerButtonControlProvider({
    async createButton(request) {
      created.push(request);
      return {
        // Deliberately NOT the format the recorder used to hard-code: the id
        // comes from the owner, whatever it looks like.
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
    async removeButton() {
      /* not used by the link model */
    },
  });
}

beforeEach(() => {
  created.length = 0;
  saveObjectScriptSpy.mockClear();
  resetButtonControlProvider();
});

describe("linkMacroButton", () => {
  it("REFUSES loudly when the Controls extension is not loaded", async () => {
    await expect(
      linkMacroButton({
        macroId: "macro-do-thing",
        name: "Do Thing",
        sheetIndex: 0,
        row: 2,
        col: 3,
      }),
    ).rejects.toThrow(/Controls extension/);
  });

  it("asks the seam for the button instead of writing control metadata", async () => {
    installProvider();
    await linkMacroButton({
      macroId: "macro-do-thing",
      name: "Do Thing",
      sheetIndex: 1,
      row: 4,
      col: 2,
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      sheetIndex: 1,
      row: 4,
      col: 2,
      label: "Do Thing",
    });
  });

  it("LINKS the button by passing the macro id as macroRef", async () => {
    installProvider();
    await linkMacroButton({
      macroId: "macro-do-thing",
      name: "Do Thing",
      sheetIndex: 0,
      row: 0,
      col: 0,
    });
    expect(created[0].macroRef).toBe("macro-do-thing");
  });

  it("leaves onSelect empty so the click cannot run the macro twice", async () => {
    installProvider();
    await linkMacroButton({
      macroId: "macro-do-thing",
      name: "Do Thing",
      sheetIndex: 0,
      row: 0,
      col: 0,
    });
    expect(created[0].onSelect ?? "").toBe("");
  });

  it("copies NO body: it never stores a per-button object script", async () => {
    installProvider();
    await linkMacroButton({
      macroId: "macro-do-thing",
      name: "Do Thing",
      sheetIndex: 1,
      row: 4,
      col: 2,
    });
    // The whole point of the link model: no second artifact to drift.
    expect(saveObjectScriptSpy).not.toHaveBeenCalled();
  });

  it("returns the instanceId the SEAM assigned", async () => {
    installProvider();
    const result = await linkMacroButton({
      macroId: "macro-do-thing",
      name: "Do Thing",
      sheetIndex: 1,
      row: 4,
      col: 2,
    });
    expect(result.instanceId).toBe("control-1-4-2");
  });
});
