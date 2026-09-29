//! FILENAME: app/extensions/Review/handlers/__tests__/reviewSelectionOwner.test.ts
// PURPOSE: The comment/note doors that act on Core's ACTIVE cell -- Review >
//          New Comment / New Note and the review.newComment / review.newNote
//          commands (Ctrl+Alt+M / Shift+F2) -- refuse with ONE toast and add
//          nothing while a selection owner holds the selection; they work when
//          nothing does.
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). With a floating grid's cell
//          selected, Core's active cell is HIDDEN under the floating grid, and
//          New Comment put a comment on THAT cell. TEST owner
//          (@api/selectionOwner). The grid context menu is not a door here: it
//          acts on the cell the user right-clicked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  addComment: vi.fn(async () => ({ success: false })),
  addNote: vi.fn(async () => ({ success: false })),
  getComment: vi.fn(async () => null),
  getNote: vi.fn(async () => null),
  menuItems: [] as { id: string; action?: () => unknown }[],
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  addComment: (...a: unknown[]) => h.addComment(...(a as [])),
  addNote: (...a: unknown[]) => h.addNote(...(a as [])),
  getComment: (...a: unknown[]) => h.getComment(...(a as [])),
  getNote: (...a: unknown[]) => h.getNote(...(a as [])),
  showOverlay: vi.fn(),
  registerMenuItem: (_menu: string, item: { id: string; action?: () => unknown }) => {
    h.menuItems.push(item);
  },
}));
vi.mock("../../lib/annotationStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/annotationStore")>()),
  refreshAnnotationState: vi.fn(async () => {}),
}));

import { registerReviewMenuItems, setCurrentSelectionForMenu } from "../reviewMenuBuilder";
import { registerReviewCommands, setActiveCellForKeyboard } from "../keyboardHandler";
import { CommandRegistry } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let unregisterCommands: () => void = () => {};

registerReviewMenuItems();

function menuAction(id: string): () => unknown {
  const item = h.menuItems.find((i) => i.id === id);
  if (!item?.action) throw new Error(`no menu action ${id}`);
  return item.action;
}
function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}
function acted(): number {
  return (
    h.addComment.mock.calls.length +
    h.addNote.mock.calls.length +
    h.getComment.mock.calls.length +
    h.getNote.mock.calls.length
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  setCurrentSelectionForMenu({ row: 3, col: 1 });
  setActiveCellForKeyboard({ row: 3, col: 1 });
  unregisterCommands = registerReviewCommands({
    register: (id, fn) => CommandRegistry.register(id, fn),
    unregister: (id) => CommandRegistry.unregister(id),
  });
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
  unregisterCommands();
  setCurrentSelectionForMenu(null);
  setActiveCellForKeyboard(null);
});

const DOORS: [string, () => unknown][] = [
  ["Review > New Comment", () => menuAction("review:newComment")()],
  ["Review > New Note", () => menuAction("review:newNote")()],
  ["review.newComment (Ctrl+Alt+M)", () => CommandRegistry.execute("review.newComment")],
  ["review.newNote (Shift+F2)", () => CommandRegistry.execute("review.newNote")],
];

describe("comment/note doors while a selection owner holds the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: nothing added to (or read from) Core's hidden cell; one toast`, async () => {
      owns = true;
      await open();
      expect(acted(), `${label} acted on Core's hidden active cell`).toBe(0);
      expect(refusals().length).toBe(1);
    });
  }
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: acts on Core's active cell, no refusal`, async () => {
      await open();
      expect(acted()).toBeGreaterThan(0);
      expect(refusals()).toEqual([]);
    });
  }
});
