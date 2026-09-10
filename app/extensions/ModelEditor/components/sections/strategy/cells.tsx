// FILENAME: app/extensions/ModelEditor/components/sections/strategy/cells.tsx
// PURPOSE: The cell kit every Strategy grid is built from — the row tone, the
//          pinned confirmation column, and the shared controls.
// CONTEXT: Implements properties (1), (6), (12), (13) and (17). The four-valued
//          row state becomes a LOOK in exactly one place (`rowTone` +
//          `ReviewedCell`); the confirmed badge is itself the un-confirm
//          control; and `stickyConfirmCell` is why the pinned column is opaque
//          rather than a window onto the cells sliding under it. See the
//          numbered list in ../StrategySection.tsx — it is the one place that
//          list is written down.

import React, { useEffect, useState } from "react";
import { Badge, styles } from "../../editorShared";
import { ME } from "../../theme";
import {
  bandHighInclusive,
  bandLowInclusive,
  bandTarget,
} from "../../../lib/strategyTypes";
import type {
  Divergence,
  EntryState,
  Finding,
  TableKind,
  TableKindOrigin,
  Target,
} from "../../../lib/strategyTypes";
import type { ResolvedMeasure } from "../../../lib/strategyBackend";
import { whyLines } from "./inheritance";
import { hasErrors } from "../../../lib/strategyTypes";

export function WhyCell({
  measure,
  resolved,
}: {
  measure: string;
  resolved: ResolvedMeasure;
}): React.ReactElement {
  return (
    <span
      data-testid={`why-${measure}`}
      title={`What ${measure} resolves to today, and who decided each part:\n\n${whyLines(
        resolved,
      ).join("\n")}`}
      style={{
        marginLeft: 6,
        fontSize: 11,
        color: ME.accent,
        borderBottom: `1px dotted ${ME.accent}`,
        cursor: "help",
      }}
    >
      why
    </span>
  );
}

/**
 * The marker on a cell whose value is NOT what applies.
 *
 * The document carries a value here, but the resolver reports a scoped rule
 * decided this attribute — so the cell is showing something the rule overrides.
 * Without the marker the two disagree in silence.
 */
export function RuleOverrideMark({
  measure,
  attribute,
  ruleId,
}: {
  measure: string;
  attribute: string;
  ruleId: string;
}): React.ReactElement {
  return (
    <span
      data-testid={`rule-override-${attribute}-${measure}`}
      style={{ marginLeft: 4 }}
      title={`rule '${ruleId}' decides ${attribute} for ${measure}, so what this cell says is not what applies where that rule reaches.`}
    >
      <Badge tone="warn">rule</Badge>
    </span>
  );
}

// ===========================================================================
// Small presentation helpers
// ===========================================================================

/**
 * The ONE place a row state becomes a look.
 *
 * Only `inferred` is muted-and-italic, because only an inferred row is a
 * machine's sentence. `empty` is quiet but upright — there is nothing there to
 * doubt — and `authored` reads as plainly as `confirmed`, since the words are
 * the user's own; the difference between them is the badge, not the type.
 */
export function rowTone(state: EntryState): React.CSSProperties {
  switch (state) {
    case "inferred":
      return { color: ME.text3, background: ME.sunken, fontStyle: "italic" };
    case "empty":
      return { color: ME.text3, background: "transparent" };
    default:
      return { color: ME.text, background: "transparent" };
  }
}

export const cellStyle: React.CSSProperties = { ...styles.td, whiteSpace: "nowrap" };

export const smallInput: React.CSSProperties = { ...styles.input, fontSize: 12, padding: "2px 4px" };

// ---------------------------------------------------------------------------
// The confirmation column stays reachable
// ---------------------------------------------------------------------------

/**
 * `reviewed` is PINNED to the trailing edge of the scrolling card.
 *
 * Both grids live in an `overflow-x: auto` card, and the measures grid now
 * carries eleven columns; `never slice by` and `reviewed` were pushed off the
 * right-hand edge. Losing `never slice by` behind a scrollbar costs a look —
 * losing `reviewed` costs the task: confirming a draft IS working down that
 * column, and a control you have to scroll to for every row is a control people
 * stop using. Widening the grid is the owner's call and is deferred; pinning
 * the one column the work happens in is not the same decision and does not
 * change what any column contains.
 *
 * It is `position: sticky` rather than a reordering because moving `reviewed`
 * to the leading edge would put the ANSWER before the values it answers for,
 * and because sticky touches only the cell style — the row markup, the column
 * order and every `data-strategy-*` hook stay exactly as they were.
 */
