//! FILENAME: app/extensions/Animation/__tests__/documentBoundaryUnload.test.ts
// PURPOSE: The Animation driver unloads at every document boundary, and a CLOSE
//          waits for the unload's restore (E8, BUG-0200 close parts).
// CONTEXT: The restore writes the model back from the transient frame; the
//          close prompt's Save wrote the file as soon as BEFORE_CLOSE returned,
//          so a close-then-Save during playback could save the transient frame.
//          The close preparation (@api/lifecycleGuards) makes the shell wait.

import { describe, it, expect, afterEach, vi } from "vitest";
import { AppEvents, emitAppEvent } from "@api/events";
import {
  closePreparationCount,
  resetClosePreparations,
  runClosePreparations,
} from "@api/lifecycleGuards";
import { installDocumentBoundaryUnload } from "../lib/documentBoundaryUnload";

function heldEngine() {
  let release: () => void = () => {};
  let restored = false;
  const clearDriver = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = () => {
          restored = true;
          resolve();
        };
      }),
  );
  return { engine: { clearDriver }, release: () => release(), restored: () => restored, clearDriver };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetClosePreparations();
});

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("Animation's document-boundary unload", () => {
  it("BEFORE_OPEN, BEFORE_NEW and BEFORE_CLOSE each unload the driver", () => {
    const { engine, clearDriver } = heldEngine();
    cleanups.push(installDocumentBoundaryUnload(engine));
    emitAppEvent(AppEvents.BEFORE_OPEN);
    emitAppEvent(AppEvents.BEFORE_NEW);
    emitAppEvent(AppEvents.BEFORE_CLOSE);
    expect(clearDriver).toHaveBeenCalledTimes(3);
  });

  it("a CLOSE waits for the restore: the preparations resolve only once the model is back", async () => {
    const held = heldEngine();
    cleanups.push(installDocumentBoundaryUnload(held.engine));
    emitAppEvent(AppEvents.BEFORE_CLOSE);
    let prepared = false;
    const closing = runClosePreparations().then(() => {
      prepared = true;
    });
    await drain();
    expect(prepared, "the close went on with the transient frame still in the cells").toBe(false);
    held.release();
    await closing;
    expect(held.restored()).toBe(true);
    expect(prepared).toBe(true);
    // One unload, not a second one started by the preparation.
    expect(held.clearDriver).toHaveBeenCalledTimes(1);
  });

  it("a close that reaches the preparations without BEFORE_CLOSE still unloads and waits", async () => {
    const held = heldEngine();
    cleanups.push(installDocumentBoundaryUnload(held.engine));
    const closing = runClosePreparations();
    await drain();
    expect(held.clearDriver).toHaveBeenCalledTimes(1);
    held.release();
    await closing;
    expect(held.restored()).toBe(true);
  });

  it("is withdrawn with the extension", () => {
    const { engine, clearDriver } = heldEngine();
    const before = closePreparationCount();
    const off = installDocumentBoundaryUnload(engine);
    expect(closePreparationCount()).toBe(before + 1);
    off();
    expect(closePreparationCount()).toBe(before);
    emitAppEvent(AppEvents.BEFORE_CLOSE);
    expect(clearDriver).not.toHaveBeenCalled();
  });
});
