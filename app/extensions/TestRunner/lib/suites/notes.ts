//! FILENAME: app/extensions/TestRunner/lib/suites/notes.ts
// PURPOSE: Notes test suite.
// CONTEXT: Tests adding, retrieving, deleting, and converting notes.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_NOTES } from "../testArea";
import {
  addNote,
  getNote,
  deleteNote,
  hasNote,
  clearNotesInRange,
  convertNoteToComment,
  getComment,
} from "@api";
import type { AddNoteParams } from "@api";

const A = AREA_NOTES;

function makeNoteParams(row: number, col: number, content: string): AddNoteParams {
  return {
    row,
    col,
    authorName: "Test User",
    content,
  };
}

export const notesSuite: TestSuite = {
  name: "Notes",
  description: "Tests note CRUD and conversion to comment.",

  afterEach: async (ctx) => {
    try {
      await clearNotesInRange(A.row, A.col, A.row + 10, A.col + 5);
    } catch { /* ignore */ }
    // Also clean up any comments created by conversion tests
    try {
      const { clearCommentsInRange: clearComments } = await import("../../../../src/api");
      await clearComments(A.row, A.col, A.row + 10, A.col + 5);
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Add and retrieve note",
      description: "addNote creates, getNote retrieves it.",
      run: async (ctx) => {
        const result = await addNote(makeNoteParams(A.row, A.col, "My note"));
        assertTrue(result.success, "addNote should succeed");
        expectNotNull(result.note, "note should be returned");

        const retrieved = await getNote(A.row, A.col);
        expectNotNull(retrieved, "getNote should return the note");
        assertEqual(retrieved!.content, "My note", "content matches");
      },
    },
    {
      name: "hasNote returns true/false",
      description: "True when note exists, false when not.",
      run: async (ctx) => {
        const before = await hasNote(A.row, A.col);
        assertTrue(!before, "should be false before adding");

        await addNote(makeNoteParams(A.row, A.col, "exists"));
        await ctx.settle();

        const after = await hasNote(A.row, A.col);
        assertTrue(after, "should be true after adding");
      },
    },
    {
      name: "Delete note",
      description: "Note removed after delete.",
      run: async (ctx) => {
        const result = await addNote(makeNoteParams(A.row, A.col, "to delete"));
        const noteId = result.note!.id;

        const delResult = await deleteNote(noteId);
        assertTrue(delResult.success, "delete should succeed");

        const check = await getNote(A.row, A.col);
        assertTrue(check === null, "note should be gone after delete");
      },
    },
    {
      name: "Clear notes in range",
      description: "clearNotesInRange removes all notes in area.",
      run: async (ctx) => {
        await addNote(makeNoteParams(A.row, A.col, "n1"));
        await addNote(makeNoteParams(A.row + 1, A.col, "n2"));

        const cleared = await clearNotesInRange(A.row, A.col, A.row + 1, A.col);
        assertTrue(cleared >= 2, `Should clear at least 2, cleared ${cleared}`);

        const check = await hasNote(A.row, A.col);
        assertTrue(!check, "no note after clear");
      },
    },
    {
      name: "Convert note to comment",
      description: "Note becomes a comment at the same cell.",
      run: async (ctx) => {
        const result = await addNote(makeNoteParams(A.row, A.col, "convert me"));
        const noteId = result.note!.id;

        const converted = await convertNoteToComment(noteId, "test@calcula.dev");
        assertTrue(converted.success, "conversion should succeed");

        // Note should be gone
        const note = await getNote(A.row, A.col);
        assertTrue(note === null, "note should be removed after conversion");

        // Comment should exist
        const comment = await getComment(A.row, A.col);
        expectNotNull(comment, "comment should exist after conversion");
        assertEqual(comment!.content, "convert me", "content preserved");
      },
    },
  ],
};