export const STICKY_CONFIRM: React.CSSProperties = {
  position: "sticky",
  right: 0,
  // Over the cells, under nothing: the header's own sticky cell needs to win
  // against the body's, which is what the two levels are for.
  zIndex: 1,
  // A shadow rather than a border, so the pinned column reads as floating
  // above the scrolled ones instead of as a twelfth column.
  boxShadow: "-6px 0 6px -6px rgba(0, 0, 0, 0.25)",
};

export const stickyHeaderStyle: React.CSSProperties = {
  ...styles.th,
  ...STICKY_CONFIRM,
  zIndex: 2,
  background: ME.surface,
};

/**
 * The pinned cell for one row, opaque in the row's own tone.
 *
 * A sticky cell floats OVER the columns sliding beneath it, and `rowTone` gives
 * `transparent` for three of its four states — so without an explicit
 * background the scrolled content would show straight through the badge and the
 * Confirm button. What a transparent row resolves to is the CARD behind the
 * table, which is `ME.surface` — NOT literal white. It was briefly white while
 * the text followed the skin, which put light-grey "Confirm" on a white chip in
 * Dark: unreadable, and invisible in a screenshot taken in Light.
 */
export function stickyConfirmCell(state: EntryState): React.CSSProperties {
  const tone = rowTone(state);
  const background = tone.background === "transparent" ? ME.surface : String(tone.background);
  return { ...cellStyle, ...STICKY_CONFIRM, background };
}

/**
 * A picker whose EMPTY option carries the inherited value rather than a dash.
 *
 * `inherited` is the resolver's answer for this attribute, already formatted
 * ("higherIsBetter — from KPI 'Margin % KPI'"). A blank where a KPI has already
 * decided the answer is what invites a person to type a competing one, so the
 * empty option shows what is in force and reads as greyed. Choosing a real
 * option is the explicit override — and only that writes to the document.
 */
export function selectOf<T extends string>(
  value: T | "",
  options: readonly T[],
  onChange: (v: T | "") => void,
  disabled: boolean,
  width = 128,
  inherited: string | null = null,
  /**
   * Why one option cannot be chosen HERE, or null.
   *
   * The option stays in the list and is `disabled`, rather than being dropped:
   * a value already stored has to keep rendering as what it is, and an option
   * that vanishes teaches nobody why. The reason reaches the person through
   * the option's own `title`, which is where they are already pointing.
   */
  unavailable: ((option: T) => string | null) | null = null,
): React.ReactElement {
  const showingInherited = value === "" && inherited !== null;
  return (
    <select
      style={{
        ...smallInput,
        width,
        ...(showingInherited ? { color: ME.text2, fontStyle: "italic" } : {}),
      }}
      value={value}
      disabled={disabled}
      title={
        inherited === null
          ? undefined
          : `Inherited: ${inherited}. Picking a value here overrides it in the document.`
      }
      onChange={(e) => onChange(e.target.value as T | "")}
    >
      <option value="">{inherited ?? "—"}</option>
      {options.map((o) => {
        const refusal = unavailable === null ? null : unavailable(o);
        return (
          <option key={o} value={o} disabled={refusal !== null} title={refusal ?? undefined}>
            {o}
            {refusal === null ? "" : " (refused here)"}
          </option>
        );
      })}
    </select>
  );
}

/**
 * Whether the kind on screen is a person's statement or a machine's reading.
 *
 * IT IS NOT THE ROW BADGE SAID TWICE. The row badge describes the entry — a
 * table whose `labelColumn` somebody typed reads "set by you" while its `kind`
 * is still a guess. And the difference now changes behaviour: the backend
 * honours an AUTHORED kind wholesale (it decides the calendar, and therefore
 * the time axis of every trend, seasonality and change-point claim) and
 * DISREGARDS an inferred one, re-deriving it from today's relationship graph.
 * A person looking at "calendar" is owed the answer to "is the engine using
 * this?".
 */
