//! FILENAME: app/extensions/Collaboration/__tests__/auditLogMachineTrail.test.tsx
// PURPOSE: BUG-0653 -- the audit viewer shows THIS COMPUTER's trail beside the
//          workbook's: a push whose workbook was replaced mid-push (File > Open
//          / New) is kept on this computer (Rust `machine_audit`, pinned by
//          `the_audit_row_of_a_push_whose_workbook_was_replaced_lands_in_this_computers_trail`),
//          and the viewer must ask for it and list it, marked as such.
//
// SABOTAGES: (1) the pane calls `getAuditLog()` without `includeMachine` --
//          the "asks for this computer's trail" assertion fails. (2)
//          `mergeAuditRows` drops `log.machine.entries` -- the row assertions
//          fail.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AuditLog } from "@api/collaboration";

const getAuditLog = vi.fn();

vi.mock("@api", () => ({
  onAppEvent: () => () => {},
  AppEvents: { SHEET_CHANGED: "sheet:changed" },
}));
vi.mock("@api/collaboration", () => ({
  getAuditLog: (...a: unknown[]) => getAuditLog(...a),
  setAuditEnabled: vi.fn(async () => {}),
  clearAuditLog: vi.fn(async () => {}),
}));
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(async () => false) }));
vi.mock("@api/locale", () => ({ formatDateTime: (d: Date) => d.toISOString() }));

import { AuditLogPane, mergeAuditRows } from "../components/AuditLogPane";

const LOG: AuditLog = {
  formatVersion: 1,
  enabled: true,
  maxEntries: 1000,
  entries: [
    { timestamp: "2026-11-04T09:00:00+00:00", event: "subscribe", description: "Subscribed to sales", user: "me" },
    { timestamp: "2026-11-04T11:00:00+00:00", event: "published", description: "Published report v2", user: "me" },
  ],
  machine: {
    entries: [
      {
        timestamp: "2026-11-04T10:00:00+00:00",
        event: "published",
        description: "Published x-app v1.1.0 (1 sheets)",
        user: "me",
        reason: "documentReplaced",
        package: "x-app",
      },
    ],
    total: 1,
    unreadableLines: 0,
    path: "C:\\Users\\me\\AppData\\Local\\Calcula\\collaboration-audit.jsonl",
    missing: false,
    lastWriteError: "",
  },
};

describe("mergeAuditRows", () => {
  it("lists both trails as one list, newest first, each row knowing where it is kept", () => {
    const rows = mergeAuditRows(LOG);
    expect(rows.map((r) => [r.trail, r.entry.description])).toEqual([
      ["workbook", "Published report v2"],
      ["computer", "Published x-app v1.1.0 (1 sheets)"],
      ["workbook", "Subscribed to sales"],
    ]);
    expect(mergeAuditRows({ ...LOG, machine: undefined })).toHaveLength(2);
  });
});

describe("AuditLogPane", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    getAuditLog.mockReset();
    getAuditLog.mockResolvedValue(LOG);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("asks for this computer's trail and shows its row, marked, under its own filter", async () => {
    await act(async () => {
      root.render(<AuditLogPane />);
    });
    expect(getAuditLog).toHaveBeenCalledWith({ includeMachine: true });
    const computerRows = host.querySelectorAll('[data-audit-trail="computer"]');
    expect(computerRows).toHaveLength(1);
    expect(computerRows[0].textContent).toContain("Published x-app v1.1.0");
    expect(computerRows[0].textContent).toContain("(this computer)");
    expect(computerRows[0].textContent).toContain("replaced (File > Open or New)");

    const chip = [...host.querySelectorAll("span")].find((s) => s.textContent === "This computer");
    expect(chip, "the This computer filter").toBeTruthy();
    await act(async () => {
      chip!.click();
    });
    expect(host.querySelectorAll('[data-audit-trail="workbook"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-audit-trail="computer"]')).toHaveLength(1);
  });
});
