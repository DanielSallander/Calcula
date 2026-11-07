//! FILENAME: app/extensions/ConditionalFormatting/components/RulesManagerDialog.tsx
// PURPOSE: Conditional Formatting Rules Manager dialog.
// CONTEXT: Lists all CF rules for the current sheet: New Rule, Edit Rule,
//          Duplicate Rule, Delete Rule, reorder, an editable Applies To, and
//          the Stop If True / enabled toggles -- Excel's Manager.
//          P3: opened with a floating grid's `target` (data.target), it lists
//          and edits THAT object's rules (its backing sheet's), and says so
//          ("This floating grid (Float1)").
//          Wave 2 (programme 2): New Rule / Edit Rule open the New Formatting
//          Rule dialog over the Manager (Edit Rule shows the rule as stored,
//          for its first cell -- Excel's [LIVE]); Duplicate Rule puts a copy
//          next to the rule (Excel [LIVE, 2026-11-06, lane uimisc probe3]:
//          the copy lands beside the original, the rest keep their order);
//          Applies To is written as Excel writes it (=$A$2:$E$10) with every
//          column letter (it spelled AA..XFD as Z) and can be edited; the
//          colours are the dialog theme's (it stayed light in the Dark skin).
//          Wave 3 (lane cfdvfix): BUFFERED, as Excel's Manager is -- every
//          change waits for OK or Apply, which write it as ONE undo step, and
//          Cancel writes nothing; New Rule / Edit Rule hand their rule to the
//          buffer. "Show formatting rules for" offers Excel's Current Selection
//          (the rules whose Applies To meets the selection; Excel opens on it),
//          This Worksheet, and every other sheet.
//          Wave 4 (lane dtcf4): another sheet's rules are EDITED there, as in
//          Excel's Manager -- Edit, Delete, Duplicate, the order, Applies To and
//          the toggles. Each sheet keeps its own buffer while the scope moves
//          between sheets, and OK / Apply write every sheet's changes as ONE
//          undo step (the CF writes name the sheet, `CFWriteOptions.sheetIndex`).

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "@api";
import {
  addConditionalFormat,
  deleteConditionalFormat,
  reorderConditionalFormats,
  updateConditionalFormat,
  getAllConditionalFormats,
  getSheets,
  restoreFocusToGrid,
  runInUndoTransaction,
} from "@api";
import type { ConditionalFormatDefinition, ConditionalFormatRange, UpdateCFParams } from "@api";
import type { CellTargetRef } from "@api/cellTarget";
import { getGridStateSnapshot } from "@api/grid";
import { listSeparator } from "@api/locale";
import { getRules, invalidateAndRefresh } from "../lib/cfStore";
import { refreshAfterWrite, reasonOf } from "../lib/ruleWrites";
import { describeAppliesTo, parseAppliesTo } from "../lib/appliesTo";
import { DIALOG_THEME as DT } from "../../_shared/lib/dialogTheme";
import { NewRuleDialog, type BuiltCfRule } from "./NewRuleDialog";

/**
 * The rules of the dialog's scope: an object's (its backing sheet's, read with
 * its target), or the active sheet's from the rules cache.
 */
async function readRules(target: CellTargetRef | undefined): Promise<ConditionalFormatDefinition[]> {
  if (target) return [...(await getAllConditionalFormats(undefined, { target }))];
  return [...getRules()];
}

/** After a write: re-read the scope's rules (and repaint where they live). */
async function rulesAfterWrite(target: CellTargetRef | undefined): Promise<ConditionalFormatDefinition[]> {
  if (target) {
    await refreshAfterWrite(target);
  } else {
    await invalidateAndRefresh();
  }
  return readRules(target);
}

/**
 * DUPLICATE RULE: a copy of `rule` -- its condition, format, Applies To, Stop
 * If True and enabled state -- placed directly after it, every other rule
 * keeping its place. Resolves the copy's id, or throws the backend's reason.
 */
