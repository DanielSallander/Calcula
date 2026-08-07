//! FILENAME: app/src/api/__tests__/refreshAnnouncements.test.ts
// PURPOSE: Lock the "every mutation route announces" property for the four
//          backend-state caches that had no refresh path — outline (grouping),
//          hyperlinks, data validations and annotations.
// CONTEXT: These events are emitted by the IPC WRAPPER, never by call sites.
//          That placement is the whole fix: a refresh event wired to one caller
//          is how the ribbon path stayed correct while the script path silently
//          left the cache — and therefore the painted grid — describing a
//          document that no longer existed. Measured before the fix: group_rows
//          and add_hyperlink changed 0 pixels.
//
//          Testing the wrappers rather than the call sites is deliberate. A
//          test per call site would pass and still miss the next caller; a test
//          on the wrapper cannot be routed around, because there is no other
//          door to the command.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { AppEvents } from "../events";
import {
  addHyperlink,
  updateHyperlink,
  removeHyperlink,
  moveHyperlink,
  setOutlineSettings,
} from "../backend";
import {
  groupRows,
  ungroupRows,
  groupColumns,
  ungroupColumns,
  collapseRowGroup,
  expandRowGroup,
  collapseColumnGroup,
  expandColumnGroup,
  showOutlineLevel,
  clearOutline,
  setDataValidation,
  clearDataValidation,
  addComment,
  updateComment,
  deleteComment,
  resolveComment,
  addReply,
  updateReply,
  deleteReply,
  moveComment,
  addNote,
  updateNote,
  deleteNote,
  resizeNote,
  toggleNoteVisibility,
  moveNote,
  convertNoteToComment,
  clearAllComments,
  clearAllNotes,
  clearCommentsInRange,
  clearNotesInRange,
  showAllNotes,
  clearHyperlinksInRange,
} from "../../core/lib/tauri-api";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Every app: event the window saw during one call. */
let seen: string[] = [];
let listener: (e: Event) => void;

const WATCHED = [
  AppEvents.OUTLINE_CHANGED,
  AppEvents.HYPERLINKS_CHANGED,
  AppEvents.VALIDATIONS_CHANGED,
  AppEvents.ANNOTATIONS_CHANGED,
];

beforeEach(() => {
  seen = [];
  listener = (e: Event) => seen.push(e.type);
  for (const evt of WATCHED) window.addEventListener(evt, listener);
  invokeMock.mockReset();
});

afterEach(() => {
  for (const evt of WATCHED) window.removeEventListener(evt, listener);
});

/** Run one wrapper against a canned backend answer and report what it announced. */
async function announcementsFor(
  backendAnswer: unknown,
  run: () => Promise<unknown>,
): Promise<string[]> {
  invokeMock.mockResolvedValue(backendAnswer);
  await run();
  return seen;
}

const OK_GROUP = { success: true, hiddenRowsChanged: [], hiddenColsChanged: [] };
const FAILED_GROUP = { success: false, error: "nope", hiddenRowsChanged: [], hiddenColsChanged: [] };

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

describe("outline mutations announce OUTLINE_CHANGED", () => {
  const mutators: Array<[string, () => Promise<unknown>]> = [
    ["groupRows", () => groupRows(0, 4)],
    ["ungroupRows", () => ungroupRows(0, 4)],
    ["groupColumns", () => groupColumns(0, 4)],
    ["ungroupColumns", () => ungroupColumns(0, 4)],
    ["collapseRowGroup", () => collapseRowGroup(4)],
    ["expandRowGroup", () => expandRowGroup(4)],
    ["collapseColumnGroup", () => collapseColumnGroup(4)],
    ["expandColumnGroup", () => expandColumnGroup(4)],
    ["showOutlineLevel", () => showOutlineLevel(1, undefined)],
    ["clearOutline", () => clearOutline()],
  ];

  it.each(mutators)("%s announces exactly once", async (_name, run) => {
    expect(await announcementsFor(OK_GROUP, run)).toEqual([AppEvents.OUTLINE_CHANGED]);
  });

  it.each(mutators)("%s stays silent when the backend refused", async (_name, run) => {
    expect(await announcementsFor(FAILED_GROUP, run)).toEqual([]);
  });

  it("setOutlineSettings announces too (summary position moves every bracket)", async () => {
    expect(
      await announcementsFor(OK_GROUP, () =>
        setOutlineSettings({
          summaryRowPosition: "aboveLeft",
          summaryColPosition: "belowRight",
          showOutlineSymbols: true,
          autoStyles: false,
        }),
      ),
    ).toEqual([AppEvents.OUTLINE_CHANGED]);
  });
});

// ---------------------------------------------------------------------------
// Hyperlinks
// ---------------------------------------------------------------------------

