/**
 * Comments & Notes E2E tests.
 *
 * Tests comment and note CRUD operations via Tauri API commands.
 * Uses cells in columns W-X, rows 1-10.
 */
import { test, expect } from "../fixtures";
import { takeGridRegionScreenshot } from "../helpers/screenshots";
import type { Page } from "@playwright/test";

/**
 * Tell the frontend that annotations changed.
 *
 * These tests create comments/notes by invoking the RUST command directly,
 * which is a backend-only mutation: nothing on the TypeScript side hears about
 * it. Review/index.ts keeps its indicator cache (annotationStore) in sync by
 * listening for AppEvents.ANNOTATIONS_CHANGED — the documented path for
 * "annotations created OUTSIDE this extension's own UI", which is exactly the
 * script/api.setNote case and exactly this case.
 *
 * Without it the store stays empty, no triangle is ever painted, and the
 * goldens named `...-cell-with-indicator` would contain no indicator. The
 * committed goldens DO contain theirs — the notes golden holds 10 px of the
 * note triangle and 15 px of a neighbouring comment triangle.
 *
 * DO NOT verify that by counting #FF0000 / #7B68EE pixels. Those are the source
 * constants in `Review/rendering/triangleRenderer.ts`, but the renderer paints
 * through the skin/theme, so the literal constant never lands in a frame: the
 * triangles decode as `226,57,34` and `124,111,229`. An exact-constant count
 * reports "no indicator" on a frame that plainly has one, which is exactly the
 * wrong conclusion this comment used to record. Count near-matches, or diff the
 * frame against the same frame with the decoration unregistered — the technique
 * `gridRenderer/cellDecorationZOrder.test.ts` and the live journey assertion in
 * `journeys/correctness-cluster.spec.ts` (test 10) both use.
 */
async function announceAnnotationsChanged(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("app:annotations-changed", { detail: {} })
    );
  });
  // refreshAnnotationState() is an async round-trip; the repaint it triggers
  // only lands after it resolves.
  await page.waitForTimeout(700);
}

test.describe("Comments", () => {
  test("add a comment to a cell", async ({ appPage, grid }) => {
    await grid.setCellValueDirect("W1", "Has Comment");
    await grid.page.waitForTimeout(200);

    // Add comment via Tauri API
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_comment", {
        params: {
          row: 0,
          col: 22,
          authorEmail: "test@example.com",
          authorName: "Test User",
          content: "This is a test comment",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(result.success).toBe(true);
    expect(result.comment).toBeDefined();
    expect(result.comment.content).toBe("This is a test comment");

    // Verify comment can be retrieved
    const comment: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_comment", { row: 0, col: 22 });
    });

    expect(comment).not.toBeNull();
    expect(comment.content).toBe("This is a test comment");

    await grid.navigateTo("W1");
    await announceAnnotationsChanged(grid.page);
    // Clipped to the single annotated cell. Measured: the indicator triangle is
    // 66 device pixels — 0.0096% of a whole-grid shot (invisible to any ratio
    // gate) but 0.82% of this one. See takeGridRegionScreenshot.
    await takeGridRegionScreenshot(appPage, "comments-cell-with-indicator", {
      from: "W1",
      to: "W1",
    });
  });

  test("add a reply to a comment", async ({ grid }) => {
    // Create a comment first
    const createResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_comment", {
        params: {
          row: 1,
          col: 22,
          authorEmail: "user1@example.com",
          authorName: "User One",
          content: "Initial comment",
        },
      });
    });
    await grid.page.waitForTimeout(300);
    expect(createResult.success).toBe(true);

    const commentId = createResult.comment.id;

    // Add a reply
    const replyResult: any = await grid.page.evaluate(
      async (id: string) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("add_reply", {
          params: {
            commentId: id,
            authorEmail: "user2@example.com",
            authorName: "User Two",
            content: "This is a reply",
          },
        });
      },
      commentId
    );
    await grid.page.waitForTimeout(300);

    expect(replyResult.success).toBe(true);
    expect(replyResult.reply).toBeDefined();
    expect(replyResult.reply.content).toBe("This is a reply");
  });

  test("resolve and unresolve a comment", async ({ grid }) => {
    // Create a comment
    const createResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_comment", {
        params: {
          row: 2,
          col: 22,
          authorEmail: "test@example.com",
          authorName: "Test User",
          content: "Needs resolution",
        },
      });
    });
    await grid.page.waitForTimeout(300);
    expect(createResult.success).toBe(true);

    const commentId = createResult.comment.id;

    // Resolve the comment
    const resolveResult: any = await grid.page.evaluate(
      async (id: string) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("resolve_comment", {
          commentId: id,
          resolved: true,
        });
      },
      commentId
    );
    await grid.page.waitForTimeout(300);
    expect(resolveResult.success).toBe(true);

    // Verify resolved state
    const resolved: any = await grid.page.evaluate(
      async (id: string) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("get_comment_by_id", { commentId: id });
      },
      commentId
    );
    expect(resolved.resolved).toBe(true);

    // Unresolve
    await grid.page.evaluate(
      async (id: string) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("resolve_comment", {
          commentId: id,
          resolved: false,
        });
      },
      commentId
    );
    await grid.page.waitForTimeout(300);

    const unresolved: any = await grid.page.evaluate(
      async (id: string) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("get_comment_by_id", { commentId: id });
      },
      commentId
    );
    expect(unresolved.resolved).toBe(false);
  });

  test("delete a comment", async ({ grid }) => {
    // Create a comment
    const createResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_comment", {
        params: {
          row: 3,
          col: 22,
          authorEmail: "test@example.com",
          authorName: "Test User",
          content: "To be deleted",
        },
      });
    });
    await grid.page.waitForTimeout(300);
    expect(createResult.success).toBe(true);

    const commentId = createResult.comment.id;

    // Delete the comment
    const deleteResult: any = await grid.page.evaluate(
      async (id: string) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("delete_comment", { commentId: id });
      },
      commentId
    );
    await grid.page.waitForTimeout(300);
    expect(deleteResult.success).toBe(true);

    // Verify it's gone
    const deleted: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_comment", { row: 3, col: 22 });
    });
    expect(deleted).toBeNull();
  });
});