export async function duplicateRule(
  rule: ConditionalFormatDefinition,
  order: readonly number[],
  target: CellTargetRef | undefined,
): Promise<number> {
  const added = await addConditionalFormat(
    { rule: rule.rule, format: { ...rule.format }, ranges: rule.ranges.map((r) => ({ ...r })), stopIfTrue: rule.stopIfTrue },
    { target },
  );
  if (!added || added.success === false || !added.rule) {
    throw new Error(added?.error || "the backend refused the copy");
  }
  const copy = added.rule.id;
  if (!rule.enabled) await updateConditionalFormat({ ruleId: copy, enabled: false }, { target });
  const rest = order.filter((id) => id !== copy);
  const at = rest.indexOf(rule.id);
  const next = at < 0 ? [...rest, copy] : [...rest.slice(0, at + 1), copy, ...rest.slice(at + 1)];
  await reorderConditionalFormats(next, { target });
  return copy;
}

const scopeStyle: React.CSSProperties = {
  fontSize: 12,
  color: DT.textSecondary,
  margin: 0,
};

// ============================================================================
// Styles (the dialog theme's tokens, as the sibling CF dialogs use)
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: DT.overlay,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9500,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: DT.bg,
  color: DT.text,
  border: `1px solid ${DT.border}`,
  borderRadius: 4,
  boxShadow: DT.shadow,
  width: 620,
  maxHeight: "80vh",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  margin: 0,
  color: DT.title,
};

const listStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 200,
  maxHeight: 350,
  overflow: "auto",
  border: `1px solid ${DT.divider}`,
  borderRadius: 3,
  backgroundColor: DT.panelBg,
};

const ruleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderBottom: `1px solid ${DT.divider}`,
  fontSize: 13,
  cursor: "pointer",
};

const selectedRowStyle: React.CSSProperties = {
  ...ruleRowStyle,
  backgroundColor: DT.selectedBg,
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  justifyContent: "flex-start",
  flexWrap: "wrap",
};

const toolButtonStyle: React.CSSProperties = {
  padding: "4px 12px",
  border: `1px solid ${DT.buttonBorder}`,
  borderRadius: 3,
  fontSize: 12,
  cursor: "pointer",
  backgroundColor: DT.buttonBg,
  color: DT.buttonText,
};

const buttonRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 4,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "5px 16px",
  border: `1px solid ${DT.primaryBg}`,
  borderRadius: 3,
  fontSize: 13,
  cursor: "pointer",
  backgroundColor: DT.primaryBg,
  color: DT.primaryText,
};

const appliesInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "2px 6px",
  border: `1px solid ${DT.inputBorder}`,
  borderRadius: 3,
  fontSize: 12,
  color: DT.inputText,
  backgroundColor: DT.inputBg,
};

