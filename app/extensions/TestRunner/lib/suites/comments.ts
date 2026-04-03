//! FILENAME: app/extensions/TestRunner/lib/suites/comments.ts
// PURPOSE: Comments test suite.
// CONTEXT: Tests adding, retrieving, resolving, replying, and clearing comments.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_COMMENTS } from "../testArea";
import {
  addComment,
  getComment,
  deleteComment,
  resolveComment,
  addReply,
  getCommentCount,
  hasComment,
  clearCommentsInRange,
} from "@api";
import type { AddCommentParams, AddReplyParams } from "@api";

const A = AREA_COMMENTS;

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

export const commentsSuite: TestSuite = {
  name: "Comments",
  description: "Tests comment CRUD, resolve, reply, and range clear.",

  afterEach: async (ctx) => {
    try {
      await clearCommentsInRange(A.row, A.col, A.row + 10, A.col + 5);
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
      name: "Add and retrieve comment",
      description: "addComment creates, getComment retrieves it.",
      run: async (ctx) => {
        const result = await addComment(makeCommentParams(A.row, A.col, "Hello comment"));
        assertTrue(result.success, "addComment should succeed");
        expectNotNull(result.comment, "comment should be returned");

        const retrieved = await getComment(A.row, A.col);
        expectNotNull(retrieved, "getComment should return the comment");
        assertEqual(retrieved!.content, "Hello comment", "content matches");
        assertEqual(retrieved!.authorName, TEST_AUTHOR_NAME, "author matches");
      },
    },
    {
      name: "hasComment returns true/false",
      description: "True when comment exists, false when not.",
      run: async (ctx) => {
        const before = await hasComment(A.row, A.col);
        assertTrue(!before, "should be false before adding");

        await addComment(makeCommentParams(A.row, A.col, "exists"));
        await ctx.settle();

        const after = await hasComment(A.row, A.col);
        assertTrue(after, "should be true after adding");
      },
    },
    {
      name: "Delete comment",
      description: "Comment removed after delete.",
      run: async (ctx) => {
        const result = await addComment(makeCommentParams(A.row, A.col, "to delete"));
        assertTrue(result.success, "add should succeed");
        const commentId = result.comment!.id;

        const delResult = await deleteComment(commentId);
        assertTrue(delResult.success, "delete should succeed");

        const check = await getComment(A.row, A.col);
        assertTrue(check === null, "comment should be gone after delete");
      },
    },
    {
      name: "Resolve and unresolve comment",
      description: "Comment resolved flag toggles.",
      run: async (ctx) => {
        const result = await addComment(makeCommentParams(A.row, A.col, "resolve me"));
        const commentId = result.comment!.id;

        // Resolve
        const resolved = await resolveComment(commentId, true);
        assertTrue(resolved.success, "resolve should succeed");
        assertTrue(resolved.comment!.resolved === true, "should be resolved");

        // Unresolve
        const unresolved = await resolveComment(commentId, false);
        assertTrue(unresolved.success, "unresolve should succeed");
        assertTrue(unresolved.comment!.resolved === false, "should be unresolved");
      },
    },
    {
      name: "Add reply to comment",
      description: "Reply appears in comment replies.",
      run: async (ctx) => {
        const result = await addComment(makeCommentParams(A.row, A.col, "parent"));
        const commentId = result.comment!.id;

        const replyParams: AddReplyParams = {
          commentId,
          authorEmail: TEST_AUTHOR_EMAIL,
          authorName: TEST_AUTHOR_NAME,
          content: "This is a reply",
        };
        const replyResult = await addReply(replyParams);
        assertTrue(replyResult.success, "addReply should succeed");
        expectNotNull(replyResult.reply, "reply should be returned");

        // Retrieve comment and check replies
        const updated = await getComment(A.row, A.col);
        expectNotNull(updated, "comment still exists");
        assertTrue(updated!.replies.length >= 1, "should have at least 1 reply");
        assertEqual(updated!.replies[0].content, "This is a reply", "reply content");
      },
    },
    {
      name: "Comment count increments",
      description: "getCommentCount reflects additions.",
      run: async (ctx) => {
        const before = await getCommentCount();
        await addComment(makeCommentParams(A.row, A.col, "count1"));
        await addComment(makeCommentParams(A.row + 1, A.col, "count2"));

        const after = await getCommentCount();
        assertTrue(after >= before + 2, `Should have at least 2 more comments, was ${before} now ${after}`);
      },
    },
    {
      name: "Clear comments in range",
      description: "clearCommentsInRange removes all comments in area.",
      run: async (ctx) => {
        await addComment(makeCommentParams(A.row, A.col, "c1"));
        await addComment(makeCommentParams(A.row + 1, A.col, "c2"));
        await addComment(makeCommentParams(A.row + 2, A.col, "c3"));

        const cleared = await clearCommentsInRange(A.row, A.col, A.row + 2, A.col);
        assertTrue(cleared >= 3, `Should clear at least 3, cleared ${cleared}`);

        const check = await hasComment(A.row, A.col);
        assertTrue(!check, "should be no comment after clear");
      },
    },
  ],
};