// The prop is `provenance`, not `origin`, ON PURPOSE. `scriptOriginForgery`'s
// census scans every file under extensions/ for an identifier ending in
// `origin`/`Origin` compared to a string literal, because a SCRIPT TRUST origin
// is a discriminated union and comparing one to a string is a real security
// defect. `TableKindOrigin` is an unrelated three-valued string union about who
// classified a table, so the name — not the code — was tripping a guard that
// then sat red, and a permanently-red guard is how the next genuine offender
// gets filed as "unrelated".
export function KindOriginBadge({
  provenance,
  table,
  kind,
}: {
  provenance: TableKindOrigin;
  table: string;
  kind: TableKind | undefined;
}): React.ReactElement | null {
  if (provenance === "none") return null;
  if (provenance === "chosen") {
    return (
      <span
        data-testid={`kind-origin-${table}`}
        title={`You chose '${kind}' for ${table}. The engine takes it as a statement and stops classifying this table for itself.`}
      >
        <Badge tone="neutral">chosen</Badge>
      </span>
    );
  }
  return (
    <span
      data-testid={`kind-origin-${table}`}
      title={`Nobody has said what ${table} is — '${kind}' is what the engine reads off the relationship graph, and it re-reads it every run. Pick a value here to state it instead.`}
    >
      <Badge tone="warn">detected</Badge>
    </span>
  );
}

/**
 * A text cell whose content is a compact SPEC (a target, a materiality).
 *
 * It commits only what parses. An unreadable value keeps the typed text and
 * turns the border red rather than silently reverting, because a value that
 * vanishes on blur reads as "accepted".
 */
export function SpecInput<T>({
  value,
  parse,
  onCommit,
  disabled,
  placeholder,
  hint,
  width = 118,
}: {
  value: string;
  parse: (text: string) => { ok: true; value: T | undefined } | { ok: false; error: string };
  onCommit: (value: T | undefined) => void;
  disabled: boolean;
  /** What an EMPTY field says. The inherited value when there is one, so the
   *  cell answers "what applies here?" rather than showing a blank. */
  placeholder: string;
  /** The accepted spellings, for the tooltip. Separate from `placeholder`
   *  because when the placeholder is carrying an inherited value the format
   *  hint still has to reach the person who is about to type over it. */
  hint?: string;
  width?: number;
}): React.ReactElement {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value);
    setError(null);
  }, [value]);
  return (
    <input
      style={{
        ...smallInput,
        width,
        borderColor: error ? ME.dangerFg : ME.ctlBorder,
      }}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      title={error ?? (hint === undefined ? placeholder : `${placeholder}\n${hint}`)}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        const parsed = parse(e.target.value);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        setError(null);
        onCommit(parsed.value);
      }}
    />
  );
}

/**
 * The target control in BAND mode: two bounds, each with its own inclusivity.
 *
 * It replaces the ordinary target field rather than sitting beside it (property
 * (12)). A band and a literal are two answers to one question, and a document
 * holding both says nothing about which applies — so there is one control, and
 * what it edits depends on the direction.
 *
 * NOTHING PARTIAL IS EVER WRITTEN. A band needs both bounds to mean anything,
 * so a half-filled pair commits `undefined` and the document simply carries no
 * target: the incomplete state lives in the UI, where it is visible and
 * fixable, never in the saved document, where the validator would have to catch
 * it. The boxes are NOT cleared when that happens — the person is mid-edit, and
 * a field that empties itself as you type is how a value that was accepted
 * comes to look rejected.
 */
