//! FILENAME: app/extensions/Charts/lib/__tests__/chartJsonPaneReopen.test.ts
// PURPOSE: View > Show "Chart JSON" opens the pane (BUG filed by WP-C S9a: the
//          View menu dispatched `taskpane:requestReopen` for "chart-json" and
//          nothing answered). The helper answers exactly its own view id, and
//          the Charts entry wires it for the Chart JSON pane.

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { TASK_PANE_REOPEN_EVENT, installTaskPaneReopen } from "../chartJsonPaneReopen";

function request(viewId: string): void {
  window.dispatchEvent(new CustomEvent(TASK_PANE_REOPEN_EVENT, { detail: { viewId } }));
}

describe("taskpane:requestReopen for the Chart JSON pane", () => {
  it("opens on its own view id only, and stops after the uninstall", () => {
    const open = vi.fn();
    const off = installTaskPaneReopen("chart-json", open);
    request("pivot-editor");
    expect(open).not.toHaveBeenCalled();
    request("chart-json");
    expect(open).toHaveBeenCalledTimes(1);
    off();
    request("chart-json");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the Charts entry answers for CHART_JSON_PANE_ID (the View menu's dispatch has a listener)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
    expect(src).toContain("installTaskPaneReopen(CHART_JSON_PANE_ID, () => openTaskPane(CHART_JSON_PANE_ID))");
    // The ViewMenu side of the contract: it dispatches this very event name.
    const menu = fs.readFileSync(path.resolve(__dirname, "../../../BuiltIn/StandardMenus/ViewMenu.ts"), "utf8");
    expect(menu).toContain(`"${TASK_PANE_REOPEN_EVENT}"`);
  });
});