describe("hyperlink mutations announce HYPERLINKS_CHANGED", () => {
  const link = { row: 0, col: 0, target: "https://example.com" };
  const OK_LINK = { success: true, hyperlink: link };
  const FAILED_LINK = { success: false, error: "nope" };

  const mutators: Array<[string, () => Promise<unknown>]> = [
    ["addHyperlink", () => addHyperlink({ row: 0, col: 0, linkType: "url", target: "https://example.com" })],
    ["updateHyperlink", () => updateHyperlink({ row: 0, col: 0, target: "https://example.org" })],
    ["removeHyperlink", () => removeHyperlink(0, 0)],
    ["moveHyperlink", () => moveHyperlink(0, 0, 1, 1)],
  ];

  it.each(mutators)("%s announces exactly once", async (_name, run) => {
    expect(await announcementsFor(OK_LINK, run)).toEqual([AppEvents.HYPERLINKS_CHANGED]);
  });

  it.each(mutators)("%s stays silent when the backend refused", async (_name, run) => {
    expect(await announcementsFor(FAILED_LINK, run)).toEqual([]);
  });

  it("clearHyperlinksInRange announces only when it removed something", async () => {
    expect(await announcementsFor(3, () => clearHyperlinksInRange(0, 0, 9, 9))).toEqual([
      AppEvents.HYPERLINKS_CHANGED,
    ]);
    seen = [];
    expect(await announcementsFor(0, () => clearHyperlinksInRange(0, 0, 9, 9))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Data validation
// ---------------------------------------------------------------------------

describe("validation mutations announce VALIDATIONS_CHANGED", () => {
  const rule = {
    rule: { list: { source: "a,b", inCellDropdown: true } },
    ignoreBlanks: true,
    prompt: { showPrompt: false, title: "", message: "" },
    errorAlert: { showAlert: true, style: "stop", title: "", message: "" },
  } as never;

  it("setDataValidation announces exactly once", async () => {
    expect(
      await announcementsFor({ success: true, validation: null, error: null }, () =>
        setDataValidation(0, 0, 4, 0, rule),
      ),
    ).toEqual([AppEvents.VALIDATIONS_CHANGED]);
  });

  it("clearDataValidation announces exactly once", async () => {
    expect(
      await announcementsFor({ success: true, validation: null, error: null }, () =>
        clearDataValidation(0, 0, 4, 0),
      ),
    ).toEqual([AppEvents.VALIDATIONS_CHANGED]);
  });

  it("stays silent when the backend refused", async () => {
    expect(
      await announcementsFor({ success: false, validation: null, error: "nope" }, () =>
        setDataValidation(0, 0, 4, 0, rule),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

describe("annotation mutations announce ANNOTATIONS_CHANGED", () => {
  const OK_COMMENT = { success: true, comment: { id: "c1" }, error: null };
  const OK_REPLY = { success: true, reply: { id: "r1" }, comment: { id: "c1" }, error: null };
  const OK_NOTE = { success: true, note: { id: "n1" }, error: null };

  const resultMutators: Array<[string, unknown, () => Promise<unknown>]> = [
    ["addComment", OK_COMMENT, () => addComment({ row: 0, col: 0, authorEmail: "", authorName: "a", content: "x" } as never)],
    ["updateComment", OK_COMMENT, () => updateComment({ commentId: "c1", content: "y" } as never)],
    ["deleteComment", OK_COMMENT, () => deleteComment("c1")],
    ["resolveComment", OK_COMMENT, () => resolveComment("c1", true)],
    ["moveComment", OK_COMMENT, () => moveComment("c1", 2, 2)],
    ["addReply", OK_REPLY, () => addReply({ commentId: "c1", authorEmail: "", authorName: "a", content: "x" } as never)],
    ["updateReply", OK_REPLY, () => updateReply({ commentId: "c1", replyId: "r1", content: "y" } as never)],
    ["deleteReply", OK_REPLY, () => deleteReply("c1", "r1")],
    ["addNote", OK_NOTE, () => addNote({ row: 0, col: 0, authorName: "a", content: "x" } as never)],
    ["updateNote", OK_NOTE, () => updateNote({ noteId: "n1", content: "y" } as never)],
    ["deleteNote", OK_NOTE, () => deleteNote("n1")],
    ["resizeNote", OK_NOTE, () => resizeNote({ noteId: "n1", width: 10, height: 10 } as never)],
    ["toggleNoteVisibility", OK_NOTE, () => toggleNoteVisibility("n1", true)],
    ["moveNote", OK_NOTE, () => moveNote("n1", 2, 2)],
    ["convertNoteToComment", OK_COMMENT, () => convertNoteToComment("n1", "a@b.c")],
  ];

  it.each(resultMutators)("%s announces exactly once", async (_name, ok, run) => {
    expect(await announcementsFor(ok, run)).toEqual([AppEvents.ANNOTATIONS_CHANGED]);
  });

  it.each(resultMutators)("%s stays silent when the backend refused", async (_name, _ok, run) => {
    expect(await announcementsFor({ success: false, error: "nope" }, run)).toEqual([]);
  });

  const countMutators: Array<[string, () => Promise<unknown>]> = [
    ["clearAllComments", () => clearAllComments()],
    ["clearAllNotes", () => clearAllNotes()],
    ["clearCommentsInRange", () => clearCommentsInRange(0, 0, 9, 9)],
    ["clearNotesInRange", () => clearNotesInRange(0, 0, 9, 9)],
    ["showAllNotes", () => showAllNotes(true)],
  ];

  it.each(countMutators)("%s announces when it changed something", async (_name, run) => {
    expect(await announcementsFor(2, run)).toEqual([AppEvents.ANNOTATIONS_CHANGED]);
  });

  it.each(countMutators)("%s stays silent when it changed nothing", async (_name, run) => {
    expect(await announcementsFor(0, run)).toEqual([]);
  });
});
