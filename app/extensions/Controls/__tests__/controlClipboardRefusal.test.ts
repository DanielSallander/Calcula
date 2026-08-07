//! FILENAME: app/extensions/Controls/__tests__/controlClipboardRefusal.test.ts
// PURPOSE: A control copy that the backend REFUSES must say so, and must not
//          leave a control behind that only half exists.
// CONTEXT: `set_control_metadata` now bounds every property at
//          MAX_CONTROL_PROPERTY_CHARS (64 KiB) — the mechanical half of closing
//          the `object.setState` / `vSetState` hole. That bound made a refusal
//          REACHABLE on a path that had never had one:
//
//            a control from the LEGACY corpus whose inline image this build
//            could not migrate (an SVG the old picker accepted) still carries
//            its whole picture in `src`. It renders, so a user copying it is
//            doing something reasonable — it simply cannot be written back.
//
//          Both callers (the Ctrl+V / Ctrl+D keydown handler and the context
//          menu) invoke the clipboard from an async handler whose promise
//          nobody awaits, so before this the refusal was an unhandled rejection:
//          the user pressed Ctrl+V and nothing happened, with no reason given.
//
//          The second assertion is the one that would bite hardest if it broke:
//          the floating-store entry must NOT be added when the backend write
//          failed. A floating control with no backend metadata paints until the
//          next reload and then silently vanishes.

import { describe, it, expect, beforeEach, vi } from "vitest";

const toasts: Array<{ message: string; type?: string }> = [];
const setControlMetadata = vi.fn();
const addFloatingControl = vi.fn();
const selectFloatingControl = vi.fn();
const syncFloatingControlRegions = vi.fn();
const getAllControls = vi.fn();
const getControlMetadata = vi.fn();

vi.mock("@api/notifications", () => ({
  showToast: (message: string, options?: { type?: string }) => {
    toasts.push({ message, type: options?.type });
  },
}));

vi.mock("../lib/controlApi", () => ({
  setControlMetadata: (...args: unknown[]) => setControlMetadata(...args),
  getControlMetadata: (...args: unknown[]) => getControlMetadata(...args),
  getAllControls: (...args: unknown[]) => getAllControls(...args),
}));

vi.mock("../lib/floatingStore", () => ({
  getFloatingControl: (id: string) =>
    id === "ctrl-1"
      ? { id, sheetIndex: 0, row: 1, col: 1, x: 10, y: 10, width: 80, height: 24 }
      : null,
  addFloatingControl: (...args: unknown[]) => addFloatingControl(...args),
  makeFloatingControlId: (s: number, r: number, c: number) => `floating-${s}-${r}-${c}`,
  syncFloatingControlRegions: () => syncFloatingControlRegions(),
}));

vi.mock("../Button/floatingSelection", () => ({
  selectFloatingControl: (...args: unknown[]) => selectFloatingControl(...args),
}));

vi.mock("../Button/floatingRenderer", () => ({ invalidateFloatingButtonCache: vi.fn() }));
vi.mock("../Shape/shapeRenderer", () => ({ invalidateShapeCache: vi.fn() }));
vi.mock("../Image/imageRenderer", () => ({ invalidateImageCache: vi.fn() }));
// Spread the real module: `AppEvents` is re-read by unrelated modules that get
// pulled in transitively, and blanking it breaks them rather than this test.
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

import { copyControl, pasteControl } from "../lib/controlClipboard";

/** A legacy control this build could not migrate: the picture is still inline. */
const LEGACY_INLINE = {
  controlType: "image",
  properties: {
    src: {
      valueType: "static",
      value: `data:image/svg+xml;base64,${"A".repeat(100_000)}`,
    },
    x: { valueType: "static", value: "10" },
    y: { valueType: "static", value: "10" },
  },
};

beforeEach(() => {
  toasts.length = 0;
  setControlMetadata.mockReset();
  addFloatingControl.mockReset();
  selectFloatingControl.mockReset();
  syncFloatingControlRegions.mockReset();
  getAllControls.mockReset().mockResolvedValue([]);
  getControlMetadata.mockReset().mockResolvedValue(LEGACY_INLINE);
});

describe("a refused control copy is visible, not silent", () => {
  it("shows the backend's own reason instead of rejecting into nobody's hands", async () => {
    setControlMetadata.mockRejectedValue(
      new Error(
        "Control property 'src' is 100013 characters; the limit is 65536. " +
          "Large binary content belongs in the document's media store " +
          "(read_media_file), referenced by a media: handle.",
      ),
    );

    await copyControl("ctrl-1");
    // Must not reject: both callers invoke this unawaited.
    await expect(pasteControl(0)).resolves.toBeUndefined();

    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe("error");
    // The host's message travels verbatim — it names the rule AND the number.
    expect(toasts[0].message).toContain("the limit is 65536");
    expect(toasts[0].message).toContain("media: handle");
  });

  it("creates no floating control when the backend write failed", async () => {
    setControlMetadata.mockRejectedValue(new Error("refused"));

    await copyControl("ctrl-1");
    await pasteControl(0);

    expect(addFloatingControl).not.toHaveBeenCalled();
    expect(selectFloatingControl).not.toHaveBeenCalled();
  });

  it("still places the control, and stays silent, when the backend accepts", async () => {
    getControlMetadata.mockResolvedValue({
      controlType: "image",
      properties: {
        // The migrated shape: a ~70-character handle, nowhere near any bound.
        src: { valueType: "static", value: `media:${"a".repeat(64)}` },
        x: { valueType: "static", value: "10" },
        y: { valueType: "static", value: "10" },
      },
    });
    setControlMetadata.mockResolvedValue(undefined);

    await copyControl("ctrl-1");
    await pasteControl(0);

    expect(toasts).toHaveLength(0);
    expect(addFloatingControl).toHaveBeenCalledTimes(1);
  });
});