const errorStyle: React.CSSProperties = {
  fontSize: 12,
  color: DT.errorFg,
  backgroundColor: DT.errorBg,
  border: `1px solid ${DT.errorFg}`,
  borderRadius: 3,
  padding: "6px 8px",
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a rule's condition as a short human-readable summary.
 *
 * A formula is shown AS STORED -- written for the rule's first cell -- never
 * re-stated for the active cell: Excel's Rules Manager lists "Formula:
 * =$C2>100" for a rule on A2:E10 with B5 active, and its Edit Rule shows and
 * stores the same form [LIVE, Excel 16, 2026-11-06, lane uiforms probe2-4].
 * Only a NEW rule's entry is typed for the active cell (lib/ruleFormulaAnchor.ts).
 */
function describeRule(rule: ConditionalFormatDefinition): string {
  const r = rule.rule;
  switch (r.type) {
    case "cellValue":
      return `Cell Value ${r.operator} ${r.value1}${r.value2 ? ` and ${r.value2}` : ""}`;
    case "containsText":
      return `Text ${r.ruleType}: "${r.text}"`;
    case "topBottom":
      return `${r.ruleType === "topItems" || r.ruleType === "topPercent" ? "Top" : "Bottom"} ${r.rank}${r.ruleType.includes("Percent") ? "%" : " items"}`;
    case "aboveAverage":
      return r.ruleType.replace(/([A-Z])/g, " $1").trim();
    case "duplicateValues":
      return "Duplicate Values";
    case "uniqueValues":
      return "Unique Values";
    case "blankCells":
      return "Blank Cells";
    case "noBlanks":
      return "No Blanks";
    case "errorCells":
      return "Error Cells";
    case "noErrors":
      return "No Errors";
    case "expression":
      return `Formula: ${r.formula}`;
    case "timePeriod":
      return `Date: ${r.period}`;
    case "colorScale":
      return "Color Scale";
    case "dataBar":
      return "Data Bar";
    case "iconSet":
      return `Icon Set: ${r.iconSet}`;
    default:
      return "Unknown Rule";
  }
}

/** The sub-dialog open over the Manager: New Rule, or Edit Rule of one rule. */
type SubDialog = { kind: "new" } | { kind: "edit"; rule: ConditionalFormatDefinition } | null;

/** "Show formatting rules for": Excel's Current Selection, This Worksheet, or another sheet. */
type Scope = { kind: "selection" } | { kind: "sheet" } | { kind: "other"; sheetIndex: number; name: string };

/** Whether two rectangles share a cell. */
function intersects(a: ConditionalFormatRange, b: ConditionalFormatRange): boolean {
  const r0 = Math.min(a.startRow, a.endRow);
  const r1 = Math.max(a.startRow, a.endRow);
  const c0 = Math.min(a.startCol, a.endCol);
  const c1 = Math.max(a.startCol, a.endCol);
  return (
    r0 <= Math.max(b.startRow, b.endRow) &&
    Math.min(b.startRow, b.endRow) <= r1 &&
    c0 <= Math.max(b.startCol, b.endCol) &&
    Math.min(b.startCol, b.endCol) <= c1
  );
}

/** Two values the same as JSON (rules, formats and ranges are plain data). */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One sheet's buffer: its rules as read (`base`) and as the Manager left them. */
export interface RuleBuffer {
  base: readonly ConditionalFormatDefinition[];
  working: readonly ConditionalFormatDefinition[];
  /** Another worksheet's (by index); absent: the active sheet's or the object's. */
  sheetIndex?: number;
}

/**
 * APPLY: what the Manager's buffer changed, written as ONE undo step
 * ("Conditional Formatting Rules Manager"). Deleted rules go, new ones
 * (negative ids) are added, every changed rule is updated, and the list order
 * becomes the rules' priority. Resolves null, or the first refusal (what
 * landed before it stays, in the same undo step). `sheetIndex`: another
 * worksheet's rules.
 */
export async function applyRuleChanges(
  base: readonly ConditionalFormatDefinition[],
  working: readonly ConditionalFormatDefinition[],
  target: CellTargetRef | undefined,
  sheetIndex?: number,
): Promise<string | null> {
  return applyRuleBuffers([{ base, working, sheetIndex }], target);
}

/** Every sheet's buffer written as ONE undo step (see {@link applyRuleChanges}). */
export async function applyRuleBuffers(
  buffers: readonly RuleBuffer[],
  target: CellTargetRef | undefined,
): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    for (const buffer of buffers) {
      const failed = await writeRuleChanges(buffer.base, buffer.working, target, buffer.sheetIndex);
      if (failed !== null) return failed;
    }
    return null;
  };
  try {
    return await runInUndoTransaction("Conditional Formatting Rules Manager", run);
  } catch (err) {
    return reasonOf(err);
  }
}

