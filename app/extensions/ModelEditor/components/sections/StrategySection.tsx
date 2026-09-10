// FILENAME: app/extensions/ModelEditor/components/sections/StrategySection.tsx
// PURPOSE: The Strategy tab — where a person turns an inferred draft into a
//          strategy they trust. Four views (measures, tables+columns, rules,
//          defaults), a findings strip, and the four actions: Validate, Run
//          tests, Save, Infer.
//
//          THE SHELL AND THE BARREL. The tab was one 4,681-line file; it is now
//          this shell plus fourteen modules in ./strategy/. This file keeps the
//          section component, the view switcher, and the re-exports — every
//          importer outside the folder (ModelEditorApp and three test files)
//          still says "sections/StrategySection", so where a symbol lives is
//          not their problem. `__tests__/strategyLayering.test.ts` asserts both
//          halves: the folder's graph stays acyclic, and nothing outside it
//          reaches past this barrel.
//
//            constants     every shared literal; the LEAF, imports no sibling
//            drafts        the per-connection unsaved draft
//            ruleDraft     the editable shape of a rule, and its round trip
//            bulkConfirm   Confirm all, and the sentence it prints
//            timeAxis      the model-wide axis and the fiscal year start
//            inheritance   reading what the resolver decided, and why
//            cells         the kit every grid is built from
//            tree          disclosure for both trees; the folder header row
//            ModelPanel    the defaults view
//            MeasuresGrid  the measures view, and the aggregation editor
//            TablesGrid    the tables-and-columns view
//            RulesGrid     the rules view
//            RuleModal     the rule editor
//            FindingsStrip the strip, outside the switcher on purpose
//
// CONTEXT: Nineteen properties are the design, not decoration. (This line read
//          "Eleven" for eight properties longer than it was true — if you add
//          one, the count is part of the edit.)
//
//          THE LIST LIVES HERE AND NOWHERE ELSE. Six of the nineteen are
//          invariants over several modules now, and a list split across
//          fourteen files is a list nobody editing one file reads: property
//          (10) went stale for a day while it was still in a single file, and
//          that is the cheap version of the failure. Each module's header names
//          the properties it implements and points back here; none of them
//          quotes the list, and a test asserts they do not.
//
//          (1) THE ROW STATE IS FOUR-VALUED, NOT TWO. `reviewed` alone cannot
//          tell a row nobody has touched from a row a machine guessed, so both
//          rendered identically and every row offered a Confirm button over an
//          empty "—". Confirming nothing is a no-op that teaches people to
//          click Confirm without reading. The state comes from `entryState`
//          (empty | inferred | authored | confirmed) and becomes a look in ONE
//          place (`rowTone` + `ReviewedCell`). `data-unconfirmed` still mirrors
//          `reviewed` exactly — it is a different axis, and tests read both.
//
//          (2) NOTHING WRITES UNTIL SAVE. Every edit lands in local state.
//          Save calls `op: "set"`, and a REFUSED write comes back
//          `{ written: false, findings }` on a RESOLVED promise — so the save
//          handler branches on `written`, never on try/catch. Treating a
//          refusal as a thrown error would report success and discard the
//          reasons in the same breath.
//
//          (3) INFER-FIRST, NEVER A BLANK FORM. A model with no stored
//          strategy opens on the backend's inferred draft (`op: "infer"`, which
//          walks the measure ASTs and the workbook's own usage) so the first
//          view is a draft to correct. It is a DRAFT: nothing is auto-saved,
//          and a stored document is never auto-inferred over or merged into.
//          The tab unmounts on every section switch, so a naive auto-infer on
//          each mount would silently throw away confirmations the user had not
//          saved — `unsavedDrafts` remembers the working draft per connection
//          and is consulted ONLY on the no-stored-document path.
//
//          (4) THE SCOPE EDITOR CANNOT TAKE A TYPED COLUMN NAME. The column is
//          a <select> over the model's own columns, and `buildRuleFromDraft`
//          re-checks every scope column against the model before the rule is
//          accepted. A typo in a scope is not a broken rule — it is a rule that
//          silently NEVER FIRES, which looks exactly like a rule that was never
//          needed.
//
//          (5) INFER DISCARDS. It replaces the draft wholesale, including
//          unconfirmed edits, so it asks first with `confirmAsync` and AWAITS
//          the answer (the Tauri shim returns a Promise; an un-awaited
//          `if (!confirm(...))` tests `!Promise` and never fires).
//
//          (6) AGGREGATION IS PER DIMENSION. Additivity is not a flat enum:
//          headcount is additive over Department and last-value over Date. The
//          cell was a bare <select> that wrote `{ default: v }`, and because
//          `withMeasure` merges shallowly that REPLACED the whole spec and
//          destroyed any `byDimension` map — invisible before it was destroyed,
//          because the cell only ever showed `.default`. No `AggregationSpec`
//          literal is constructed in this file any more; every write goes
//          through `withAggregationDefault` / `withAggregationException`.
//
//          (7) AN EMPTY CELL IS NOT AN ABSENT ANSWER. The grid used to render
//          the RAW DOCUMENT, so a measure whose direction and target are
//          already fully determined by the model's own KPI showed two blank
//          dropdowns — which reads as "nobody has decided this" and invites a
//          person to type a SECOND answer beside the KPI's. That is the drift a
//          reviewer sees when they say the strategy layer duplicates the KPI.
//          The resolver has always read the KPI as its base layer; `preview`
//          (`strategyPreview`) hands back what each measure actually resolves
//          to plus each attribute's `source`, and an empty control shows that
//          value greyed, NAMING the KPI or rule it came from. Choosing a real
//          option is what writes a literal — the explicit override. NOTHING
//          here re-derives a resolved value: no band ordering, no KPI lookup,
//          no direction inference. One implementation decides, and it is the
//          Rust resolver. The preview is best-effort: a failure is SILENT, the
//          tab keeps working without inheritance, and it never gates an edit.
//
//          (8) THE BULK CONFIRM CANNOT LAUNDER A WARNING. `Confirm` is the
//          signal a HUMAN vouched for a value, and the decomposition engine
//          trusts it downstream. `Confirm all` used to convert every proposal
//          into reviewed truth in one click, findings included — the one
//          gesture in this tab that could turn a warning into a confirmation
//          without anybody reading it. It now SKIPS any row carrying a finding
//          (and any `empty` row, for the same reason per-row Confirm is
//          disabled on those), and SAYS how many it skipped and why: a silent
//          skip is its own lie when the button is called "Confirm all". The
//          skip also has to stay VISIBLE, which is why this one write does not
//          clear the findings the way every other edit does — the badges are
//          the evidence for the sentence. Per-row Confirm is untouched: a
//          person looking at one warned row and confirming it anyway has made
//          a decision; the bulk gesture has not.
//
//          (9) THE MODEL BLOCK IS AUTHORABLE. `ModelStrategy` carries
//          `defaultTimeAxis`, `fiscalYearStart` and `priority`, and none of
//          them had a control anywhere — so the axis
//          every time-series fact is computed against could only ever be the
//          one inference guessed from the marked date table. The axis is a
//          <select> over the model's own columns for the same reason a scope
//          column is (see (4)): a typo there is not a broken axis, it is an
//          axis that silently disables every time fact. `fiscalYearStart` is
//          `MM-DD` and is refused at the keystroke that commits it rather than
//          at Save, because a fiscal year START RECURS — the commonest wrong
//          answer is a full date.
//
//          (10) THE FIELDS THAT ARE STORED AND READ BY NOTHING SAY SO ON
//          SCREEN, AND ONE OF THEM WAS DELETED INSTEAD. `reportingCurrency` had
//          no consumer and none coming, so it is GONE — deleting is the cheaper
//          reversal, since re-adding a field once a formatter exists costs less
//          than carrying one nobody uses. What is left is labelled rather than
//          removed, because each has a designed reader written down and not yet
//          built: today that is `fiscalYearStart` alone (nothing outside its
//          own format check), and it carries a VISIBLE note (`NotYetConsulted`)
//          rather than a tooltip, because someone will type into an
//          ordinary-looking box and reasonably expect a downstream effect, and
//          a tooltip is not a promise anyone reads before typing. It stays
//          EDITABLE: the value is stored, travels with the model, and matters
//          the moment something reads it, so disabling would discard authored
//          intent and buy nothing. WHEN ONE ACQUIRES A READER, DELETE ITS NOTE
//          — a stale "nothing reads this" is the same lie pointed the other
//          way. That has now happened twice: `defaultTimeAxis` and `priority`
//          were always read, and the measures grid's `unit` and `cadence`
//          acquired theirs on 2026-09-09 (`insights/model.rs:1701/1804` and
//          `:1754`), so `NOT_YET_CONSULTED_MEASURE_FIELDS` is EMPTY and the
//          grid marks no column header at all. The machinery stays because the
//          next inert field is a matter of time; this paragraph named those two
//          in the present tense for a day after their readers landed, which is
//          the same defect one level up.
//
//          (11) THE RULES SECTION HAS TO INVITE ITS OWN ACTION. `Add rule` was
//          a `smallBtn` beside a 13px heading and the empty state read "No
//          rules. A rule annotates facts in a scope; it never generates one." —
//          theory with no call to action. A reviewer read that, missed the
//          button entirely, and concluded rules could not be authored at all;
//          nobody then exercised the rules path, and a 100% path mismatch in
//          its findings went unnoticed. Undiscoverable UI and untested code are
//          the same territory. So the empty state names what a rule DOES in
//          concrete terms and carries the action itself, and a disabled add
//          control states WHY in the same place (`addRuleBlockedReason`) — a
//          read-only subscribed model and a document that has not loaded are
//          different answers, and a grey button with no sentence is what made
//          this invisible in the first place.
//
//          (12) A BAND DIRECTION IS A STATEMENT IN TWO HALVES. Picking
//          `targetBand` used to produce no further input at all, so a person
//          could assert a band-based direction with no band — and the two sit
//          in ONE dropdown looking equally settable. The bounds go in the
//          EXISTING target control rather than a new field, because a document
//          holding `direction: targetBand` beside `target: 1000` has two
//          answers and nothing saying which wins: choosing `targetBand`
//          switches that one control into low/high mode (each bound with its
//          own inclusivity) and CLEARS a target that is not a band, saying so
//          in the status line rather than dropping it silently. The backend
//          validator is what makes the incomplete state impossible; this only
//          makes it hard to reach, and its refusal lands on the row like every
//          other finding.
//
//          (13) CONFIRM IS REVERSIBLE, AND AN EDIT REVOKES IT. Confirm was
//          one-way, and `Confirm all` makes it a one-click claim across a whole
//          grid — an irreversible assertion a mis-click can make is a bad pair,
//          so the CONFIRMED BADGE IS ITSELF the un-confirm control. Worse, an
//          edit used to leave `reviewed: true` standing while re-stamping
//          `source: "authored"`, so a confirmed row could assert a value no
//          human had ever seen. `authoringStamp` (strategyTypes) now drops the
//          confirmation with the same act that re-stamps the source, and
//          Confirm / un-confirm still author nothing.
//
//          (14) A CONFIRMATION CAN BE OVERTAKEN BY INFERENCE. A column is
//          added, a measure renamed, calendar detection flips — and a row
//          confirmed last week now disagrees with what inference would propose
//          today. The divergence is detected LIVE: the tab keeps the draft
//          `strategyInfer` returns (model-only, no engine lock, no query) and
//          diffs it against what the document says, so a row can say both
//          answers and offer inference's. NOTHING IS AUTO-APPLIED. Only rows
//          carrying a human decision are marked — an inferred row that
//          disagrees with today's inference is a stale draft, not a decision.
//
//          (15) THE MODEL PANEL HAS PROVENANCE TOO. `defaultTimeAxis` shows a
//          value guessed from a calendar that was itself guessed, and the panel
//          had no badge to say so — the one place where a person would actually
//          accept that guess was the one place it did not announce itself. The
//          panel carries the same badge, Confirm and un-confirm as a row, at
//          PANEL granularity (`ModelStrategy.reviewed` / `.source`), because
//          there is no row here to confirm one field at a time.
//
//          (16) `kind` STOPPED BEING DECORATION. It was an editable dropdown
//          that changed nothing; it now overrides the backend's own table
//          classification, decides which table is the calendar and therefore
//          the time axis every trend, seasonality and change-point claim is
//          computed against. Two consequences land here. The cell says WHOSE
//          answer it is showing — a kind the drafting op wrote is stamped
//          `inferred` and is DISREGARDED (re-derived from today's relationship
//          graph), so rendering it identically to a chosen one tells a person
//          the engine is using a value it is not. And `dimension`/`calendar` on
//          a table nothing looks up is now a Save-blocking ERROR
//          (`authored-kind-contradicts-topology`), so those options are
//          DISABLED in the dropdown with the reason on them, and the finding
//          still lands on the row: making the state hard to reach is cheaper
//          than explaining a whole-document refusal afterwards. The refusal
//          mirrored here must never be stricter than the validator's, or the
//          tab would refuse a document the backend accepts.
//
//          (17) THE CONFIRMATION COLUMN IS PINNED. Eleven columns in an
//          `overflow-x: auto` card pushed `never slice by` and `reviewed` off
//          the right-hand edge, and `reviewed` is the column a person is
//          working DOWN while confirming a draft. `stickyConfirmCell` pins it
//          to the trailing edge — sticky rather than reordered, so the answer
//          still follows the values it answers for and no column changes what
//          it contains. Its background is explicit because a sticky cell floats
//          over the columns sliding beneath it and `rowTone` is transparent for
//          three of its four states.
//
//          (18) `suppress` IS A CLOSED SET AND THE CONTROL IS THE VOCABULARY.
//          It was a text field. Now that the Rust field is
//          `Vec<SuppressibleFactKind>`, a near-miss is not a suppression that
//          does nothing — it is a document that fails serde, and the backend
//          answers that by discarding the WHOLE strategy. So the eight kinds
//          are checkboxes, and `buildRuleFromDraft` still parses, because
//          unsaved drafts outlive the control that wrote them.
//
//          (19) A ROW THAT CAN BE HIDDEN MUST STILL BE REACHABLE. There are
//          FOUR ways a row can be absent from the DOM: the view switcher, the
//          "Needs review" filter, the column groups, and collapse. The first
//          version of this property counted three and missed the switcher — the
//          oldest of the four — so a finding on a table, clicked while you were
//          looking at Measures, revealed its row perfectly and left it in a
//          view you were not on. Nothing visible happened, which is precisely
//          the dead link this property forbids; and no test could see it,
//          because every test that touches another view switches to it first.
//          If a fifth layer is ever added, this list is part of the change.
//
//          Each layer can hide a row a finding is attached to, and the findings
//          strip is the surface that survives all of them. So selecting a
//          finding SWITCHES to the view its row lives in (`viewForPath`), OPENS
//          whatever contains it, defeats the filter for that one row, and
//          scrolls to it — and it does the opening by
//          DERIVING openness from the selection (`revealedFolders`,
//          `tableIsOpen`) rather than by writing to the collapse state: a
//          folder forced open by a selection shuts again on its own when the
//          selection moves, and no code has to remember to undo it. Two
//          corollaries. Folders and tables start OPEN, because the Set holds
//          the CLOSED keys — so a folder that appears the moment someone types
//          a display folder in the Measures tab is not born hidden. And
//          collapse never narrows a WRITE: `Confirm all` still walks every
//          measure and table in the model, because a button called "Confirm
//          all" that quietly meant "the ones you can see" is property (8)'s
//          defect wearing a different hat.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelOverview, ModelTableInfo } from "@api";
import { confirmAsync } from "@api/dialogs";
import {
  styles,
} from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { Chevron, FolderIcon, TREE_INDENT } from "../treeKit";

