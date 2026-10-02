//! FILENAME: app/src/api/__tests__/announce.test.ts
// PURPOSE: The polite announcement seam (@api/announce, M8 S6): one slot, the
//          last registration wins, a STALE cleanup never silences a newer
//          sink, a throwing sink is contained, and no sink is a no-op.
// CONTEXT: The shell's live region registers on mount. Under React StrictMode
//          (and on any remount) the old effect's cleanup runs AFTER or AROUND
//          the new registration; if a cleanup cleared the slot
//          unconditionally, every announcement after a remount would vanish
//          with no error anywhere. That is the defect the stale-cleanup case
//          pins.

import { describe, it, expect, vi, afterEach } from "vitest";
import { announce, registerAnnouncer } from "../announce";

const cleanups: Array<() => void> = [];

function register(sink: (message: string) => void): () => void {
  const cleanup = registerAnnouncer(sink);
  cleanups.push(cleanup);
  return cleanup;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
});

describe("@api/announce", () => {
  it("delivers a message to the registered sink, trimmed", () => {
    const heard: string[] = [];
    register((m) => heard.push(m));
    announce("  North, selected, 2 of 5  ");
    expect(heard).toEqual(["North, selected, 2 of 5"]);
  });

  it("the last registration wins", () => {
    const first: string[] = [];
    const second: string[] = [];
    register((m) => first.push(m));
    register((m) => second.push(m));
    announce("hello");
    expect(first).toEqual([]);
    expect(second).toEqual(["hello"]);
  });

  it("a stale cleanup does not remove the newer sink", () => {
    const older: string[] = [];
    const newer: string[] = [];
    const cleanupOlder = register((m) => older.push(m));
    register((m) => newer.push(m));
    // The OLD registration's cleanup runs late (React StrictMode remount, an
    // old shell unmounting after the new one mounted).
    cleanupOlder();
    announce("still heard");
    expect(newer).toEqual(["still heard"]);
    expect(older).toEqual([]);
  });

  it("a stale cleanup of the SAME function registered twice does not remove the newer registration", () => {
    const heard: string[] = [];
    const sink = (m: string): void => {
      heard.push(m);
    };
    const cleanupFirst = register(sink);
    register(sink);
    cleanupFirst();
    announce("twice registered");
    expect(heard).toEqual(["twice registered"]);
  });

  it("the current registration's own cleanup clears the slot (then announcing is a no-op)", () => {
    const heard: string[] = [];
    const cleanup = register((m) => heard.push(m));
    cleanup();
    expect(() => announce("nobody listens")).not.toThrow();
    expect(heard).toEqual([]);
  });

  it("with no sink registered, announcing is a silent no-op", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => announce("before the shell mounts")).not.toThrow();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a throwing sink is contained and logged, and the next message still arrives", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const heard: string[] = [];
    register((m) => {
      calls++;
      if (calls === 1) throw new Error("region gone");
      heard.push(m);
    });
    expect(() => announce("first")).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    announce("second");
    expect(heard).toEqual(["second"]);
  });

  it("an empty or whitespace-only message is not delivered", () => {
    const heard: string[] = [];
    register((m) => heard.push(m));
    announce("");
    announce("   ");
    expect(heard).toEqual([]);
  });
});