/** One buffer's writes, inside the caller's undo transaction. */
async function writeRuleChanges(
  base: readonly ConditionalFormatDefinition[],
  working: readonly ConditionalFormatDefinition[],
  target: CellTargetRef | undefined,
  sheetIndex: number | undefined,
): Promise<string | null> {
  {
    const kept = new Set(working.map((r) => r.id));
    for (const old of base) {
      if (!kept.has(old.id)) await deleteConditionalFormat(old.id, { target, sheetIndex });
    }
    const ids = new Map<number, number>();
    // Added bottom-first: the backend puts a new rule on top, so the final
    // order below is the only order that matters.
    for (const rule of [...working].reverse()) {
      if (rule.id >= 0) continue;
      const added = await addConditionalFormat(
        { rule: rule.rule, format: { ...rule.format }, ranges: rule.ranges.map((g) => ({ ...g })), stopIfTrue: rule.stopIfTrue },
        { target, sheetIndex },
      );
      if (!added || added.success === false || !added.rule) {
        return added?.error || "the backend refused a new rule";
      }
      ids.set(rule.id, added.rule.id);
      if (!rule.enabled) await updateConditionalFormat({ ruleId: added.rule.id, enabled: false }, { target, sheetIndex });
    }
    for (const rule of working) {
      if (rule.id < 0) continue;
      const old = base.find((r) => r.id === rule.id);
      if (!old) continue;
      const change: UpdateCFParams = { ruleId: rule.id };
      if (!same(old.rule, rule.rule)) change.rule = rule.rule;
      if (!same(old.format, rule.format)) change.format = rule.format;
      if (!same(old.ranges, rule.ranges)) change.ranges = rule.ranges;
      if (old.stopIfTrue !== rule.stopIfTrue) change.stopIfTrue = rule.stopIfTrue;
      if (old.enabled !== rule.enabled) change.enabled = rule.enabled;
      if (Object.keys(change).length === 1) continue;
      const result = await updateConditionalFormat(change, { target, sheetIndex });
      if (result && result.success === false) return result.error || "the backend refused a change";
    }
    const order = working.map((r) => (r.id < 0 ? ids.get(r.id)! : r.id));
    const landed = base.filter((r) => kept.has(r.id)).map((r) => r.id);
    const addedAny = ids.size > 0;
    if (addedAny || !same(order, landed)) {
      const result = await reorderConditionalFormats(order, { target, sheetIndex });
      if (result && result.success === false) return result.error || "the backend refused the order";
    }
    return null;
  }
}

/** The buffer a scope edits: the active sheet's (Current Selection and This Worksheet share it) or another sheet's. */
function bufferKey(scope: Scope): string {
  return scope.kind === "other" ? `sheet:${scope.sheetIndex}` : "active";
}

// ============================================================================
// Component
// ============================================================================

