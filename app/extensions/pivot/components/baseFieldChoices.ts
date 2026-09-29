//! FILENAME: app/extensions/Pivot/components/baseFieldChoices.ts
// PURPOSE: The Base field / Base item choices the Value Field Settings dialog
//          offers for Show Values As (Running Total In, Difference From, % Of,
//          ...): the pivot's ROW and COLUMN fields, with their items.
// CONTEXT: The dialog renders its Base field select only when it is handed
//          fields, and its one caller (PivotEditor) handed it none -- so those
//          settings could not be made through the dialog at all (found live
//          2026-09-29, e2e fixall-pivot X1). The NAMES are known the moment the
//          dialog opens (so its default Base field is a real one); the ITEMS
//          (for Base item) are read from the pivot's source afterwards.

import { useEffect, useMemo, useState } from "react";

/** What a base-field choice needs of a zone field (both the Pivot and the
 *  shared zone-field types have it). */
export interface BaseFieldSource {
  sourceIndex: number;
  name: string;
  isLookup?: boolean;
}

export interface BaseFieldChoice {
  name: string;
  items: string[];
}

/** The fields a Show Values As base can name: row fields, then column fields,
 *  never a LOOKUP (attribute) column, each once. */
export function baseFieldNames(rows: BaseFieldSource[], columns: BaseFieldSource[]): BaseFieldSource[] {
  const seen = new Set<string>();
  const out: BaseFieldSource[] = [];
  for (const f of [...rows, ...columns]) {
    if (f.isLookup || seen.has(f.name)) continue;
    seen.add(f.name);
    out.push(f);
  }
  return out;
}

/**
 * The choices for an OPEN dialog (`open` false returns the names only and
 * reads nothing). `readItems` lists a field's items by its source index; a
 * failed read leaves that field without items (the Base field is still
 * offered; only Base item needs them).
 */
export function useBaseFieldChoices(
  open: boolean,
  rows: BaseFieldSource[],
  columns: BaseFieldSource[],
  readItems: ((sourceIndex: number) => Promise<string[]>) | null,
): BaseFieldChoice[] {
  const fields = useMemo(() => baseFieldNames(rows, columns), [rows, columns]);
  const [items, setItems] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!open || !readItems) return;
    let cancelled = false;
    void Promise.all(
      fields.map(async (f) => {
        try {
          return [f.name, await readItems(f.sourceIndex)] as const;
        } catch {
          return [f.name, [] as string[]] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setItems(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [open, fields, readItems]);

  return useMemo(() => fields.map((f) => ({ name: f.name, items: items[f.name] ?? [] })), [fields, items]);
}
