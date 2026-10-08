//! FILENAME: app/extensions/CanvasSheet/__tests__/objectsLockWiring.test.ts
// PURPOSE: The canvas's activate() installs the Lock Objects notice: with the
//          real extension active on a canvas whose Lock Objects is on, a frame
//          press that drags is told why, once; after deactivate nothing is
//          listening. The notice's own rules are objectsLock.test.ts; this pins
//          that the extension wires it (the gripMenuWiring precedent).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SheetsResult } from "@api";

const getSheets = vi.fn<() => Promise<SheetsResult>>();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));
vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: vi.fn(async () => []),
}));
let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));
const toasts: string[] = [];
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string) => toasts.push(message),
}));

import { defaultCanvasLayout } from "@api/canvasSheet";
import { getCanvasSheetSnapshot, refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import { OBJECTS_LOCKED_NOTE, resetObjectsLockedNotice } from "../lib/objectsLock";

const CANVAS = 1;
let area: HTMLDivElement;

beforeEach(() => {
  resetCanvasSheetStore();
  resetObjectsLockedNotice();
  toasts.length = 0;
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS }, zoom: 1 };
  getSheets.mockResolvedValue({
    activeIndex: CANVAS,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      {
        index: CANVAS,
        name: "Page",
        visibility: "visible",
        sheetId: "cv-1",
        kind: "canvas",
        canvasLayout: { ...defaultCanvasLayout(), objectsLocked: true },
      },
    ],
  } as SheetsResult);
  area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  document.body.appendChild(area);
});

afterEach(() => {
  area.remove();
});

function dragAttempt(): void {
  window.dispatchEvent(
    new CustomEvent("floatingObject:selected", { detail: { zone: "frame", canvasX: 100, canvasY: 100 } }),
  );
  area.dispatchEvent(new MouseEvent("mousemove", { clientX: 160, clientY: 140, buttons: 1, bubbles: true }));
  area.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

describe("the canvas extension's Lock Objects wiring", () => {
  it("activate() installs the drag notice; deactivate() removes it", async () => {
    const { default: extension } = await import("../index");
    extension.activate({} as never);
    let active = true;
    try {
      await vi.waitFor(() => expect(getCanvasSheetSnapshot().active?.layout.objectsLocked).toBe(true));
      dragAttempt();
      expect(toasts).toEqual([OBJECTS_LOCKED_NOTE]);
      extension.deactivate?.();
      active = false;
      // Deactivate empties the store; put the locked page back so only the
      // LISTENER's absence can keep the second attempt silent.
      await refreshCanvasSheets();
      expect(getCanvasSheetSnapshot().active?.layout.objectsLocked).toBe(true);
      resetObjectsLockedNotice();
      dragAttempt();
      expect(toasts).toHaveLength(1);
    } finally {
      if (active) extension.deactivate?.();
    }
  });
});