export const RulesManagerDialog: React.FC<DialogProps> = ({
  isOpen,
  onClose,
  data,
}) => {
  // BUFFERED, as Excel's Manager is (lane cfdvfix): every change -- New Rule,
  // Edit Rule, Delete, Duplicate, the order, Applies To, Stop If True, the
  // enabled box -- edits `working`; Apply writes the difference from `base`
  // as ONE undo step, OK applies and closes, Cancel closes writing nothing.
  const [base, setBase] = useState<ConditionalFormatDefinition[]>([]);
  const [working, setWorking] = useState<ConditionalFormatDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Applies To being typed, per rule id (taken on Enter or leaving the box).
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sub, setSub] = useState<SubDialog>(null);
  const [busy, setBusy] = useState(false);
  const nextNewId = useRef(-1);
  // The scope (P3): a floating grid's rules, or the active sheet's.
  const target = data?.target as CellTargetRef | undefined;
  const scopeLabel = (data?.scopeLabel as string | undefined) ?? (target ? "This floating grid" : "This sheet");
  // The selection New Rule... is for (Excel's: the selected cells).
  const selection = (data?.selection as ConditionalFormatRange | null | undefined) ?? null;
  const activeCell = (data?.activeCell as { row: number; col: number } | null | undefined) ?? null;
  // "Show formatting rules for": Excel opens on Current Selection.
  const [scope, setScope] = useState<Scope>(() => (selection && !target ? { kind: "selection" } : { kind: "sheet" }));
  const [otherSheets, setOtherSheets] = useState<Array<{ index: number; name: string }>>([]);
  // The buffers of the sheets the scope has LEFT, by `bufferKey`: each keeps
  // its changes until OK / Apply writes them all, or Cancel drops them.
  const parked = useRef(new Map<string, { base: ConditionalFormatDefinition[]; working: ConditionalFormatDefinition[] }>());
  // The name an Applies To may prefix its references with: the shown sheet's.
  const activeName = target
    ? (data?.objectName as string | undefined)
    : getGridStateSnapshot()?.sheetContext?.activeSheetName;
  const sheetName = scope.kind === "other" ? scope.name : activeName;
  const separator = listSeparator() || ",";

  /** Read the scope's rules into both the base and the buffer. */
  const reload = useCallback(
    async (next?: ConditionalFormatDefinition[]) => {
      const rules = next ?? (await readRules(target));
      setBase(rules);
      setWorking(rules);
      setDrafts({});
    },
    [target],
  );

  // Load rules when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    setSelectedId(null);
    setDrafts({});
    setRefusal(null);
    setSub(null);
    setScope(selection && !target ? { kind: "selection" } : { kind: "sheet" });
    parked.current.clear();
    readRules(target)
      .then((next) => {
        if (!live) return;
        setBase(next);
        setWorking(next);
      })
      .catch((err) => {
        console.error("[ConditionalFormatting] reading the rules failed:", err);
        if (live) {
          setBase([]);
          setWorking([]);
        }
      });
    // The other worksheets "Show formatting rules for" offers.
    if (!target) {
      getSheets()
        .then((sheets) => {
          if (!live) return;
          const active = getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? sheets.activeIndex;
          setOtherSheets(sheets.sheets.filter((s) => s.index !== active).map((s) => ({ index: s.index, name: s.name })));
        })
        .catch(() => {
          if (live) setOtherSheets([]);
        });
    }
    return () => {
      live = false;
    };
    // `selection` is read once per opening, as the dialog's other data is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, target]);

  const handleClose = useCallback(() => {
    onClose();
    restoreFocusToGrid();
  }, [onClose]);

  // Applies To typed but not yet taken (Enter or leaving the box) counts.
  const withDrafts = useCallback((): { rules: ConditionalFormatDefinition[]; refused: string | null } => {
    let refused: string | null = null;
    const rules = working.map((rule) => {
      const draft = drafts[rule.id];
      if (draft === undefined || draft.trim() === describeAppliesTo(rule.ranges, separator)) return rule;
      const parsed = parseAppliesTo(draft, sheetName);
      if (!parsed.ok) {
        refused = refused ?? parsed.message;
        return rule;
      }
      return { ...rule, ranges: parsed.ranges };
    });
    return { rules, refused };
  }, [working, drafts, separator, sheetName]);

  /**
   * "Show formatting rules for" moved: the shown sheet's buffer (its Applies
   * To drafts taken) is parked, and the chosen sheet's comes back -- as it
   * was left, or read now.
   */
  const switchScope = useCallback(
    async (next: Scope) => {
      const { rules, refused } = withDrafts();
      if (refused !== null) {
        setRefusal(refused);
        return;
      }
      setSelectedId(null);
      const from = bufferKey(scope);
      const to = bufferKey(next);
      if (from === to) {
        setWorking(rules);
        setDrafts({});
        setScope(next);
        return;
      }
      parked.current.set(from, { base, working: rules });
      let loaded = parked.current.get(to);
      if (!loaded) {
        let read: ConditionalFormatDefinition[] = [];
        try {
          read = next.kind === "other" ? [...(await getAllConditionalFormats(next.sheetIndex, { target }))] : await readRules(target);
        } catch (err) {
          console.error("[ConditionalFormatting] reading the rules failed:", err);
        }
        loaded = { base: read, working: read };
      }
      parked.current.delete(to);
      setBase(loaded.base);
      setWorking(loaded.working);
      setDrafts({});
      setRefusal(null);
      setScope(next);
    },
    [withDrafts, scope, base, target],
  );

  /** APPLY: every sheet's buffer written as one undo step, then read back. */
  const apply = useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    const { rules, refused } = withDrafts();
    if (refused !== null) {
      setRefusal(refused);
      return false;
    }
    setBusy(true);
    setRefusal(null);
    const buffers: RuleBuffer[] = [{ base, working: rules, sheetIndex: scope.kind === "other" ? scope.sheetIndex : undefined }];
    for (const [key, buffer] of parked.current) {
      buffers.push({ ...buffer, sheetIndex: key === "active" ? undefined : Number(key.slice("sheet:".length)) });
    }
    const failed = await applyRuleBuffers(buffers, target);
    // Every parked sheet is read afresh when the scope comes back to it.
    parked.current.clear();
    let fresh: ConditionalFormatDefinition[] | undefined;
    try {
      fresh = await rulesAfterWrite(target);
      if (scope.kind === "other") fresh = [...(await getAllConditionalFormats(scope.sheetIndex, { target }))];
    } catch (err) {
      console.error("[ConditionalFormatting] reading the rules failed:", err);
    }
    await reload(fresh).catch(() => undefined);
    setBusy(false);
    if (failed !== null) {
      setRefusal(`Not every change was applied: ${failed}`);
      return false;
    }
    return true;
  }, [busy, withDrafts, base, scope, target, reload]);

  const handleOk = useCallback(async () => {
    if (await apply()) handleClose();
  }, [apply, handleClose]);

  const handleDelete = useCallback(() => {
    if (selectedId == null) return;
    setWorking((rules) => rules.filter((r) => r.id !== selectedId));
    setSelectedId(null);
  }, [selectedId]);

  /** DUPLICATE RULE: a copy right after the rule (Excel [LIVE, lane uimisc probe3]). */
  const handleDuplicate = useCallback(() => {
    const at = working.findIndex((r) => r.id === selectedId);
    if (at < 0) return;
    const id = nextNewId.current--;
    const original = working[at];
    const copy: ConditionalFormatDefinition = {
      ...original,
      id,
      rule: JSON.parse(JSON.stringify(original.rule)),
      format: { ...original.format },
      ranges: original.ranges.map((g) => ({ ...g })),
    };
    setWorking((rules) => [...rules.slice(0, at + 1), copy, ...rules.slice(at + 1)]);
    setSelectedId(id);
  }, [working, selectedId]);

  const move = useCallback(
    (by: -1 | 1) => {
      if (selectedId == null) return;
      setWorking((rules) => {
        const idx = rules.findIndex((r) => r.id === selectedId);
        const to = idx + by;
        if (idx < 0 || to < 0 || to >= rules.length) return rules;
        const next = [...rules];
        [next[idx], next[to]] = [next[to], next[idx]];
        return next;
      });
    },
    [selectedId],
  );

  const toggle = useCallback((ruleId: number, field: "stopIfTrue" | "enabled") => {
    setWorking((rules) => rules.map((r) => (r.id === ruleId ? { ...r, [field]: !r[field] } : r)));
  }, []);

  /** APPLIES TO, edited: read what was typed into the rule's ranges (written on Apply). */
  const commitAppliesTo = useCallback(
    (rule: ConditionalFormatDefinition) => {
      const draft = drafts[rule.id];
      if (draft === undefined) return;
      const shown = describeAppliesTo(rule.ranges, separator);
      if (draft.trim() === shown) {
        setDrafts(({ [rule.id]: _gone, ...rest }) => rest);
        return;
      }
      const parsed = parseAppliesTo(draft, sheetName);
      if (!parsed.ok) {
        setRefusal(parsed.message);
        return;
      }
      setRefusal(null);
      setWorking((rules) => rules.map((r) => (r.id === rule.id ? { ...r, ranges: parsed.ranges } : r)));
      setDrafts(({ [rule.id]: _gone, ...rest }) => rest);
    },
    [drafts, separator, sheetName],
  );

  /** New Rule / Edit Rule handed its rule over: into the buffer. */
  const onBuilt = useCallback(
    (built: BuiltCfRule) => {
      if (sub?.kind === "edit") {
        const id = sub.rule.id;
        setWorking((rules) => rules.map((r) => (r.id === id ? { ...r, rule: built.rule, format: built.format } : r)));
        return;
      }
      const id = nextNewId.current--;
      const rule: ConditionalFormatDefinition = {
        id,
        priority: 0,
        rule: built.rule,
        format: built.format,
        ranges: built.ranges ?? [],
        stopIfTrue: false,
        enabled: true,
      } as ConditionalFormatDefinition;
      // A new rule goes on top, as Excel's does.
      setWorking((rules) => [rule, ...rules]);
      setSelectedId(id);
    },
    [sub],
  );

  if (!isOpen) return null;

  const shownRules =
    scope.kind === "selection" && selection
      ? working.filter((r) => r.id < 0 || r.ranges.some((g) => intersects(g, selection)))
      : working;
  const selectedRule = working.find((r) => r.id === selectedId) ?? null;
  const scopeValue = scope.kind === "other" ? `sheet:${scope.sheetIndex}` : scope.kind;

  return (
    <div
      style={overlayStyle}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        style={dialogStyle}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Conditional Formatting Rules Manager"
      >
        <h3 style={titleStyle}>Conditional Formatting Rules Manager</h3>
        {target ? (
          <p style={scopeStyle} data-cf-rules-scope>
            Showing formatting rules for: {scopeLabel}
          </p>
        ) : (
          <label style={{ ...scopeStyle, display: "flex", alignItems: "center", gap: 6 }} data-cf-rules-scope>
            Show formatting rules for:
            <select
              style={{ ...appliesInputStyle, flex: "0 1 auto" }}
              value={scopeValue}
              data-cf-scope-select
              onChange={(e) => {
                const v = e.target.value;
                if (v === "selection" || v === "sheet") {
                  void switchScope({ kind: v });
                  return;
                }
                const index = Number(v.slice("sheet:".length));
                const other = otherSheets.find((s) => s.index === index);
                if (other) void switchScope({ kind: "other", sheetIndex: other.index, name: other.name });
              }}
            >
              {selection && <option value="selection">Current Selection</option>}
              <option value="sheet">This Worksheet</option>
              {otherSheets.map((s) => (
                <option key={s.index} value={`sheet:${s.index}`}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Toolbar: Excel's buttons, in Excel's order */}
        <div style={toolbarStyle}>
          <button
            style={toolButtonStyle}
            onClick={() => setSub({ kind: "new" })}
            // New Rule is for the selected cells, which are the active sheet's.
            disabled={scope.kind === "other" || !selection}
            data-cf-manager-action="new"
          >
            New Rule...
          </button>
          <button
            style={toolButtonStyle}
            onClick={() => selectedRule && setSub({ kind: "edit", rule: selectedRule })}
            disabled={selectedRule == null}
            data-cf-manager-action="edit"
          >
            Edit Rule...
          </button>
          <button
            style={{
              ...toolButtonStyle,
              color: selectedRule != null ? DT.errorFg : DT.buttonText,
            }}
            onClick={handleDelete}
            disabled={selectedRule == null}
            data-cf-manager-action="delete"
          >
            Delete Rule
          </button>
          <button
            style={toolButtonStyle}
            onClick={handleDuplicate}
            disabled={selectedRule == null}
            data-cf-manager-action="duplicate"
          >
            Duplicate Rule
          </button>
          <button
            style={toolButtonStyle}
            onClick={() => move(-1)}
            disabled={selectedRule == null}
            data-cf-manager-action="up"
          >
            Move Up
          </button>
          <button
            style={toolButtonStyle}
            onClick={() => move(1)}
            disabled={selectedRule == null}
            data-cf-manager-action="down"
          >
            Move Down
          </button>
        </div>

        {/* Rules list */}
        <div style={listStyle}>
          {shownRules.length === 0 && (
            <div
              style={{
                padding: 16,
                textAlign: "center",
                color: DT.textSecondary,
                fontSize: 13,
              }}
            >
              {target
                ? "No conditional formatting rules in this floating grid."
                : scope.kind === "selection"
                  ? "No conditional formatting rules for the selected cells."
                  : "No conditional formatting rules on this sheet."}
            </div>
          )}
          {shownRules.map((rule) => (
            <div
              key={rule.id}
              style={selectedId === rule.id ? selectedRowStyle : ruleRowStyle}
              onClick={() => setSelectedId(rule.id)}
              onDoubleClick={() => setSub({ kind: "edit", rule })}
              data-cf-rule-id={rule.id}
            >
              {/* Enabled checkbox */}
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={() => toggle(rule.id, "enabled")}
                onClick={(e) => e.stopPropagation()}
                title="Enable/Disable"
              />

              {/* Format preview swatch: colour DATA (the rule's look), not chrome. */}
              <div
                data-colour-data
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 3,
                  border: `1px solid ${DT.divider}`,
                  backgroundColor: rule.format.backgroundColor || "#fff",
                  flexShrink: 0,
                }}
              />

              {/* Rule description and Applies To */}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  opacity: rule.enabled ? 1 : 0.5,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <div
                  style={{
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {describeRule(rule)}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: DT.textSecondary }}>
                  Applies to
                  <input
                    type="text"
                    style={appliesInputStyle}
                    value={drafts[rule.id] ?? describeAppliesTo(rule.ranges, separator)}
                    aria-label="Applies to"
                    data-cf-applies-to={rule.id}
                    onClick={(e) => e.stopPropagation()}
                    onFocus={() => setSelectedId(rule.id)}
                    onChange={(e) => {
                      const text = e.target.value;
                      setDrafts((d) => ({ ...d, [rule.id]: text }));
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitAppliesTo(rule);
                      if (e.key === "Escape") setDrafts(({ [rule.id]: _gone, ...rest }) => rest);
                    }}
                    onBlur={() => commitAppliesTo(rule)}
                  />
                </label>
              </div>

              {/* Stop if True checkbox */}
              <label
                style={{ fontSize: 11, color: DT.textSecondary, whiteSpace: "nowrap" }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={rule.stopIfTrue}
                  onChange={() => toggle(rule.id, "stopIfTrue")}
                />
                Stop
              </label>
            </div>
          ))}
        </div>

        {refusal !== null && (
          <div role="alert" style={errorStyle}>
            {refusal}
          </div>
        )}

        {/* Footer: Excel's OK, Cancel and Apply */}
        <div style={buttonRowStyle}>
          <button style={primaryButtonStyle} onClick={() => void handleOk()} disabled={busy} data-cf-manager-action="ok">
            OK
          </button>
          <button style={toolButtonStyle} onClick={handleClose} data-cf-manager-action="cancel">
            Cancel
          </button>
          <button style={toolButtonStyle} onClick={() => void apply()} disabled={busy} data-cf-manager-action="apply">
            Apply
          </button>
        </div>
      </div>

      {/* New Rule / Edit Rule, over the Manager (Excel's dialogs open on top of it). */}
      {sub && (
        <NewRuleDialog
          isOpen
          onClose={() => setSub(null)}
          data={{
            selection,
            activeCell,
            nested: true,
            onBuilt,
            ...(target ? { target } : {}),
            ...(sub.kind === "edit" ? { editRule: sub.rule } : {}),
          }}
        />
      )}
    </div>
  );
};
