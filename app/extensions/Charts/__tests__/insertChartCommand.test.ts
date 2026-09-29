//! FILENAME: app/extensions/Charts/__tests__/insertChartCommand.test.ts
// PURPOSE: The Charts extension answers `insert.chart` -- the command F11 sends
//          through Core's keyboard -- by opening the SAME create dialog Insert >
//          Chart... opens, and takes the command back on deactivate.
// CONTEXT: Z9 (wave F; wave E core report NEW 1). F11 did nothing: Core
//          forwarded it to `charts.insertChart`, which nothing registered. Core
//          now only routes the neutral "insert.chart" (the census in
//          src/core/components/Spreadsheet/__tests__/coreCommandDoorsRegistered
//          .test.ts pins that every keyboard id is answered); the extension
//          that owns the dialog registers the command. The Insert menu's rule
//          (StandardMenus/InsertMenu.ts showCreateDialog): the dialog's source
//          defaults from Core's selection, and while a selection owner holds
//          the selection it opens with no prefill (`suppressAutoRange`).

import { describe, it, expect, vi } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => (cmd === "get_all_styles" ? [] : null)),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

const CHARTS: Loader = () => import("..");

describe("insert.chart (F11) -- the Charts extension's door", () => {
  it("opens the chart create dialog; with a selection owner, with no prefill; gone after deactivate", async () => {
    const { ext, context, ui } = await loadHarness(CHARTS);
    const { CommandRegistry } = await import("@api/commands");
    const { registerSelectionOwner } = await import("@api/selectionOwner");
    await ext.activate(context);
    await settle();
    const opened = vi.spyOn(ui.DialogExtensions, "openDialog").mockImplementation(() => {});

    expect(CommandRegistry.has("insert.chart"), "Charts did not register insert.chart: F11 does nothing").toBe(true);
    await CommandRegistry.execute("insert.chart");
    expect(opened.mock.calls, "insert.chart did not open the Insert > Chart dialog").toEqual([
      ["chart:createDialog", undefined],
    ]);

    // While a selection owner holds the selection (a floating grid's cell), the
    // selection under it is HIDDEN: no prefill, as the Insert menu does.
    opened.mockClear();
    const release = registerSelectionOwner({ id: "test-owner", label: "the test's cells", ownsSelection: () => true });
    try {
      await CommandRegistry.execute("insert.chart");
    } finally {
      release();
    }
    expect(opened.mock.calls).toEqual([["chart:createDialog", { suppressAutoRange: true }]]);

    await ext.deactivate?.();
    await settle();
    expect(CommandRegistry.has("insert.chart"), "insert.chart outlived the Charts extension").toBe(false);
  });
});