import { buildFolderTree, splitFolderPath, FOLDER_SEP } from "../../lib/measureFolders";
import {
  strategyGet,
  strategyInfer,
  strategyPreview,
  strategyRunTests,
  strategySet,
  strategyValidate,
} from "../../lib/strategyBackend";
import type {
  Applied,
  AttrSource,
  ResolvedMeasure,
  StrategyPreviewMeasure,
} from "../../lib/strategyBackend";
import {
  emptyStrategyDoc,
  modelColumnRefs,
  withRule,
  withoutRule,
} from "../../lib/strategyTypes";
import type {
  AttributeSet,
  Additivity,
  AggregationSpec,
  Cadence,
  Direction,
  Divergence,
  EntryState,
  Finding,
  Materiality,
  MeasureStrategy,
  ModelStrategy,
  Role,
  Rule,
  Scope,
  ScopeValue,
  StrategyDoc,
  TableKind,
  TableKindOrigin,
  Target,
  Unit,
} from "../../lib/strategyTypes";
import {
  ME,
  SPACE,
  TABULAR,
} from "../theme";
import { ModelPanel } from "./strategy/ModelPanel";
import { MeasuresGrid } from "./strategy/MeasuresGrid";
import { TablesGrid } from "./strategy/TablesGrid";
import { RulesGrid, addRuleBlockedReason } from "./strategy/RulesGrid";
import { FindingsStrip } from "./strategy/FindingsStrip";
import { RuleModal } from "./strategy/RuleModal";
import { rowPathFor, useTreeDisclosure } from "./strategy/tree";

