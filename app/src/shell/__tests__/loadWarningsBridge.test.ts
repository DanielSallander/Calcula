//! FILENAME: app/src/shell/__tests__/loadWarningsBridge.test.ts
// PURPOSE: What `open_file` changed or dropped while loading reaches the user.
// CONTEXT: `document:load-warnings` was emitted by the backend and listened to
//          by nothing. Round 13 added the sheet-name notice (a sheet renamed on
//          load because its name clashed with another by Excel's rule), so the
//          bridge now shows each warning once, as a toast that does not block
//          the open. The last test proves the bridge is actually INSTALLED --
//          a bridge nobody starts is the silence it exists to end.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../api/backend", () => ({
  listenTauriEvent: vi.fn(),
}));
vi.mock("../../api/notifications", () => ({
  showToast: vi.fn(() => ({ dismiss() {} })),
}));

import { bridgeLoadWarnings, loadWarningText, BACKEND_LOAD_WARNINGS_EVENT } from "../loadWarningsBridge";
import { listenTauriEvent } from "../../api/backend";
import { showToast } from "../../api/notifications";

const mockListen = vi.mocked(listenTauriEvent);
const mockToast = vi.mocked(showToast);
const HERE = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => {});
  mockToast.mockClear();
});

function deliver(payload: unknown): void {
  const registered = mockListen.mock.calls[0];
  expect(registered?.[0]).toBe(BACKEND_LOAD_WARNINGS_EVENT);
  (registered[1] as (p: unknown) => void)(payload);
}

describe("load warnings bridge", () => {
  it("shows the sheet-name rename notice once, as a warning the user dismisses", async () => {
    await bridgeLoadWarnings();
    deliver({ section: "sheetNames", message: "'ärende' is now 'ärende (2)'" });
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith("'ärende' is now 'ärende (2)'", {
      variant: "warning",
      duration: 0,
    });
  });

  it("shows the backend's plain sentence, never a file name or a parser error", () => {
    // rev13C nit: the AutoFilter loss used to be shown as
    // "(autofilters.json: the whole section could not be read: <serde error>)".
    const message =
      "The filter settings on one sheet of this workbook could not be read, so those filters were not restored. " +
      "Saving the workbook will not write them back.";
    expect(loadWarningText({ section: "autoFilters", message })).toBe(message);
    // A payload with no sentence shows nothing rather than its raw fields.
    const raw = { section: "autofilters.json", lost: ["sheet 2: missing field `range`"] } as never;
    expect(loadWarningText(raw)).toBeNull();
    expect(loadWarningText({ section: "autoFilters", message: "  " })).toBeNull();
    expect(loadWarningText(null)).toBeNull();
  });

  it("is installed by the shell, and the backend emits the event it listens to", () => {
    const bootstrap = readFileSync(resolve(HERE, "../bootstrap.ts"), "utf8");
    expect(bootstrap).toMatch(/^\s*void bridgeLoadWarnings\(\);/m);
    const persistence = readFileSync(resolve(HERE, "../../../src-tauri/src/persistence.rs"), "utf8");
    // ONE emit, at the end of open_file, for every warning the load collected.
    expect(persistence.split(`"${BACKEND_LOAD_WARNINGS_EVENT}"`).length - 1).toBeGreaterThanOrEqual(1);
  });
});
