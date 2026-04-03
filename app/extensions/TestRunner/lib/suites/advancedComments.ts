//! FILENAME: app/extensions/TestRunner/lib/suites/advancedComments.ts
// PURPOSE: Advanced Comments test suite.
// CONTEXT: Tests update, delete reply, move, indicators, and getCommentsForSheet.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_ADV_COMMENTS } from "../testArea";
import {
  addComment,
  updateComment,
  getComment,
  getCommentById,
  getCommentsForSheet,
  getCommentIndicators,
  getCommentIndicatorsInRange,
  addReply,
  updateReply,
  deleteReply,
  moveComment,
  getCommentCount,
  clearAllComments,
  clearCommentsInRange,
} from "@api";
import type { AddCommentParams, AddReplyParams } from "@api";

const A = AREA_ADV_COMMENTS;

const TEST_AUTHOR_EMAIL = "test@calcula.dev";
const TEST_AUTHOR_NAME = "Test User";

function makeCommentParams(
  row: number,
  col: number,
  content: string
): AddCommentParams {
  return {
    row,
    col,
    authorEmail: TEST_AUTHOR_EMAIL,
    authorName: TEST_AUTHOR_NAME,
    content,
  };
}

export const advancedCommentsSuite: TestSuite = {
  name: "Advanced Comments",
  description: "Tests comment update, reply management, move, indicators, and sheet-level queries.",

  afterEach: async (ctx) => {
    try { await clearCommentsInRange(A.row, A.col, A.row + 10, A.col + 5); } catch { /* ignore */ }
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
      name: "Update comment content",
      description: "updateComment changes the text of an existing comment.",
      run: async (ctx) => {
        const addResult = await addComment(makeCommentParams(A.row, A.col, "Original text"));
        assertTrue(addResult.success, "add should succeed");
        const commentId = addResult.comment!.id;

        const updateResult = await updateComment({
          commentId,
          content: "Updated text",
        });
        assertTrue(updateResult.success, "update should succeed");

        const updated = await getCommentById(commentId);
        expectNotNull(updated, "comment should exist");
        assertEqual(updated!.content, "Updated text", "content should be updated");
      },
    },
    {
      name: "Update and delete reply",
      description: "updateReply changes text, deleteReply removes it.",
      run: async (ctx) => {
        const addResult = await addComment(makeCommentParams(A.row, A.col, "Parent"));
        const commentId = addResult.comment!.id;

        const replyParams: AddReplyParams = {
          commentId,
          authorEmail: TEST_AUTHOR_EMAIL,
          authorName: TEST_AUTHOR_NAME,
          content: "Original reply",
        };
        const replyResult = await addReply(replyParams);
        assertTrue(replyResult.success, "add reply should succeed");
        const replyId = replyResult.reply!.id;

        // Update reply
        const updateResult = await updateReply({
          commentId,
          replyId,
          content: "Updated reply",
        });
        assertTrue(updateResult.success, "update reply should succeed");

        // Verify updated content
        const comment = await getCommentById(commentId);
        const reply = comment!.replies.find(r => r.id === replyId);
        expectNotNull(reply, "reply should exist");
        assertEqual(reply!.content, "Updated reply", "reply content updated");

        // Delete reply
        const deleteResult = await deleteReply(commentId, replyId);
        assertTrue(deleteResult.success, "delete reply should succeed");

        const afterDelete = await getCommentById(commentId);
        const gone = afterDelete!.replies.find(r => r.id === replyId);
        assertTrue(gone === undefined, "reply should be gone");
      },
    },
    {
      name: "Move comment to another cell",
      description: "moveComment relocates a comment.",
      run: async (ctx) => {
        const addResult = await addComment(makeCommentParams(A.row, A.col, "Movable"));
        const commentId = addResult.comment!.id;

        const moveResult = await moveComment(commentId, A.row + 3, A.col + 1);
        assertTrue(moveResult.success, "move should succeed");

        // Old location should be empty
        const oldComment = await getComment(A.row, A.col);
        assertTrue(oldComment === null, "no comment at old location");

        // New location should have it
        const newComment = await getComment(A.row + 3, A.col + 1);
        expectNotNull(newComment, "comment at new location");
        assertEqual(newComment!.content, "Movable", "content preserved");
      },
    },
    {
      name: "Get comment indicators",
      description: "getCommentIndicators returns markers for cells with comments.",
      run: async (ctx) => {
        await addComment(makeCommentParams(A.row, A.col, "C1"));
        await addComment(makeCommentParams(A.row + 1, A.col, "C2"));

        const indicators = await getCommentIndicators();
        const ours = indicators.filter(i => i.row >= A.row && i.row <= A.row + 1 && i.col === A.col);
        assertTrue(ours.length >= 2, `should have at least 2 indicators, got ${ours.length}`);
      },
    },
    {
      name: "Get comment indicators in range",
      description: "getCommentIndicatorsInRange filters by viewport.",
      run: async (ctx) => {
        await addComment(makeCommentParams(A.row, A.col, "In range"));

        const indicators = await getCommentIndicatorsInRange(A.row, A.col, A.row + 5, A.col + 5);
        const ours = indicators.filter(i => i.row === A.row && i.col === A.col);
        assertTrue(ours.length >= 1, "should find our indicator");
      },
    },
    {
      name: "Get comments for sheet",
      description: "getCommentsForSheet returns all comments on a specific sheet.",
      run: async (ctx) => {
        await addComment(makeCommentParams(A.row, A.col, "Sheet comment"));

        const comments = await getCommentsForSheet(0);
        assertTrue(comments.length >= 1, "should have at least 1 comment");
        const ours = comments.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(ours, "our comment should be in sheet comments");
      },
    },
    {
      name: "Clear all comments",
      description: "clearAllComments removes every comment on the sheet.",
      run: async (ctx) => {
        await addComment(makeCommentParams(A.row, A.col, "X"));
        await addComment(makeCommentParams(A.row + 1, A.col, "Y"));

        const beforeCount = await getCommentCount();
        assertTrue(beforeCount >= 2, "should have at least 2 comments");

        const cleared = await clearAllComments();
        assertTrue(cleared >= 2, `should clear at least 2, cleared ${cleared}`);

        const afterCount = await getCommentCount();
        assertEqual(afterCount, 0, "no comments after clear all");
      },
    },
  ],
};