// The barrel again: `addRuleBlockedReason` is asserted directly by the test
// suite, so it keeps its address here even though it now lives next door.
export { addRuleBlockedReason };
import {
  DRAFT_STATUS,
  MEASURE_COLUMN_GROUPS,
  MEASURE_GROUP_COLUMNS,
  NO_DRAFT_STATUS,
  PREVIEW_DEBOUNCE_MS,
  RESUMED_STATUS,
} from "./strategy/constants";
import type { MeasureColumnGroup, MeasureRowFilter } from "./strategy/constants";
import { forgetUnsavedDrafts, unsavedDrafts } from "./strategy/drafts";
import { buildRuleFromDraft, emptyRuleDraft, ruleToDraft } from "./strategy/ruleDraft";
import type { RuleDraft, ScopeClauseDraft } from "./strategy/ruleDraft";
import { confirmAllUnwarned, describeBulkConfirm } from "./strategy/bulkConfirm";
import type { BulkConfirm } from "./strategy/bulkConfirm";
import { parseFiscalYearStart, timeAxisGroups } from "./strategy/timeAxis";
import type { TimeAxisGroup } from "./strategy/timeAxis";
import {
  inheritedFor,
  inheritedFrom,
  inheritedOption,
  overridingRule,
  sourceKpiName,
  sourceLabel,
  sourceRuleId,
  whyLines,
} from "./strategy/inheritance";
import {
  BandIncomplete,
  BandTargetCell,
  ColumnRefList,
  DivergenceNote,
  KindOriginBadge,
  ReviewedCell,
  RowFindings,
  RuleOverrideMark,
  SpecInput,
  STICKY_CONFIRM,
  WhyCell,
  cellStyle,
  rowTone,
  selectOf,
  smallInput,
  stickyConfirmCell,
  stickyHeaderStyle,
} from "./strategy/cells";