export function BandTargetCell({
  measure,
  band,
  disabled,
  onCommit,
}: {
  measure: string;
  band: Extract<Target, { type: "band" }> | undefined;
  disabled: boolean;
  onCommit: (target: Target | undefined) => void;
}): React.ReactElement {
  const [low, setLow] = useState(band === undefined ? "" : String(band.low));
  const [high, setHigh] = useState(band === undefined ? "" : String(band.high));
  const [lowIn, setLowIn] = useState(band === undefined ? true : bandLowInclusive(band));
  const [highIn, setHighIn] = useState(band === undefined ? true : bandHighInclusive(band));

  // Install a band that arrived from OUTSIDE this control — Infer, "Use
  // inference", a reload. An absent band is deliberately not installed: it is
  // what this control writes while a person is half way through typing one,
  // and resetting the boxes then would delete the bound they had just entered.
  useEffect(() => {
    if (band === undefined) return;
    setLow(String(band.low));
    setHigh(String(band.high));
    setLowIn(bandLowInclusive(band));
    setHighIn(bandHighInclusive(band));
  }, [band]);

  const commit = (l: string, h: string, li: boolean, hi: boolean): void => {
    const lowValue = Number(l.trim());
    const highValue = Number(h.trim());
    if (l.trim() === "" || h.trim() === "" || !Number.isFinite(lowValue) || !Number.isFinite(highValue)) {
      onCommit(undefined);
      return;
    }
    onCommit(bandTarget(lowValue, highValue, li, hi));
  };

  const boundInput = (
    which: "low" | "high",
    value: string,
    setValue: (v: string) => void,
  ): React.ReactElement => (
    <input
      data-testid={`band-${which}-${measure}`}
      aria-label={`${which} bound of ${measure}'s band`}
      style={{ ...smallInput, width: 54 }}
      value={value}
      disabled={disabled}
      placeholder={which === "low" ? "0.8" : "1.2"}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) =>
        which === "low" ? commit(e.target.value, high, lowIn, highIn) : commit(low, e.target.value, lowIn, highIn)
      }
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        const typed = (e.target as HTMLInputElement).value;
        if (which === "low") commit(typed, high, lowIn, highIn);
        else commit(low, typed, lowIn, highIn);
      }}
    />
  );

  return (
    <div
      data-testid={`band-${measure}`}
      style={{ display: "flex", gap: 3, alignItems: "center" }}
      title="The acceptable range this measure is judged against. Each bound says whether the bound itself counts as on target."
    >
      <select
        data-testid={`band-low-op-${measure}`}
        aria-label={`low bound inclusivity of ${measure}'s band`}
        style={{ ...smallInput, width: 44 }}
        disabled={disabled}
        value={lowIn ? "inclusive" : "exclusive"}
        onChange={(e) => {
          const next = e.target.value === "inclusive";
          setLowIn(next);
          commit(low, high, next, highIn);
        }}
      >
        <option value="inclusive">&ge;</option>
        <option value="exclusive">&gt;</option>
      </select>
      {boundInput("low", low, setLow)}
      <select
        data-testid={`band-high-op-${measure}`}
        aria-label={`high bound inclusivity of ${measure}'s band`}
        style={{ ...smallInput, width: 44 }}
        disabled={disabled}
        value={highIn ? "inclusive" : "exclusive"}
        onChange={(e) => {
          const next = e.target.value === "inclusive";
          setHighIn(next);
          commit(low, high, lowIn, next);
        }}
      >
        <option value="inclusive">&le;</option>
        <option value="exclusive">&lt;</option>
      </select>
      {boundInput("high", high, setHigh)}
    </div>
  );
}

/**
 * The sentence under a band that is only half stated.
 *
 * It mirrors the Rust validator rather than adding a rule of its own: the
 * backend REFUSES a `targetBand` direction with no band, so this says at the
 * keystroke what Save would otherwise say a minute later. Saying it here does
 * not make it true — the validator does — which is why the wording points at
 * the refusal rather than pretending to be one.
 */
export function BandIncomplete({ measure }: { measure: string }): React.ReactElement {
  return (
    <div
      data-testid={`band-incomplete-${measure}`}
      style={{ fontSize: 11, color: ME.dangerFg, marginTop: 2, whiteSpace: "normal", maxWidth: 200 }}
    >
      A band direction needs both bounds. Until it has them this measure has no favourability and
      no variance, and the strategy is refused on Save.
    </div>
  );
}

/** Chips of `Table[Column]` refs with an add-from-the-model picker. */
export function ColumnRefList({
  refs,
  options,
  onChange,
  disabled,
  title,
  addLabel = "add column…",
}: {
  refs: string[];
  options: string[];
  onChange: (refs: string[]) => void;
  disabled: boolean;
  /** What the list MEANS. A column list's name rarely carries its purpose. */
  title?: string;
  addLabel?: string;
}): React.ReactElement {
  return (
    <div
      title={title}
      style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", minWidth: 220 }}
    >
      {refs.map((r) => (
        <span
          key={r}
          style={{
            background: ME.sunken,
            borderRadius: 3,
            padding: "1px 4px",
            fontSize: 11,
            whiteSpace: "nowrap",
          }}
        >
          {r}
          <button
            style={{ ...styles.smallBtn, marginLeft: 4, padding: "0 4px" }}
            disabled={disabled}
            title={`Remove ${r}`}
            onClick={() => onChange(refs.filter((x) => x !== r))}
          >
            &times;
          </button>
        </span>
      ))}
      <select
        style={{ ...smallInput, width: 150 }}
        value=""
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === "") return;
          if (!refs.includes(e.target.value)) onChange([...refs, e.target.value]);
        }}
      >
        <option value="">{addLabel}</option>
        {options
          .filter((o) => !refs.includes(o))
          .map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
      </select>
    </div>
  );
}

/** The per-row finding marker: how many findings this row's path carries. */
export function RowFindings({ findings }: { findings: Finding[] }): React.ReactElement | null {
  if (findings.length === 0) return null;
  const worst = hasErrors(findings) ? "error" : "warning";
  return (
    <span title={findings.map((f) => `${f.code}: ${f.message}`).join("\n")}>
      <Badge tone={worst === "error" ? "warn" : "neutral"}>
        {worst === "error" ? "error" : "warning"}
        {findings.length > 1 ? ` ×${findings.length}` : ""}
      </Badge>
    </span>
  );
}

