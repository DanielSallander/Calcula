//! FILENAME: app/extensions/Protection/lib/__tests__/cellProtectionSelectionOwner.test.ts
// PURPOSE: Review > Cell Protection... (the lock-cells dialog) refuses with ONE
//          toast and opens nothing while a selection owner holds the
//          selection; it opens the dialog when nothing does. Protect Sheet /
//          Protect Workbook are not refused (sheet- and workbook-level).
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). The dialog reads and writes the
//          Locked / Hidden flags of Core's selection -- HIDDEN under a floating
//          grid while that grid's cell is selected. TEST owner
//          (@api/selectionOwner).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  showDialog: vi.fn(),
  menus: [] as { id: string; items: { id: string; action?: () => unknown }[] }[],
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
}));
vi.mock("../protectionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../protectionStore")>()),
  isCurrentSheetProtected: () => false,
  isCurrentWorkbookProtected: () => false,
  currentSheetHasPassword: () => false,
}));

import { registerReviewMenu } from "../../handlers/reviewMenuBuilder";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

registerReviewMenu({
  ui: {
    menus: {
      register: (menu: { id: string; items: { id: string; action?: () => unknown }[] }) => {
        h.menus.push(menu);
      },
    },
  },
} as never);

function menuAction(id: string): () => unknown {
  const item = h.menus[h.menus.length - 1].items.find((i) => i.id === id);
  if (!item?.action) throw new Error(`no menu action ${id}`);
  return item.action;
}
function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

beforeEach(() => {
  h.showDialog.mockClear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
});

describe("Review > Cell Protection... while a selection owner holds the selection", () => {
  it("opens no dialog on Core's hidden selection; one toast", async () => {
    owns = true;
    await menuAction("review:cellProtection")();
    expect(h.showDialog).not.toHaveBeenCalled();
    expect(refusals().length).toBe(1);
  });

  it("Protect Sheet... is not a selection door: it still opens", async () => {
    owns = true;
    await menuAction("review:protectSheet")();
    expect(h.showDialog).toHaveBeenCalledWith("protect-sheet-dialog", {});
    expect(refusals()).toEqual([]);
  });
});

describe("positive control: nothing owns the selection", () => {
  it("Cell Protection... opens the dialog, no refusal", async () => {
    await menuAction("review:cellProtection")();
    expect(h.showDialog).toHaveBeenCalledWith("cell-protection-dialog", {});
    expect(refusals()).toEqual([]);
  });
});
