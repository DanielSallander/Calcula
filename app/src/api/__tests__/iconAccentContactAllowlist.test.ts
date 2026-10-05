//! FILENAME: app/src/api/__tests__/iconAccentContactAllowlist.test.ts
// PURPOSE: `node scripts/icon-accent-contact.mjs --write` keeps the allowlist's
//          promise -- "an entry may only go DOWN" -- and never RAISES an entry.
// CONTEXT: Home tab 2026-10-04 (icons-integrate defect 1). --write rewrote
//          every entry with today's measurement. A measurement up to TOLERANCE
//          (1.0) above its pin is not counted as growth (edge-pixel noise
//          between Chromium builds), so the check passed it -- and the write
//          then stored it, raising the pin silently: on 2026-10-04 a write to
//          lower WrapText would have raised Gridlines 84 -> 84.8, Loop 19.2 ->
//          19.4, Pivot 13 -> 13.5, Undo and Redo 6.4 -> 6.8. Each such write
//          spends the noise margin, so the next write can raise the same pin
//          again: the shrink-only list ratchets UP one tolerance at a time.
//          The rule now: an existing entry stores min(pin, measured); only the
//          growth the user explicitly accepts (--accept-growth) is stored as
//          measured.
//
//          planAllowlist is the script's own comparison (the script imports
//          nothing it does not run; importing it launches no browser).

import { describe, it, expect } from "vitest";
import { planAllowlist } from "../../../scripts/icon-accent-contact.mjs";

interface Plan {
  measured: Record<string, number>;
  over: string[];
  shrink: string[];
  added: string[];
  next: Record<string, number>;
}
const plan = planAllowlist as (
  allow: Record<string, number>,
  result: Array<{ name: string; contact: number }>,
  options?: { tolerance?: number; acceptGrowth?: boolean },
) => Plan;

const m = (entries: Record<string, number>): Array<{ name: string; contact: number }> =>
  Object.entries(entries).map(([name, contact]) => ({ name, contact }));

describe("--write never raises an existing entry", () => {
  it("a measurement inside the noise margin keeps the PIN (the 2026-10-04 reproduction)", () => {
    const allow = { Gridlines: 84, Loop: 19.2, Pivot: 13, Redo: 6.4, Undo: 6.4, WrapText: 5.8 };
    const result = m({ Gridlines: 84.8, Loop: 19.4, Pivot: 13.5, Redo: 6.8, Undo: 6.8, WrapText: 0 });
    const p = plan(allow, result);
    // Not growth (inside the tolerance), so the check passes...
    expect(p.over).toEqual([]);
    expect(p.added).toEqual([]);
    // ...and the write stores the pins, not the noise; WrapText (now clean) leaves.
    expect(p.next).toEqual({ Gridlines: 84, Loop: 19.2, Pivot: 13, Redo: 6.4, Undo: 6.4 });
  });

  it("an improvement IS stored (that is what --write is for)", () => {
    const p = plan({ Cut: 10, Copy: 4 }, m({ Cut: 7.5, Copy: 3.9 }));
    expect(p.next).toEqual({ Cut: 7.5, Copy: 3.9 });
    expect(p.shrink).toEqual(["Cut 10 -> 7.5"]);
  });

  it("growth beyond the margin is reported (the script refuses to write it)", () => {
    const p = plan({ Cut: 10 }, m({ Cut: 11.5, Paste: 2 }));
    expect(p.over).toEqual(["Cut 10 -> 11.5"]);
    expect(p.added).toEqual(["Paste 2"]);
  });

  it("--accept-growth stores ONLY the accepted growth; noise elsewhere still keeps its pin", () => {
    const p = plan({ Cut: 10, Undo: 6.4 }, m({ Cut: 11.5, Undo: 6.8, Paste: 2 }), { acceptGrowth: true });
    expect(p.next).toEqual({ Cut: 11.5, Paste: 2, Undo: 6.4 });
  });

  it("stores the entries sorted by name, and drops every icon no longer in contact", () => {
    const p = plan({ Zeta: 3, Alpha: 2, Gone: 1 }, m({ Zeta: 3, Alpha: 1, Gone: 0, Quiet: 0 }));
    expect(Object.keys(p.next)).toEqual(["Alpha", "Zeta"]);
  });
});
