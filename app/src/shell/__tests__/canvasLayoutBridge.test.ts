//! FILENAME: app/src/shell/__tests__/canvasLayoutBridge.test.ts
// PURPOSE: A canvas sheet's layout moved by a script, an MCP tool or a package
//          refresh must reach the surfaces that draw it. The bridge re-emits
//          the backend announcement; these tests pin the literal contract with
//          the Rust emitter (a rename on one side is a bridge listening for an
//          event nobody sends) and that the bridge is actually installed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../api/backend", () => ({
  listenTauriEvent: vi.fn(),
}));

import {
  bridgeCanvasLayoutAnnouncement,
  BACKEND_CANVAS_LAYOUT_EVENT,
} from "../canvasLayoutBridge";
import { listenTauriEvent } from "../../api/backend";
import { AppEvents } from "../../api/events";

const mockListen = vi.mocked(listenTauriEvent);

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(HERE, relative), "utf8");

function deliver(payload: unknown): void {
  const registered = mockListen.mock.calls[0];
  expect(registered, "the bridge registered no Tauri listener").toBeDefined();
  (registered[1] as (p: unknown) => void)(payload);
}

let received: unknown[];
const record = (e: Event) => received.push((e as CustomEvent).detail);

beforeEach(() => {
  received = [];
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => undefined);
  window.addEventListener(AppEvents.CANVAS_LAYOUT_CHANGED, record);
});

afterEach(() => {
  window.removeEventListener(AppEvents.CANVAS_LAYOUT_CHANGED, record);
});

describe("backend canvas-layout bridge", () => {
  it("subscribes to the event name the Rust command emits", async () => {
    await bridgeCanvasLayoutAnnouncement();
    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockListen.mock.calls[0][0]).toBe(BACKEND_CANVAS_LAYOUT_EVENT);
    const rust = read("../../../src-tauri/src/sheets.rs");
    expect(rust).toContain(`pub const CANVAS_LAYOUT_EVENT: &str = "${BACKEND_CANVAS_LAYOUT_EVENT}"`);
  });

  it("the Rust command emits it after the write has returned", () => {
    const rust = read("../../../src-tauri/src/sheets.rs");
    const command = rust.slice(rust.indexOf("pub fn set_canvas_layout("));
    const body = command.slice(0, command.indexOf("\n}\n"));
    const writeAt = body.indexOf("set_canvas_layout_inner(");
    const emitAt = body.indexOf("app.emit(CANVAS_LAYOUT_EVENT");
    expect(writeAt).toBeGreaterThan(-1);
    // After the inner call returns, every guard it took is dropped: a
    // subscriber that answers by re-reading get_sheets cannot deadlock.
    expect(emitAt).toBeGreaterThan(writeAt);
  });

  it("re-emits as CANVAS_LAYOUT_CHANGED, carrying no payload", async () => {
    await bridgeCanvasLayoutAnnouncement();
    deliver({ sheetIndex: 2, sheetId: "x", layout: { gridSizePx: 24 } });
    expect(received).toEqual([null]);
  });

  it("is a no-op, not a throw, when there is no Tauri runtime", async () => {
    mockListen.mockRejectedValue(new Error("no tauri"));
    await expect(bridgeCanvasLayoutAnnouncement()).resolves.toBeUndefined();
    expect(received).toEqual([]);
  });

  it("bootstrapShell installs the bridge (in CODE, not in a comment)", () => {
    const code = read("../bootstrap.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).toMatch(/^\s*void bridgeCanvasLayoutAnnouncement\(\);/m);
  });
});
