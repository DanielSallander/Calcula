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
 * THE CONSTANTS DO LAND EXACTLY, and this comment used to say the opposite.
 * `Review/rendering/triangleRenderer.ts` paints NOTE_COLOR `#FF0000` and
 * COMMENT_COLOR `#7B68EE` (note red, comment purple — that way round). Measured
 * 2026-08-15 by decoding both the committed goldens and a fresh capture: the
 * triangles read `255,0,0` and `123,104,238`, i.e. the source constants to the
 * bit, with `255,127,127` / `170,165,240` on their antialiased edges.
 *
 * The `226,57,34` / `124,111,229` this comment used to warn about are those same
 * two colours rasterized through a WIDE-GAMUT DISPLAY PROFILE — captures taken
 * before `--force-color-profile=sRGB` was pinned (see e2e/webview2Args.mjs,
 * which measures the same shift on StatusBar's `#217346`). With the pin in force
 * an exact-constant count is correct and is the sharpest available check; it was
 * the environment that had drifted, not the renderer.
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

/**
 * Reclaim this file's own ground before anything is photographed.
 *
 * WHY (BUG-0074). The three goldens here photograph W1, X1 and W6, and for a
 * while they photographed something no test in this file creates: an Excel
 * TableStyleMedium2 header (`#4472C4` fill, white bold text) on W1 and a banded
 * row (`#D9E2F3`) on W2 and W6. `tables.spec.ts` built a table over V1:W2 —
 * inside the W-X ground this file's header declares — and never deleted it.
 *
 * A table is not cell state. Its colours come from the Table extension's STYLE
 * INTERCEPTOR, applied per frame from the table DEFINITION, so `resetGrid`,
 * `clear_range_with_options` and `new_file`-less resets all leave it painting.
 * And because `tables` sorts after `comments-notes`, it could only ever reach
 * this file on the SECOND run against one app process — which is why one build
 * gave three answers: cold 3 fail, warm 6 pass / 1 fail, and an
 * `--update-snapshots` pass on a warm app wrote the contamination as truth.
 *
 * The cause is fixed where it was caused (tables.spec.ts now stays in R-T and
 * tears its tables down, and zz-workbook-residue.spec.ts fails the run if any
 * table survives). This is the second line of defence: the golden should be a
 * function of THIS test, not of who ran before it. It deletes any table
 * overlapping W1:X10 and clears formatting there — both cheap, both idempotent,
 * and neither touches comments or notes, which are separate state.
 */
async function reclaimTerritory(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    if (!tauri?.core?.invoke) return;
    const tables: Array<{
      id: string; startRow: number; startCol: number; endRow: number; endCol: number;
    }> = await tauri.core.invoke("get_all_tables", {}).catch(() => []);
    // W1:X10 = rows 0..9, cols 22..23.
    for (const t of tables) {
      const overlaps =
        t.startRow <= 9 && t.endRow >= 0 && t.startCol <= 23 && t.endCol >= 22;
      if (overlaps) {
        await tauri.core.invoke("delete_table", { tableId: t.id }).catch(() => {});
      }
    }
    // `applyTo` is lower case — see e2e/__tests__/clearApplyToVocabulary.test.ts.
    await tauri.core
      .invoke("clear_range_with_options", {
        params: { startRow: 0, startCol: 22, endRow: 9, endCol: 23, applyTo: "formats" },
      })
      .catch(() => {});
    window.dispatchEvent(new Event("app:table-definitions-updated"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(300);
}

test.beforeEach(async ({ grid }) => {
  await reclaimTerritory(grid.page);
});

/**
 * THIS FILE'S OWN RESIDUE — the annotations it creates.
 *
 * Measured 2026-08-15: running this file twice against one app process failed
 * FOUR tests the second time, and none of them on a screenshot. `add_comment`
 * and `add_note` refuse a cell that already carries one, so
 * `expect(result.success).toBe(true)` failed at W1, W2, W3 and X1 — the comments
 * and notes the FIRST run left behind. Nothing in the suite removes an
 * annotation: it is neither cell state (`clear_range_with_options` does not
 * touch it) nor a floating object (the residue guard cannot see it).
 *
 * NOT done in `beforeEach`, deliberately. The `notes-cell-with-indicator` golden
 * clips X1 with 4 px of padding, and those 4 px contain the right edge of W1 —
 * including 15 px of the COMMENT triangle test 1 put there. That cross-test
 * dependency is real and is documented at the top of this file; wiping
 * annotations between tests would quietly delete it from the golden. The file's
 * tests may depend on each other; the RUN may not depend on the previous run.
 */
test.afterAll(async ({ sharedPage }) => {
  await sharedPage.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    if (!tauri?.core?.invoke) return;
    // W1:X10 — rows 0..9, cols 22..23, the ground this file's header claims.
    for (let row = 0; row <= 9; row++) {
      for (const col of [22, 23]) {
        const comment: { id?: string } | null = await tauri.core
          .invoke("get_comment", { row, col })
          .catch(() => null);
        if (comment?.id) {
          await tauri.core.invoke("delete_comment", { commentId: comment.id }).catch(() => {});
        }
        const note: { id?: string } | null = await tauri.core
          .invoke("get_note", { row, col })
          .catch(() => null);
        if (note?.id) {
          await tauri.core.invoke("delete_note", { noteId: note.id }).catch(() => {});
        }
      }
    }
    // `applyTo` is lower case — see e2e/__tests__/clearApplyToVocabulary.test.ts.
    await tauri.core
      .invoke("clear_range_with_options", {
        params: { startRow: 0, startCol: 22, endRow: 9, endCol: 23, applyTo: "all" },
      })
      .catch(() => {});
    // The backend forgot them; Review keeps its own indicator cache and only
    // re-reads it on this event, so without it the triangles keep painting.
    window.dispatchEvent(new CustomEvent("app:annotations-changed", { detail: {} }));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await sharedPage.waitForTimeout(400);
});

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
