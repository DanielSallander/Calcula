//! FILENAME: app/extensions/TestRunner/lib/suites/advancedNotes.ts
// PURPOSE: Advanced Notes test suite.
// CONTEXT: Tests update, move, resize, show all, indicators, and getNoteById.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_ADV_NOTES } from "../testArea";
import {
  addNote,
  updateNote,
  getNote,
  getNoteById,
  getNoteIndicators,
  getNoteIndicatorsInRange,
  resizeNote,
  showAllNotes,
  moveNote,
  clearAllNotes,
  clearNotesInRange,
} from "../../../../src/api";
import type { AddNoteParams } from "../../../../src/api";

const A = AREA_ADV_NOTES;

function makeNoteParams(row: number, col: number, content: string): AddNoteParams {
  return { row, col, authorName: "Test User", content };
}

export const advancedNotesSuite: TestSuite = {
  name: "Advanced Notes",
  description: "Tests note update, move, resize, visibility, and indicators.",

  afterEach: async (ctx) => {
    try { await clearNotesInRange(A.row, A.col, A.row + 10, A.col + 5); } catch { /* ignore */ }
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
      name: "Update note content",
      description: "updateNote changes the text of an existing note.",
      run: async (ctx) => {
        const addResult = await addNote(makeNoteParams(A.row, A.col, "Original note"));
        assertTrue(addResult.success, "add should succeed");
        const noteId = addResult.note!.id;

        const updateResult = await updateNote({
          noteId,
          content: "Updated note",
        });
        assertTrue(updateResult.success, "update should succeed");

        const updated = await getNoteById(noteId);
        expectNotNull(updated, "note should exist");
        assertEqual(updated!.content, "Updated note", "content should be updated");
      },
    },
    {
      name: "Move note to another cell",
      description: "moveNote relocates a note.",
      run: async (ctx) => {
        const addResult = await addNote(makeNoteParams(A.row, A.col, "Movable note"));
        const noteId = addResult.note!.id;

        const moveResult = await moveNote(noteId, A.row + 3, A.col + 1);
        assertTrue(moveResult.success, "move should succeed");

        const oldNote = await getNote(A.row, A.col);
        assertTrue(oldNote === null, "no note at old location");

        const newNote = await getNote(A.row + 3, A.col + 1);
        expectNotNull(newNote, "note at new location");
        assertEqual(newNote!.content, "Movable note", "content preserved");
      },
    },
    {
      name: "Resize note",
      description: "resizeNote changes dimensions.",
      run: async (ctx) => {
        const addResult = await addNote(makeNoteParams(A.row, A.col, "Resizable"));
        const noteId = addResult.note!.id;

        const resizeResult = await resizeNote({ noteId, width: 300, height: 200 });
        assertTrue(resizeResult.success, "resize should succeed");

        const note = await getNoteById(noteId);
        expectNotNull(note, "note should exist");
        assertEqual(note!.width, 300, "width should be 300");
        assertEqual(note!.height, 200, "height should be 200");
      },
    },
    {
      name: "Get note indicators",
      description: "getNoteIndicators returns markers for cells with notes.",
      run: async (ctx) => {
        await addNote(makeNoteParams(A.row, A.col, "N1"));
        await addNote(makeNoteParams(A.row + 1, A.col, "N2"));

        const indicators = await getNoteIndicators();
        const ours = indicators.filter(i => i.row >= A.row && i.row <= A.row + 1 && i.col === A.col);
        assertTrue(ours.length >= 2, `should have at least 2 indicators, got ${ours.length}`);
      },
    },
    {
      name: "Get note indicators in range",
      description: "getNoteIndicatorsInRange filters by viewport.",
      run: async (ctx) => {
        await addNote(makeNoteParams(A.row, A.col, "In range"));

        const indicators = await getNoteIndicatorsInRange(A.row, A.col, A.row + 5, A.col + 5);
        const ours = indicators.filter(i => i.row === A.row && i.col === A.col);
        assertTrue(ours.length >= 1, "should find our indicator");
      },
    },
    {
      name: "Show all notes",
      description: "showAllNotes toggles visibility of all notes.",
      run: async (ctx) => {
        await addNote(makeNoteParams(A.row, A.col, "N1"));
        await addNote(makeNoteParams(A.row + 1, A.col, "N2"));

        const count = await showAllNotes(true);
        assertTrue(count >= 2, `should show at least 2 notes, got ${count}`);

        const hideCount = await showAllNotes(false);
        assertTrue(hideCount >= 2, `should hide at least 2 notes, got ${hideCount}`);
      },
    },
    {
      name: "Clear all notes",
      description: "clearAllNotes removes every note on the sheet.",
      run: async (ctx) => {
        await addNote(makeNoteParams(A.row, A.col, "X"));
        await addNote(makeNoteParams(A.row + 1, A.col, "Y"));

        const cleared = await clearAllNotes();
        assertTrue(cleared >= 2, `should clear at least 2, cleared ${cleared}`);
      },
    },
  ],
};
