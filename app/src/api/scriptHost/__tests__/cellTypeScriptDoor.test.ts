//! FILENAME: app/src/api/scriptHost/__tests__/cellTypeScriptDoor.test.ts
// PURPOSE: A SCRIPT may not arm a button cell (BUG-0260, the script door).
// CONTEXT: `range.setCellType` -- the two-tier handshake that lets a script put
//          an extension's cell type on its own target -- had no row in
//          `vSetState`, whose ladder ends in `return true`. A button cell's
//          params ARE an action, so a restricted (distributed) script could
//          leave the user a one-click button that runs the user's OWN macro,
//          unlocked, with a call of the script's choosing appended: the
//          confused deputy BUG-0260 closes at the package doors, through the
//          script door. And `heldAction` / `fromApplication` are the admission's
//          keys: what the next push publishes, and what the click trusts.

import { describe, it, expect } from "vitest";
import { ALLOWLIST } from "../allowlist";
import { SCRIPT_REFUSED_CELL_TYPE_PARAMS, checkRangeSetCellType, vSetState } from "../validators";

const setCellType = (typeId: unknown, params?: unknown) => vSetState(["range.setCellType", [typeId, params]]);

describe("range.setCellType through object.setState", () => {
  it("is validated by the object.setState row's validator", () => {
    expect(ALLOWLIST["object.setState"].validate).toBe(vSetState);
  });

  // SABOTAGE: drop the `range.setCellType` row from vSetState -> `true`.
  it("refuses a button cell with an action -- a script may not arm a button", () => {
    const verdict = setCellType("calcula.button", {
      action: { kind: "script", scriptId: "macro-report", functionName: "Exfiltrate" },
    });
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("may not give a button cell an \"action\"");
    expect(setCellType("calcula.button", { action: { kind: "command", commandId: "format.bold" } })).not.toBe(true);
  });

  it("refuses the admission's own keys on any cell type", () => {
    for (const key of SCRIPT_REFUSED_CELL_TYPE_PARAMS) {
      for (const typeId of ["calcula.button", "calcula.progress", "vendor.rating"]) {
        const verdict = setCellType(typeId, { [key]: { kind: "script", scriptId: "x" } });
        expect(verdict, `${typeId} ${key}`).not.toBe(true);
        expect(String(verdict)).toContain(key);
      }
    }
    expect([...SCRIPT_REFUSED_CELL_TYPE_PARAMS].sort()).toEqual(["fromApplication", "heldAction"]);
  });

  it("still lets a script place a button without an action, and any other cell type", () => {
    expect(setCellType("calcula.button", { label: "Go" })).toBe(true);
    expect(setCellType("calcula.progress", { max: 100 })).toBe(true);
    expect(setCellType("calcula.checkbox", {})).toBe(true);
    expect(setCellType("calcula.checkbox")).toBe(true);
    // "action" is only executable on a button; another type's param of that name
    // is its own business.
    expect(setCellType("vendor.rating", { action: "stars" })).toBe(true);
  });

  it("refuses a malformed call rather than passing it through", () => {
    expect(checkRangeSetCellType([])).not.toBe(true);
    expect(checkRangeSetCellType(["calcula.button", ["action"]])).not.toBe(true);
  });
});