test.describe("Notes", () => {
  test("add a note to a cell", async ({ appPage, grid }) => {
    await grid.setCellValueDirect("X1", "Has Note");
    await grid.page.waitForTimeout(200);

    // Add note via Tauri API
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_note", {
        params: {
          row: 0,
          col: 23,
          authorName: "Test User",
          content: "This is a sticky note",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(result.success).toBe(true);
    expect(result.note).toBeDefined();

    // Verify note can be retrieved
    const note: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_note", { row: 0, col: 23 });
    });

    expect(note).not.toBeNull();
    expect(note.content).toBe("This is a sticky note");

    await grid.navigateTo("X1");
    await announceAnnotationsChanged(grid.page);
    await takeGridRegionScreenshot(appPage, "notes-cell-with-indicator", {
      from: "X1",
      to: "X1",
    });
  });

  test("delete a note", async ({ grid }) => {
    // Create a note
    const createResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_note", {
        params: {
          row: 1,
          col: 23,
          authorName: "Test User",
          content: "Note to delete",
        },
      });
    });
    await grid.page.waitForTimeout(300);
    expect(createResult.success).toBe(true);

    const noteId = createResult.note.id;

    // Delete the note
    const deleteResult: any = await grid.page.evaluate(
      async (id: string) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("delete_note", { noteId: id });
      },
      noteId
    );
    await grid.page.waitForTimeout(300);
    expect(deleteResult.success).toBe(true);

    // Verify it's gone
    const deleted: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_note", { row: 1, col: 23 });
    });
    expect(deleted).toBeNull();
  });

  test("comment indicators are reported for cells with annotations", async ({
    appPage,
    grid,
  }) => {
    // Create a comment and a note on different cells
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("add_comment", {
        params: {
          row: 5,
          col: 22,
          authorEmail: "test@example.com",
          authorName: "Test User",
          content: "Indicator test comment",
        },
      });
    });
    await grid.page.waitForTimeout(200);

    // Get comment indicators
    const indicators: any[] = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_comment_indicators");
    });

    // Should have at least the one we just created
    expect(indicators.length).toBeGreaterThan(0);
    const found = indicators.find(
      (ind: any) => ind.row === 5 && ind.col === 22
    );
    expect(found).toBeDefined();

    await grid.navigateTo("W6");
    await announceAnnotationsChanged(grid.page);
    await takeGridRegionScreenshot(appPage, "comments-indicators-visible", {
      from: "W6",
      to: "W6",
    });
  });
});
