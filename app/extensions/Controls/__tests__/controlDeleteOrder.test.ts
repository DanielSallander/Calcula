//! FILENAME: app/extensions/Controls/__tests__/controlDeleteOrder.test.ts
// PURPOSE: Wave-B B6 -- a floating control's delete asks the BACKEND first.
//          `deleteFloatingControl` used to delete the object script and clear
//          the side tables before `remove_control_metadata`, so a refused
//          delete (a sheet protecting its objects) left the control standing
//          with its script gone. The order now lives in
//          `lib/controlDelete.ts` and is proved by running it; the extension's
//          delete is pinned to that helper by its source -- by POSITION: nothing
//          before or after the helper call, every teardown inside its step
//          (a check that only asked whether the calls appeared ANYWHERE in the
//          body stayed green with the script deleted before the helper again).

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { runFloatingControlDelete, type FloatingControlDeleteSteps } from "../lib/controlDelete";

function steps(removeMetadata: () => Promise<unknown>) {
  const order: string[] = [];
  const s: FloatingControlDeleteSteps = {
    removeMetadata: vi.fn(async () => {
      order.push("backend");
      return removeMetadata();
    }),
    deleteScripts: vi.fn(async () => {
      order.push("scripts");
    }),
    clearSideTables: vi.fn(() => {
      order.push("sideTables");
    }),
    finish: vi.fn(() => {
      order.push("finish");
    }),
  };
  return { s, order };
}

describe("runFloatingControlDelete", () => {
  it("removes the backend metadata BEFORE the scripts and side tables", async () => {
    const { s, order } = steps(async () => true);
    await runFloatingControlDelete(s);
    expect(order).toEqual(["backend", "scripts", "sideTables", "finish"]);
  });

  it("a REFUSED delete rejects and leaves the scripts, side tables and store alone", async () => {
    const { s, order } = steps(async () => {
      throw "Cannot delete a control on a protected sheet.";
    });
    await expect(runFloatingControlDelete(s)).rejects.toBe("Cannot delete a control on a protected sheet.");
    expect(order).toEqual(["backend"]);
    expect(s.deleteScripts).not.toHaveBeenCalled();
    expect(s.clearSideTables).not.toHaveBeenCalled();
    expect(s.finish).not.toHaveBeenCalled();
  });

  it("a control the backend did not have is still torn down locally (a ghost)", async () => {
    const { s, order } = steps(async () => false);
    await runFloatingControlDelete(s);
    expect(order).toEqual(["backend", "scripts", "sideTables", "finish"]);
  });

  it("a script cleanup that fails does not stop the rest of the teardown", async () => {
    const { s, order } = steps(async () => true);
    s.deleteScripts = vi.fn(async () => {
      throw new Error("no script");
    });
    await runFloatingControlDelete(s);
    expect(order).toEqual(["backend", "sideTables", "finish"]);
  });
});

describe("the extension's delete goes through the ordered helper", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("async function deleteFloatingControl(");
  const end = src.indexOf("\n}\n", start);
  // The function's CODE: its comments stripped, so prose that names a call
  // (this function's own comments name several) can neither satisfy nor trip
  // the check.
  const body = src
    .slice(src.indexOf("{", start) + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  /** Index of the `)` that closes the `(` at `open`. */
  function closingParen(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) return i;
    }
    return -1;
  }

  /** Every name called in `text` (`name(`), keywords left out. */
  function calledNames(text: string): string[] {
    const keywords = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "async"]);
    return [...text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]).filter((n) => !keywords.has(n));
  }

  // Everything that hangs off a control, by the step that must own it.
  const TEARDOWN: Record<string, string[]> = {
    deleteScripts: ["deleteObjectScriptsForInstance"],
    clearSideTables: ["clearDeclaredProperties", "removeCustomCanvasRenderer", "removeShapeHtmlOverlay", "unmarkShapeHasScript"],
    finish: [
      "removeFloatingControl",
      "deselectFloatingControl",
      "invalidateFloatingButtonCache",
      "invalidateShapeCache",
      "forgetImageControl",
    ],
  };

  const call = body.indexOf("runFloatingControlDelete(");
  const open = call + "runFloatingControlDelete".length;
  const close = closingParen(body, open);
  const helperArgs = body.slice(open, close + 1);

  /** The text of one step inside the helper's argument, up to the next step. */
  function step(name: string): string {
    const steps = ["removeMetadata", "deleteScripts", "clearSideTables", "finish"]
      .map((s) => ({ s, at: helperArgs.indexOf(`${s}:`) }))
      .sort((a, b) => a.at - b.at);
    const i = steps.findIndex((x) => x.s === name);
    expect(steps[i].at, `no ${name} step`).toBeGreaterThan(-1);
    return helperArgs.slice(steps[i].at, i + 1 < steps.length ? steps[i + 1].at : undefined);
  }

  it("does nothing before the ordered helper and nothing after it", () => {
    expect(start, "deleteFloatingControl not found").toBeGreaterThan(-1);
    expect(call, "deleteFloatingControl no longer calls runFloatingControlDelete").toBeGreaterThan(-1);
    expect(close, "the helper call does not close").toBeGreaterThan(call);
    // Before the helper: the control is looked up and the backend API is
    // imported -- nothing that touches the control. A teardown moved in front
    // of the helper runs even when the backend then REFUSES the delete (B6).
    const before = [...new Set(calledNames(body.slice(0, call)))].sort();
    expect(before, "deleteFloatingControl does something before the backend removal").toEqual(
      ["getFloatingControl", "import"],
    );
    // After the helper call: nothing (a teardown here would run after a
    // refusal too, since the rejection surfaces from the awaited helper only
    // if nobody catches it on the way).
    expect(body.slice(close + 1).replace(/[\s;]/g, ""), "deleteFloatingControl does something after the helper").toBe("");
  });

  it("runs every teardown inside its own step, and the backend removal first", () => {
    const removal = step("removeMetadata");
    expect(removal).toContain("removeControlMetadata(");
    for (const [owner, names] of Object.entries(TEARDOWN)) {
      const own = step(owner);
      for (const name of names) {
        expect(body.split(`${name}(`).length - 1, `${name} is called more than once, or not at all`).toBe(1);
        expect(own, `${name} is not inside the ${owner} step`).toContain(`${name}(`);
        expect(removal, `${name} runs inside the backend removal step`).not.toContain(`${name}(`);
      }
    }
  });

  it("the Delete key reports a refusal instead of dropping it", () => {
    const s = src.indexOf("async function deleteSelectedControls(");
    const e = src.indexOf("\n}\n", s);
    const del = src.slice(s, e);
    expect(del).toMatch(/catch \(err\)[\s\S]*showToast\(/);
  });
});