// THE BARREL. This file stays the one address for everything outside the
// folder: ModelEditorApp, two test files and strategyTypes.test all import from
// "sections/StrategySection", and the split must not make any of them care
// where a symbol moved to. It is also why the numbered property header at the
// top of this file keeps ONE home rather than being scattered across ten.
export { MEASURE_COLUMN_GROUPS, MEASURE_GROUP_COLUMNS };
export type { MeasureColumnGroup };
export { forgetUnsavedDrafts };
export { buildRuleFromDraft, emptyRuleDraft, ruleToDraft };
export type { RuleDraft, ScopeClauseDraft };
export { confirmAllUnwarned, describeBulkConfirm };
export type { BulkConfirm };
export { parseFiscalYearStart, timeAxisGroups };
export type { TimeAxisGroup };

// ===========================================================================
// The per-connection working draft
// ===========================================================================

export function StrategySection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, reportError } = ctx;

  const [doc, setDoc] = useState<StrategyDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ original: Rule | null } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // The two trees' collapse state lives HERE rather than in the grids, because
  // the grids are conditionally rendered: a glance at Rules would otherwise
  // throw away a "collapse all tables" the user had just performed.
  const folderDisclosure = useTreeDisclosure();
  const tableDisclosure = useTreeDisclosure();
  // The strip holds the RAW finding path (it highlights the finding you
  // clicked); the grids get the ROW that path belongs to. One normalisation,
  // three consumers — outline, scroll and reveal — so they cannot disagree
  // about which row a finding is about.
  const selectedRow = rowPathFor(overview, selectedPath);
  const clearSelection = useCallback(() => setSelectedPath(null), []);

  // Which of the four views is showing. Measures first: it is the sweep this
  // tab exists for, and the one with 300 rows behind it.
  const [view, setView] = useState<StrategyView>("measures");

  /** Select a finding: highlight it AND go to the view its row lives in. */
  const selectFinding = useCallback((path: string | null) => {
    setSelectedPath(path);
    const wanted = path === null ? null : viewForPath(path);
    if (wanted !== null) setView(wanted);
  }, []);

  // ARRIVING WITH A SELECTION. `ctx.selection` had a producer and no consumer
  // here: the problems drawer navigates to Strategy naming the row it is about,
  // and this tab dropped it on the floor and opened on Measures. Honoured ONCE
  // per distinct value, at render time rather than in an effect — the same
  // idiom TablesSection and MeasuresSection use, and the one this eslint config
  // leaves legal (`react-hooks/set-state-in-effect` is an error).
  //
  // The token is a strategy PATH, not a bare name: `locateStrategyFinding`
  // emits the whole thing, because a name cannot say whether "Sales" is a table
  // or a measure and this tab addresses everything by path anyway.
  const honouredSelection = useRef<string | null>(null);
  if (ctx.selection !== undefined && ctx.selection !== honouredSelection.current) {
    honouredSelection.current = ctx.selection;
    const arrivingView = ctx.selection === null ? null : viewForPath(ctx.selection);
    if (ctx.selection !== null && arrivingView !== null) {
      setSelectedPath(ctx.selection);
      setView(arrivingView);
    }
  }
  /** What each measure RESOLVES to, by measure name. Empty until the preview
   *  arrives, and empty forever if it never does — inheritance is an extra the
   *  grid can do without, never a precondition for editing. */
  const [preview, setPreview] = useState<Map<string, StrategyPreviewMeasure>>(() => new Map());
  /**
   * What inference proposes for THIS model right now — the other half of the
   * divergence check (property (14)).
   *
   * It is fetched on every load, including when a stored document exists, which
   * is the one call the tab did not use to make. Inference is model-only (no
   * engine lock, no query), and the alternative — a hash of the values stored
   * at the moment of confirmation — would need maintaining on every edit, would
   * go stale in its own way, and would say nothing at all about a document
   * written before it existed. `null` means no draft could be built, and then
   * no row claims a divergence.
   */
  const [inferred, setInferred] = useState<StrategyDoc | null>(null);

  // A slow load for a connection the user has already left must not install
  // its document over the newer one.
  const loadSeq = useRef(0);
  /** The load this connection's FIRST preview was fetched for. The first one
   *  is immediate — the grid's first paint is exactly where a blank cell would
   *  mislead — and only later document edits are debounced. */
  const previewedSeq = useRef(-1);
  useEffect(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setDoc(null);
    setFindings([]);
    setStatus(null);
    // Another model's inheritance is worse than none: it would name a KPI this
    // model does not have.
    setPreview(new Map());
    setInferred(null);

    void (async (): Promise<void> => {
      // ONE inference per load, started beside the read rather than after it.
      // It has two consumers — the draft a model with no stored strategy opens
      // on, and the live divergence check every stored row is diffed against —
      // and asking twice would be two answers to one question as well as two
      // round trips. A draft that cannot be built is not an error: the tab
      // simply has no draft and no divergences.
      const drafting = strategyInfer(connectionId).then(
        (d) => d,
        () => null,
      );
      let next: StrategyDoc = emptyStrategyDoc();
      let note: string | null = null;
      let draft: StrategyDoc | null = null;
      try {
        const stored = await strategyGet(connectionId);
        if (loadSeq.current !== seq) return;
        draft = await drafting;
        if (loadSeq.current !== seq) return;
        if (stored) {
          // A stored document is the authority. It is never auto-inferred over
          // and a draft is never merged into it — the draft fetched above is
          // read ONLY to say where the two disagree.
          unsavedDrafts.delete(connectionId);
          next = stored;
        } else {
          const remembered = unsavedDrafts.get(connectionId);
          if (remembered) {
            // Coming BACK to the tab. Installing the draft here would discard
            // whatever the user confirmed before they switched sections.
            next = remembered;
            note = RESUMED_STATUS;
          } else if (draft) {
            next = draft;
            unsavedDrafts.set(connectionId, next);
            note = DRAFT_STATUS;
          } else {
            next = emptyStrategyDoc();
            note = NO_DRAFT_STATUS;
          }
        }
      } catch (err: unknown) {
        if (loadSeq.current !== seq) return;
        next = emptyStrategyDoc();
        reportError(err);
      }
      if (loadSeq.current !== seq) return;
      setDoc(next);
      setInferred(draft);
      setStatus(note);
      setLoading(false);
    })();
  }, [connectionId, reportError]);

  /**
   * Keep the inheritance in step with the document being edited.
   *
   * The IN-MEMORY document is what is previewed, so raising a materiality shows
   * its effect before Save rather than after — that is the whole point of
   * sending a payload at all. Debounced, because every keystroke that commits a
   * spec produces a new document.
   *
   * A failure is SILENT and total: the catch swallows it, the map stays as it
   * was, and every control falls back to the blank it showed before this
   * existed. Nothing here can block or refuse an edit.
   */
  useEffect(() => {
    if (doc === null) return undefined;
    // The SAME guard the mount effect uses: a preview for a connection the user
    // has already left must not overwrite the newer one.
    const seq = loadSeq.current;
    let cancelled = false;
    const fetchPreview = (): void => {
      void (async (): Promise<void> => {
        try {
          const result = await strategyPreview(connectionId, doc);
          if (cancelled || loadSeq.current !== seq) return;
          const next = new Map<string, StrategyPreviewMeasure>();
          for (const m of result.measures) next.set(m.measure, m);
          setPreview(next);
        } catch {
          // Deliberately silent. The tab works without inheritance; a toast for
          // a decoration would train people to dismiss the ones that matter.
        }
      })();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (previewedSeq.current === seq) {
      timer = setTimeout(fetchPreview, PREVIEW_DEBOUNCE_MS);
    } else {
      previewedSeq.current = seq;
      fetchPreview();
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [connectionId, doc]);

  /** Install a new working draft. The ONE write path for a local edit: it
   *  remembers the draft for this connection so leaving the tab does not
   *  discard it. */
  const applyDraft = useCallback(
    (next: StrategyDoc, opts: { keepFindings: boolean; status: string | null }) => {
      unsavedDrafts.set(connectionId, next);
      setDoc(next);
      if (!opts.keepFindings) setFindings([]);
      setStatus(opts.status);
    },
    [connectionId],
  );

  /** Every local edit goes through here. Findings are cleared, because a
   *  finding describes the document that produced it and an edited document
   *  has not been judged yet — a stale error would keep Save locked over a
   *  problem the user just fixed.
   *
   *  `note` is for the rare edit that does something to the document BESIDES
   *  what was asked — today only switching a direction to `targetBand`, which
   *  clears a target that is not a band. Silent collateral damage is what the
   *  aggregation cell's data-loss bug was made of, so the one place that does
   *  it says so out loud. */
  const edit = useCallback(
    (next: StrategyDoc, note: string | null = null) =>
      applyDraft(next, { keepFindings: false, status: note }),
    [applyDraft],
  );

  const columnRefs = useMemo(() => modelColumnRefs(overview), [overview]);
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const disabled = readOnly || busy || doc === null;
  // Computed from the SAME three inputs `disabled` is, so the sentence and the
  // grey cannot come apart: a control that is dead for a reason nobody states
  // is what made the Rules section read as unbuilt (property (11)).
  const addRuleBlocked = addRuleBlockedReason({
    readOnly,
    readOnlyReason: overview.readOnlyReason,
    loaded: doc !== null,
    busy,
  });

  const run = useCallback(
    async (what: string, fn: (d: StrategyDoc) => Promise<void>) => {
      if (!doc) return;
      setBusy(true);
      setStatus(null);
      try {
        await fn(doc);
      } catch (err: unknown) {
        reportError(err);
        setStatus(`${what} failed.`);
      } finally {
        setBusy(false);
      }
    },
    [doc, reportError],
  );

  const onValidate = useCallback(
    () =>
      run("Validate", async (d) => {
        const result = await strategyValidate(connectionId, d);
        setFindings(result.findings);
        setStatus(
          result.findings.length === 0
            ? "Valid — no findings."
            : `${result.findings.length} finding(s).`,
        );
      }),
    [run, connectionId],
  );

  const onRunTests = useCallback(
    () =>
      run("Run tests", async (d) => {
        const result = await strategyRunTests(connectionId, d);
        setFindings(result.findings);
        setStatus(
          result.findings.length === 0
            ? `All ${d.tests?.length ?? 0} inline test(s) pass.`
            : `${result.findings.length} test failure(s).`,
        );
      }),
    [run, connectionId],
  );

  const onSave = useCallback(
    () =>
      run("Save", async (d) => {
        const result = await strategySet(connectionId, d);
        setFindings(result.findings);
        // A refusal RESOLVES. Reporting success here on anything but
        // `written === true` is the bug this branch exists to prevent.
        if (result.written) unsavedDrafts.delete(connectionId);
        setStatus(
          result.written
            ? `Saved${result.findings.length > 0 ? ` with ${result.findings.length} warning(s)` : ""}.`
            : "Not saved — the strategy was refused. See the findings below.",
        );
      }),
    [run, connectionId],
  );

  // The button and the mount-time draft call the SAME backend inference, so
  // the two can never disagree about what "inferred" means here.
  const onInfer = useCallback(async () => {
    // AWAITED: the Tauri shim returns a Promise, so an un-awaited confirm is
    // always truthy and the draft would be replaced without asking.
    const agreed = await confirmAsync(
      "Replace the strategy with a freshly inferred draft?\n\n" +
        "Every entry comes back unconfirmed, and edits you have not saved are discarded.",
    );
    if (!agreed) return;
    setBusy(true);
    setStatus(null);
    try {
      const drafted = await strategyInfer(connectionId);
      unsavedDrafts.set(connectionId, drafted);
      setDoc(drafted);
      // The divergence reference moves with the draft. Leaving the old one
      // behind would leave rows claiming to disagree with an inference that has
      // just been overwritten by this very one.
      setInferred(drafted);
      setFindings([]);
      setStatus("Inferred a fresh draft — nothing is written until you press Save.");
    } catch (err: unknown) {
      reportError(err);
      setStatus("Infer failed.");
    } finally {
      setBusy(false);
    }
  }, [connectionId, reportError]);

  const onConfirmAll = useCallback(() => {
    if (!doc) return;
    const result = confirmAllUnwarned(
      doc,
      overview.measures.map((m) => m.name),
      overview.tables.map((t) => t.name),
      findings,
    );
    // KEEPS THE FINDINGS, alone among the edits. They are the evidence for the
    // sentence this write puts on screen — clearing them would leave "skipped 3
    // rows carrying a finding" above a grid where nothing is warned any more,
    // which is a worse lie than the silent skip it replaced. Confirming a row
    // can only retire an unreviewed-entry warning, never raise a new finding,
    // so what survives here is at worst stale in the safe direction and
    // Validate refreshes it.
    applyDraft(result.doc, { keepFindings: true, status: describeBulkConfirm(result) });
  }, [doc, findings, applyDraft, overview]);

  if (loading || !doc) {
    return (
      <div style={{ ...styles.muted, padding: 8 }}>
        {loading ? "Loading strategy…" : "No strategy document."}
      </div>
    );
  }

  const saveLabel =
    errorCount > 0
      ? `Save — fix ${errorCount} error${errorCount === 1 ? "" : "s"} first`
      : "Save";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>
          Strategy ({overview.measures.length} measures, {doc.rules?.length ?? 0} rules)
        </span>
        <button style={styles.btn} disabled={busy} onClick={() => void onValidate()}>
          Validate
        </button>
        <button style={styles.btn} disabled={busy} onClick={() => void onRunTests()}>
          Run tests
        </button>
        <button
          style={styles.primaryBtn}
          disabled={disabled || errorCount > 0}
          title={
            errorCount > 0
              ? "The strategy has errors; the backend refuses a document that would make the engine lie."
              : "Store the strategy on the model"
          }
          onClick={() => void onSave()}
        >
          {saveLabel}
        </button>
        <button
          style={styles.btn}
          disabled={disabled}
          title="Replace the draft with a freshly inferred one (asks first)"
          onClick={() => void onInfer()}
        >
          Infer
        </button>
      </div>

      <div style={{ ...styles.hint, display: "flex", gap: 10, alignItems: "center" }}>
        <span>Nothing is written until you press Save.</span>
        {status && (
          <span data-testid="strategy-status" style={{ color: ME.text2 }}>
            {status}
          </span>
        )}
      </div>

      {/* FOUR SIBLING VIEWS, NOT FOUR STACKED PANELS.
          All of this used to live in ONE `overflowY` container, so reaching
          Rules meant scrolling past every measure — and on a real model that is
          three hundred rows, not two. Each view now owns its own scroll, so the
          sweep you are actually doing fills the window.
          (Splitting Tables from Columns is the remaining half; they are still
          one interleaved grid, a row per table and a row per column.) */}
      <div
        role="tablist"
        aria-label="Strategy views"
        data-testid="strategy-views"
        style={{ display: "flex", gap: SPACE.xs, flexShrink: 0 }}
      >
        {STRATEGY_VIEWS.map((v) => {
          const isActive = v.id === view;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-testid={`strategy-view-${v.id}`}
              onClick={() => setView(v.id)}
              style={{
                ...styles.btn,
                fontWeight: isActive ? 600 : 400,
                background: isActive ? ME.accentSoft : ME.btnBg,
                borderColor: isActive ? ME.accent : ME.ctlBorder,
                color: isActive ? ME.text : ME.text2,
              }}
            >
              {v.label}
              {v.count !== undefined && (
                <span style={{ marginLeft: SPACE.sm, color: ME.text3, ...TABULAR }}>
                  {v.count(overview, doc)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}
      >
        {view === "defaults" && (
          <ModelPanel
            doc={doc}
            overview={overview}
            findings={findings}
            inferredModel={inferred?.model}
            disabled={disabled}
            onEdit={edit}
          />
        )}
        {view === "measures" && (
          <MeasuresGrid
            doc={doc}
            overview={overview}
            findings={findings}
            preview={preview}
            inferred={inferred}
            selectedPath={selectedRow}
            columnRefs={columnRefs}
            disabled={disabled}
            folders={folderDisclosure}
            onClearSelection={clearSelection}
            onEdit={edit}
            onConfirmAll={onConfirmAll}
          />
        )}
        {view === "tables" && (
          <TablesGrid
            doc={doc}
            overview={overview}
            findings={findings}
            inferred={inferred}
            selectedPath={selectedRow}
            disabled={disabled}
            tables={tableDisclosure}
            onClearSelection={clearSelection}
            onEdit={edit}
          />
        )}
        {view === "rules" && (
          <RulesGrid
            doc={doc}
            findings={findings}
            selectedPath={selectedRow}
            disabled={disabled}
            blockedReason={addRuleBlocked}
            onAdd={() => setEditing({ original: null })}
            onEditRule={(rule) => setEditing({ original: rule })}
            onDelete={(id) => edit(withoutRule(doc, id))}
          />
        )}
      </div>

      {/* OUTSIDE the switcher on purpose. A finding is why Save is refusing,
          and hiding it behind whichever view you are not looking at would
          leave a disabled Save button with its reason one click away. */}
      <FindingsStrip findings={findings} onSelect={selectFinding} selectedPath={selectedPath} />

      {editing && (
        <RuleModal
          overview={overview}
          doc={doc}
          original={editing.original}
          onClose={() => setEditing(null)}
          onSave={(rule) => {
            edit(withRule(doc, rule));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Views
// ===========================================================================

type StrategyView = "measures" | "tables" | "rules" | "defaults";

/**
 * The view a finding's path belongs to.
 *
 * THE SWITCHER IS THE FOURTH WAY A ROW CAN BE HIDDEN, after the "Needs review"
 * filter, the column groups and collapse — and property (19) shipped without
 * knowing it existed. A finding on a table, clicked while you were looking at
 * Measures, revealed the row perfectly and left it in a view you were not on:
 * nothing visible happened, which is the dead link the property forbids. The
 * suite could not see it either, because every test that touches another view
 * calls `showView` first.
 *
 * The four prefixes are the whole vocabulary: `measurePath`, `tablePath` and
 * `rulePath` build three of them (strategyTypes.ts) and the model block writes
 * the fourth as plain "model" / "model.<field>".
 */
function viewForPath(path: string): StrategyView | null {
  if (path.startsWith("measures[")) return "measures";
  if (path.startsWith("tables[")) return "tables";
  if (path.startsWith("rules[")) return "rules";
  if (path === "model" || path.startsWith("model.") || path.startsWith("model[")) return "defaults";
  return null;
}

const STRATEGY_VIEWS: Array<{
  id: StrategyView;
  label: string;
  count?: (o: ModelOverview, d: StrategyDoc) => number;
}> = [
  { id: "measures", label: "Measures", count: (o) => o.measures.length },
  { id: "tables", label: "Tables and columns", count: (o) => o.tables.length },
  { id: "rules", label: "Rules", count: (_o, d) => d.rules?.length ?? 0 },
  { id: "defaults", label: "Defaults" },
];

// ===========================================================================
// Measures grid
// ===========================================================================

/**
 * Measure attributes that are stored, validated, resolved — and read by nothing.
 *
 * The standing rule is that nothing becomes authorable until it has a reader
 * (`docs/design/insights-strategy-layer.md` §2). These two are the deliberate
 * exception rather than an oversight: both have a designed consumer written down
 * and not yet built — `unit` the moment narration formats a value, `cadence` for
 * period bucketing and seasonality lag selection — which is why they were kept
 * in the pass that DELETED `reportingCurrency`, whose reader was not coming.
 * Until one lands they carry the same label the model-block fields do, so nobody
 * spends authoring effort on a field that changes nothing.
 */
// EMPTY, and that is the point. `unit` and `cadence` were marked here because
// they were stored, validated and resolved but READ BY NOTHING. Both acquired
// readers on 2026-09-09 — `unit` at insights/model.rs:1701 and :1804 (narration
// picks the wording for a percent, a ratio and a currency differently), and
// `cadence` at :1754, where `expected_cycle()` chooses the seasonality lag,
// wired end to end by the Rust test literally named
// `the_declared_cadence_decides_which_cycle_a_seasonal_measure_reports`.
//
// The file's own rule (property 10) says: WHEN ONE ACQUIRES A READER, DELETE
// ITS NOTE — a stale "nothing reads this" is the same lie pointed the other
// way. Two of them were still asserting it on screen.
//
// The marker MECHANISM stays, because the next inert attribute will want it.
// Note it renders as `*`, which every reader on earth takes as REQUIRED — the
// opposite of "this changes nothing". If something is ever added back here,
// change the glyph too.

/**
 * Column groups, so eleven columns stop needing a horizontal scrollbar.
 *
 * Eleven columns do not fit in this window and never will — it opens at
 * 1150px. Sideways scrolling in a grid you are working DOWN is the worst of
 * both directions, and it is what forced the `reviewed` column to be sticky in
 * the first place (property 17).
 *
 * Applied by CSS `nth-child` against `data-cols` on the table, NOT by making
 * eleven hand-written `<td>`s conditional: the header is a map and the body is
 * eleven literals, so a JSX split is eleven chances for the two to disagree
 * about which column is which. `measure` (1) and `reviewed` (11) are in every
 * group — one names the row, the other is the answer you are here to give.
 */

/** Which rows the grid shows. Defaults to the unconfirmed ones, because the
 *  job this tab exists for is working DOWN a draft — landing on 12 rows to
 *  read beats landing on 300 of which 288 are already answered. */

/** The accepted spellings for the two spec cells.
 *
 *  Constants because the placeholder is no longer always the hint: an empty
 *  cell shows what it INHERITS instead, and the format then has to reach the
 *  tooltip. Two spellings of one grammar drift. */
// The bracket spelling is in the hint because it is the only place the
// exclusive form is discoverable from a text field: the measures grid gives a
// band direction its own two-bound control, but a band on any OTHER direction,
// and every band in a rule, is still typed.

// ===========================================================================
// Trees — the shared disclosure machinery for both grids