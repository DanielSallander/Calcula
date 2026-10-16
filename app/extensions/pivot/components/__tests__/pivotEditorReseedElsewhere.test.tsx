//! FILENAME: app/extensions/Pivot/components/__tests__/pivotEditorReseedElsewhere.test.tsx
// PURPOSE: BUG-0466 -- an open field-list editor must not undo a field edit made
//          by another door. The value-cell menu's Summarize Values By / Show
//          Values As / Remove (and a header's Remove) change the pivot while the
//          editor still holds its mount-time zones; every editor request
//          REPLACES the pivot's fields, so the next edit in the pane sent the old
//          fields back. The editor now re-seeds its zones on
//          `PivotEvents.PIVOT_FIELDS_EDITED_ELSEWHERE` (usePivotEditorState,
//          `readPivotZones`), sending nothing for the re-seed itself.
// CONTEXT: The real hook and the real event bus (@api emitAppEvent /
//          onAppEvent); only the definition read is a double.

import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as fs from "fs";
import * as path from "path";
import { emitAppEvent } from "@api/events";
import { usePivotEditorState } from "../usePivotEditorState";
import { PivotEvents } from "../../../_shared/lib/pivotEvents";
import type { PivotZones } from "../../lib/pivotFieldsRequest";
import type { SourceField, UpdatePivotFieldsRequest, ZoneField } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sourceFields: SourceField[] = [
  { index: 0, name: "Region", isNumeric: false },
  { index: 1, name: "Units", isNumeric: true },
  { index: 2, name: "Month", isNumeric: false },
] as SourceField[];

const REGION: ZoneField = { sourceIndex: 0, name: "Region", isNumeric: false };
const SUM_UNITS: ZoneField = { sourceIndex: 1, name: "Units", isNumeric: true, aggregation: "sum" };
const COUNT_UNITS: ZoneField = { sourceIndex: 1, name: "Units", isNumeric: true, aggregation: "count" };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

type Editor = ReturnType<typeof usePivotEditorState>;

interface Mounted {
  editor: () => Editor;
  sent: UpdatePivotFieldsRequest[];
  reads: () => number;
}

function mount(pivotId: string, read: (() => Promise<PivotZones | null>) | undefined): Mounted {
  const sent: UpdatePivotFieldsRequest[] = [];
  let reads = 0;
  let current: Editor | null = null;
  const counted = read
    ? () => {
        reads++;
        return read();
      }
    : undefined;
  function Probe(): null {
    current = usePivotEditorState({
      pivotId: pivotId as never,
      sourceFields,
      initialRows: [REGION],
      initialValues: [SUM_UNITS],
      onUpdate: (req) => sent.push(req),
      readPivotZones: counted,
    });
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return { editor: () => current!, sent, reads: () => reads };
}

/** Announce an edit made elsewhere and let the re-read land. */
async function editedElsewhere(pivotId: string): Promise<void> {
  await act(async () => {
    emitAppEvent(PivotEvents.PIVOT_FIELDS_EDITED_ELSEWHERE, { pivotId });
    await Promise.resolve();
    await Promise.resolve();
  });
}

const afterCount: PivotZones = { rows: [REGION], columns: [], values: [COUNT_UNITS], filters: [] };

describe("BUG-0466: the editor re-seeds after a field edit made elsewhere", () => {
  it("the next edit in the pane keeps the menu's Count -- it no longer sends Sum back", async () => {
    const { editor, sent } = mount("7", () => Promise.resolve(afterCount));
    await editedElsewhere("7");
    expect(editor().values.map((v) => v.aggregation)).toEqual(["count"]);
    // The re-seed itself sends nothing: the pivot already holds these fields.
    expect(sent).toHaveLength(0);

    // An unrelated edit in the open pane: Month ticked on.
    act(() => editor().handleFieldToggle(sourceFields[2], true));
    expect(sent.length).toBeGreaterThan(0);
    const last = sent[sent.length - 1];
    expect(last.valueFields.map((v) => v.aggregation), "the pane sent the pre-edit Sum back").toEqual(["count"]);
  });

  it("positive control: without the announcement the stale Sum IS what the next edit sends", () => {
    const { editor, sent } = mount("7", () => Promise.resolve(afterCount));
    act(() => editor().handleFieldToggle(sourceFields[2], true));
    expect(sent[sent.length - 1].valueFields.map((v) => v.aggregation)).toEqual(["sum"]);
  });

  it("a removed value field stays removed", async () => {
    const removed: PivotZones = { rows: [REGION], columns: [], values: [], filters: [] };
    const { editor, sent } = mount("7", () => Promise.resolve(removed));
    await editedElsewhere("7");
    act(() => editor().handleFieldToggle(sourceFields[2], true));
    expect(sent[sent.length - 1].valueFields).toEqual([]);
  });

  it("another pivot's announcement is not read", async () => {
    const { editor, reads } = mount("7", () => Promise.resolve(afterCount));
    await editedElsewhere("8");
    expect(reads()).toBe(0);
    expect(editor().values.map((v) => v.aggregation)).toEqual(["sum"]);
  });

  it("only the LATEST read is applied when two cross", async () => {
    const pending: Array<(z: PivotZones) => void> = [];
    const { editor } = mount("7", () => new Promise<PivotZones>((resolve) => pending.push(resolve)));
    await editedElsewhere("7");
    await editedElsewhere("7");
    expect(pending).toHaveLength(2);
    const older: PivotZones = { ...afterCount, values: [{ ...SUM_UNITS, aggregation: "max" }] };
    await act(async () => {
      pending[1](afterCount);
      await Promise.resolve();
      pending[0](older);
      await Promise.resolve();
    });
    expect(editor().values.map((v) => v.aggregation)).toEqual(["count"]);
  });

  it("an unreadable pivot (null) leaves the zones alone", async () => {
    const { editor } = mount("7", () => Promise.resolve(null));
    await editedElsewhere("7");
    expect(editor().values.map((v) => v.aggregation)).toEqual(["sum"]);
  });

  it("a failed request's reset goes back to the re-seeded zones, not the mount-time ones", async () => {
    const { editor } = mount("7", () => Promise.resolve(afterCount));
    await editedElsewhere("7");
    act(() => editor().handleFieldToggle(sourceFields[2], true));
    expect(editor().rows.map((r) => r.name)).toContain("Month");
    act(() => editor().resetZones());
    expect(editor().values.map((v) => v.aggregation)).toEqual(["count"]);
    expect(editor().rows.map((r) => r.name)).toEqual(["Region"]);
  });

  it("PivotEditor hands the hook the re-read (readPivotZones -> readPivotEditorZones)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../PivotEditor.tsx"), "utf8");
    const at = src.indexOf("usePivotEditorState({");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, src.indexOf("});", at))).toContain("readPivotZones,");
    expect(src).toContain("(await import('../lib/valueFieldEdits')).readPivotEditorZones(pivotId)");
  });
});