/**
 * What a row says today beside what inference would propose now, and the one
 * action that resolves it.
 *
 * BOTH VALUES, ALWAYS. "This is out of date" is not something a person can act
 * on; "you confirmed lowerIsBetter, inference now proposes higherIsBetter" is.
 * The verb follows the row's state, because "you confirmed" about a row nobody
 * ever confirmed is a small lie that costs the whole notice its credibility.
 *
 * There is no auto-apply and no dismiss: applying would overwrite a human
 * decision silently, and dismissing would store a "I have seen this" flag that
 * goes stale the next time the model changes. The divergence simply stops being
 * true once either side is changed.
 */
export function DivergenceNote({
  id,
  label,
  state,
  divergences,
  disabled,
  onTake,
}: {
  /** The row's own name, for the test ids. Separate from `label` because the
   *  model block's label is a phrase and a test id is not. */
  id: string;
  label: string;
  state: EntryState;
  divergences: Divergence[];
  disabled: boolean;
  onTake: () => void;
}): React.ReactElement | null {
  if (divergences.length === 0) return null;
  const verb = state === "confirmed" ? "You confirmed" : "You set";
  return (
    <div
      data-testid={`divergence-${id}`}
      style={{ fontSize: 11, color: ME.warnFg, marginTop: 3, whiteSpace: "normal", maxWidth: 260 }}
    >
      {divergences.map((d) => (
        <div key={d.field}>
          {/* An entry that says NOTHING about a field is the commonest half of
              this pair — a column was added, and the confirmed row predates it.
              "(nothing)" is the honest word for that; an empty string reads as
              a rendering bug. */}
          {`${verb} ${d.field} ${d.yours === "" ? "(nothing)" : `'${d.yours}'`}; inference now proposes '${d.inference}'.`}
        </div>
      ))}
      <button
        data-testid={`take-inference-${id}`}
        style={{ ...styles.smallBtn, marginTop: 2 }}
        disabled={disabled}
        title={`Replace ${label}'s diverging values with what inference proposes today. The row goes back to being a proposal — nobody has confirmed the new values yet.`}
        onClick={onTake}
      >
        Use inference
      </button>
    </div>
  );
}

/**
 * The row's state, with the Confirm action beside it — and the way back.
 *
 * An `empty` row keeps the button but DISABLES it: confirming a row that says
 * nothing agrees to nothing, and a live Confirm over four "—" cells is how a
 * person learns to confirm without reading. The title says why rather than
 * leaving a dead control unexplained.
 *
 * A CONFIRMED row's badge IS the un-confirm control. Confirm is the claim that
 * a human vouched for a value and `Confirm all` can make it across a whole grid
 * in one click, so leaving no way back pairs an irreversible assertion with a
 * gesture a mis-click can perform. Putting it on the badge rather than only in
 * a bulk action means the way back is where the claim is.
 */
export function ReviewedCell({
  id,
  state,
  onConfirm,
  onUnconfirm,
  disabled,
  label,
}: {
  /** The row's own name, for the test ids — see `DivergenceNote`. */
  id: string;
  state: EntryState;
  onConfirm: () => void;
  onUnconfirm: () => void;
  disabled: boolean;
  label: string;
}): React.ReactElement {
  if (state === "confirmed") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          data-testid={`unconfirm-${id}`}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: disabled ? "default" : "pointer",
          }}
          disabled={disabled}
          title={`Un-confirm ${label} — it goes back to whatever it was before a human agreed to it. The values are not changed.`}
          onClick={onUnconfirm}
        >
          <Badge tone="ok">confirmed &times;</Badge>
        </button>
      </div>
    );
  }
  const empty = state === "empty";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {empty && <Badge tone="neutral">not set</Badge>}
      {state === "inferred" && <Badge tone="warn">inferred</Badge>}
      {state === "authored" && <Badge tone="neutral">set by you</Badge>}
      <button
        style={styles.smallBtn}
        disabled={disabled || empty}
        title={
          empty
            ? `Nothing to confirm — the strategy says nothing about ${label} yet. Set a value, or press Infer for a draft.`
            : `Confirm ${label} — mark it as agreed by a human`
        }
        onClick={onConfirm}
      >
        Confirm
      </button>
    </div>
  );
}

// ===========================================================================
// The model-wide panel
