// FILENAME: app/extensions/Collaboration/components/PublishDialog.tsx
// PURPOSE: Push a new version of the application this workbook is a working copy
// of — or, for a standalone workbook, create an application from it.
// CONTEXT: Deliberately NOT a modal: there is no backdrop, so the workbook stays
// fully interactive while the window is open. Movable + resizable via the shared
// @api/dialogWindow hook; closes only via its own buttons.
//
// TWO MODES, and the difference is not cosmetic. A LINKED workbook already knows
// its workspace, application and base version, so the dialog stops asking and
// starts TELLING: here is where the application stands, here is what you are
// based on, here is the next version. It was seven blank fields on every open —
// including a comma-separated list of sheet INDICES — which meant shipping v1.1
// of your own report involved retyping its identity from memory and being wrong
// about it in silence. An UNLINKED workbook still gets the fields, because there
// is genuinely nothing to remember yet, and publishing links it for next time.

import React, { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type {
  ButtonCodeRelease,
  DialogProps,
  MergeAnalysisResponse,
  PublishReport,
  PushGateStatus,
  PublishPreviewSheet,
  UnshippedMacroLinkItem,
  VersionDiff,
  WithheldContent,
  WorkingCopyStatus,
} from "@api";
import {
  diffWorkingCopy,
  publishApplication,
  publishPreview,
  pushMergeAnalyze,
  pushMergeApply,
  workingCopyStatus,
  undo,
  showDialog,
  listApplicationsInWorkspace,
  emitAppEvent,
  ENVIRONMENTS_CHANGED_EVENT,
  openPanel,
} from "@api";
import type { ApplicationInfo } from "@api";
import { holdBackCells, type PublishSheetSelection } from "@api/collaboration";
import {
  describeBackendRefusal,
  isSheetGoneRefusal,
  isSheetIndexOutOfRangeRefusal,
  isWorkbookChangedWhileSaving,
} from "@api/backendRefusal";
import { formatNumber } from "@api/locale";
import { CHECKOUT_DIALOG_ID, APPLICATION_EXPLORER_PANEL_ID } from "../manifest";
import { VersionDiffView, cellKeyOf } from "./VersionDiffView";
import {
  EMPTY_HOLD_BACK,
  describeDroppedHoldBacks,
  describeParkedHoldBacks,
  holdBackReducer,
  parseCellKey,
} from "../lib/holdBack";
import { listWorkspaces, type SavedWorkspace } from "@api/collaborationWorkspaces";
import { useDialogWindow } from "@api/dialogWindow";
import {
  DialogBody,
  DialogPane,
  DialogSidePane,
  useDialogSplit,
  dialogWidth,
} from "@api/dialogLayout";
import { pickWorkspaceFile, pickWorkspaceFolder } from "../lib/pickWorkspace";
import { pushBlockingReason, identityRuleToSend } from "../lib/pushReadiness";
import { keysAt, selectionWire, sheetKey, tickedSheets } from "../lib/listedSheets";
import { describePushLanding } from "../lib/environments";
import { PublishReportView } from "./ApplicationExplorerPanel";
import {
  AddedToApplicationList,
  IncludeInApplicationContext,
  WithheldContentList,
  type IncludeControls,
} from "./WithheldContentList";
import { ButtonCodeReview, unacknowledgedButtonCode } from "./ButtonCodeReview";
import { UnshippedMacroLinks } from "./UnshippedMacroLinks";
import { PromotionCodeSummary } from "./PromotionCodeSummary";
import {
  PROMOTION_CODE_LOADING,
  PUSH_CODE_AUDIENCE,
  promotionCodeFailed,
  promotionCodeFromImpact,
  type PromotionCodeState,
} from "../lib/promotionCode";
import {
  EMPTY_INCLUDE_STATE,
  includeList,
  includeSignature,
  isIncluded,
  isReviewed,
  isTickedForOtherCode,
  itemKey,
  markReviewed,
  pruneTicks,
  setIncluded,
  unhonouredIncludes,
  type IncludeState,
} from "../lib/includeInApplication";

/** Which of the two things this dialog is doing right now. */
type Mode = "loading" | "push" | "create";

/**
 * The acts whose RETRYABLE refusal the answer strip can run again at once: each
 * already has its own button (Push / Publish, Preview, the stale banner's
 * Merge). The working-copy diff has none -- it runs on its own when the
 * selection moves -- so its refusal is said, never offered as a retry.
 */
type RetryableAct = "push" | "preview" | "merge";

/** What the Preview button (and a retried preview) labels its report with. */
const PREVIEW_LABEL = "Preview — would publish";

/**
 * Said after a gone-sheet refusal once the list has been read again
 * (`readSheetListAgain`): the dialog did what the refusal's own sentence asks.
 */
const SHEET_LIST_READ_AGAIN =
  "The list of sheets has been read again, so it shows the sheets the workbook has now.";

/**
 * The act running now, if any (`actInFlightRef`): a push, a merge, or a
 * Preview the author started by itself (the Preview button, Try again) -- a
 * merge's own refresh is part of the merge and holds nothing of its own.
 */
type RunningAct = "push" | "merge" | "preview";

export function PublishDialog({ onClose, data }: DialogProps) {
  // Opened from a sheet tab? Then highlight where that sheet sits in the push.
  // Narrowed with a typeof guard rather than cast: `data` is
  // `Record<string, unknown>` and comes from a caller this component does not
  // control.
  const focusSheetName = typeof data?.focusSheetName === "string" ? data.focusSheetName : undefined;
  // minWidth raised with the two-pane push layout below — 460px was narrower
  // than either pane wants and narrower than this dialog ever opens. 620 is
  // CreateChartDialog's floor and this dialog's own narrow width, so the first
  // resize drag does not snap the create-mode window wider.
  const win = useDialogWindow({ minWidth: 620, minHeight: 420 });

  // THE DIVIDER between the form and its review, and the measurement that folds
  // the two panes back into one column when the dialog is dragged narrow. The
  // review side gets the larger share by default: the settings are a version
  // box, a textarea and a checkbox list that read fine at ~420px, while the
  // review hosts VersionDiffView's four-column Cell/Before/After table. 820px
  // is the same threshold CreateChartDialog uses, so two dialogs do not
  // disagree about what "narrow" means.
  const split = useDialogSplit({ initial: 0.45, min: 0.3, max: 0.7 });
  const [bodyWidth, setBodyWidth] = useState(0);
  useEffect(() => {
    const el = split.containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setBodyWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      setBodyWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [split.containerRef]);
  const isNarrowBody = bodyWidth > 0 && bodyWidth < 820;

  const [mode, setMode] = useState<Mode>("loading");
  const [workspace, setWorkspace] = useState<WorkingCopyStatus | null>(null);
  const [gates, setGates] = useState<PushGateStatus | null>(null);
  const [saved, setSaved] = useState<SavedWorkspace[]>([]);

  // Fields. In push mode the target three are read-only, taken from the link.
  const [registryPath, setRegistryPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  // NOT a user choice. Kind is advisory for the ordinary case — nothing in the
  // codebase consumes RefreshDefaults::for_kind, so report/template/dataset
  // behave identically — while "library" DOES change what ships (an empty sheet
  // selection publishes zero sheets, so a function library does not carry the
  // author's data). Offering that as a dropdown next to "report" put a
  // content-changing option one careless click away from a question that has
  // one right answer. Libraries publish through publishLibrary(), datasets
  // through calp_publish_model, skins through their own path; each sets its own
  // kind. A push does not set it at all — it is fixed when the application is
  // created, and read from the link.
  const [kind, setKind] = useState("report");
  const [changeSummary, setChangeSummary] = useState("");
  const [includeComments, setIncludeComments] = useState(false);
  /**
   * THE APPLICATION'S IDENTITY RULE (identity phase 1): count only answers
   * from VERIFIED senders. Shows what the push would keep -- the verified base
   * version's rule, which the preview reports -- until the author moves it;
   * off for a new application (the owner's default for Windows-account
   * applications). SENT ONLY WHEN THE AUTHOR MOVED IT (`identityRuleToSend`):
   * otherwise Rust keeps the verified base's rule itself, and refuses the push
   * when it cannot read it -- never a silent switch.
   */
  const [requireVerified, setRequireVerified] = useState(false);
  const requireVerifiedTouchedRef = React.useRef(false);
  /**
   * THE HOLD-BACK: the cells the author unticked in the diff -- on sheets the
   * latest comparison says the push CARRIES (`excluded`, as `cellKeyOf`
   * strings, what the strip counts as staying local) and on sheets it says the
   * push does not (`parked`) -- and what the dialog says about unticks a new
   * comparison took away (`dropped`): lib/holdBack.ts.
   *
   * AN EXCLUSION SET. The diff rows are a bounded sample, so a changed cell may
   * have no row — storing what was opted OUT of means every cell the dialog
   * could not show is pushed, which is exactly what a push has always done.
   *
   * NEVER CLEARED, NEVER DROPPED WITH ITS SHEET, when the comparison is worked
   * out again. The diff runs again whenever the selection moves -- also when
   * this dialog itself reads the sheet list again after a gone-sheet refusal
   * -- and clearing there ticked every held-back change again with no message,
   * so the next Push published it (review round 9, F1); dropping the unticks
   * of a sheet unticked by mistake did the same once it was ticked again
   * (review round 10, R10-1). Now they are PARKED with their sheet and come
   * back with it.
   *
   * SORTED BY WHAT RUST SAYS THE PUSH CARRIES, never by the ticked rows (review
   * round 11, RV11-TS-1): a floating grid's backing sheet travels with its
   * host page, and a sheet a chart on a ticked sheet reads joins the push, so a
   * sort by the ticks parked an untick on a sheet that shipped -- and the push,
   * which sent only `excluded`, published the cell. Now the diff's answer says
   * which sheets the push carries (`carriedSheetIds`), and a push sends EVERY
   * untick with its own selection, for Rust to hold back exactly the ones on
   * sheets it carries. One reducer, so the sets and the sentences about them
   * change in one update.
   */
  const [holdBack, dispatchHoldBack] = useReducer(holdBackReducer, EMPTY_HOLD_BACK);
  const excludedCells = holdBack.excluded;
  /**
   * EVERY UNTICK THE AUTHOR MADE, acting or parked: what the diff rows show
   * unticked, and what a push sends. A row on screen can be on a sheet the push
   * does not carry -- an unticked base sheet the diff lists as "removed", cell
   * by cell -- and an untick there is parked; its box must still show it, or it
   * would not answer the click.
   */
  const untickedCells = useMemo(
    () => new Set<string>([...holdBack.excluded, ...holdBack.parked]),
    [holdBack.excluded, holdBack.parked],
  );

  /**
   * EVERY SHOW STARTS CLEAN — see `openDialog`'s `__openCount`.
   *
   * This dialog is non-modal and is now re-openable from a sheet tab, so the
   * "already open, just re-shown" path is ordinary rather than exotic. `pushed`
   * surviving it left the Push button permanently disabled behind a stale
   * success message, with `pushBlockingReason` returning null because its first
   * line is `if (i.pushed) return null` — a dead primary action stating no
   * reason, which is precisely the failure this file was rewritten to remove.
   */
  const openCount = data?.__openCount;
  useEffect(() => {
    setPushed(false);
    setStatus(null);
    setError(null);
    setReport(null);
    setReportFor(null);
    setWarnings([]);
    dispatchHoldBack({ type: "reset" });
    setSelectionTouched(false);
    selectionTouchedRef.current = false;
    // "Include in application" belongs to ONE push. A tick that outlived the
    // push that shipped it named an item that is part of the application now
    // -- which the next push refused (CALP_PUSH_INCLUDED_CHANGED) with no row
    // left to untick it from, blocking every push until the dialog unmounted.
    setIncludeState(EMPTY_INCLUDE_STATE);
    setIncludeFor(null);
    setRequireVerified(false);
    requireVerifiedTouchedRef.current = false;
    setAdded([]);
    setUnshippedLinks([]);
    setReportIncludeFor(null);
    // A merge analysis that failed before is asked again on a new show.
    setMergeFailure(null);
  }, [openCount]);
  /**
   * What the chosen workspace already holds. `null` while unread — which is a
   * different state from "read, and empty", and the two must not look alike:
   * "no applications yet" is a fact, "not asked yet" is not.
   */
  const [existingApps, setExistingApps] = useState<ApplicationInfo[] | null>(null);
  /**
   * Ticked sheets, by STABLE SHEET ID (`sheetKey` in lib/listedSheets.ts).
   *
   * Was a Set of NAMES mapped back to an index by POSITION in the name list —
   * which was already fragile and became wrong the moment the default stopped
   * being "every sheet": object-backed sheets and now subscribed ones make list
   * position and workbook index different numbers.
   *
   * Then a Set of TRUE workbook INDICES, which went wrong the moment the
   * workbook moved under this non-modal dialog (review round 9): the indices
   * came from a list read in an earlier command, and the backend resolved them
   * against the list as it stood at the push. Drag the unticked private sheet
   * in front of the report and Push shipped the private sheet under the
   * author's key and left the report behind; "Try again" after a refusal resent
   * the same positions, and a Preview re-read the list but kept the positions,
   * moving every tick onto a neighbour on screen too. An id follows its sheet
   * through a move, a copy and a delete, and it is what goes on the wire.
   */
  const [sheetSelection, setSheetSelection] = useState<Set<string>>(new Set());
  const [availableSheets, setAvailableSheets] = useState<PublishPreviewSheet[]>([]);
  /** What an untouched dialog would publish, straight from the backend. */
  const [defaultIndices, setDefaultIndices] = useState<number[]>([]);
  /** True once the user has moved a checkbox — before that we mirror the default. */
  const [selectionTouched, setSelectionTouched] = useState(false);
  /**
   * The same flag, readable from inside an async callback.
   *
   * `selectionTouched` is captured when a preview request is ISSUED, and these
   * callbacks resolve long after. An author who finished typing the workspace
   * path (firing request N) and then unticked the sheet holding their private
   * numbers had that untick undone by N's callback, which still saw the
   * captured `false` and restored the default selection. If they had scrolled
   * on to the change summary they never saw the box re-tick, and the sheet
   * left the machine — on the one surface whose whole job is disclosing what
   * leaves the machine.
   *
   * A ref reads the value AT RESOLUTION rather than at issue, which is the
   * question being asked: "has the author touched this by now?"
   */
  const selectionTouchedRef = React.useRef(false);
  /**
   * THE TICKED ROWS, in list order, and that selection as one comparable
   * string (over ids). Derived here, at render, ABOVE every effect that names
   * them in a dependency list -- a dep array is evaluated at its call site --
   * and read from the same render by every act, so a preview, a diff and a
   * push all describe one set of sheets. A tick whose sheet has no row any
   * more (deleted since) ticks nothing.
   */
  const ticked = tickedSheets(sheetSelection, availableSheets);
  const tickedSignature = sheetsSignature(ticked.map(sheetKey));

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The act a RETRYABLE refusal on screen came from -- the workbook changed
   * while it was being read, so nothing was written (`@api/backendRefusal`) --
   * and the exact text it was shown as. The strip offers "Try again" only while
   * that text is still the error on screen, so a later, different error never
   * inherits the button. Null = nothing to offer.
   */
  const [retry, setRetry] = useState<{ act: RetryableAct; shown: string } | null>(null);
  /**
   * Show what an act's failure says; when it is the retryable snapshot
   * refusal, also remember the act, so the strip can run it again at once.
   */
  const showActFailure = (act: RetryableAct, err: unknown, shown: string): void => {
    setError(shown);
    setRetry(isWorkbookChangedWhileSaving(err) ? { act, shown } : null);
  };
  const [report, setReport] = useState<PublishReport | null>(null);
  const [reportLabel, setReportLabel] = useState<string>("");
  /**
   * The input signature the visible report was computed FROM.
   *
   * The report names the sheets it would ship, and it goes stale the moment a
   * checkbox moves — so the panel could claim "would publish Sheet1, Sheet1 (2),
   * Sheet1 (3)" while only Sheet1 was ticked. On the surface whose entire job is
   * disclosing what leaves the machine, an overstatement is the worst direction
   * to be wrong in.
   */
  const [reportFor, setReportFor] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  /**
   * What a push to this target would leave in the workbook because it is not
   * the application's (BUG-0261), from the preview the dialog runs ON OPEN --
   * so it is on screen before the author presses Push, not only after a
   * manual Preview. It does not depend on the sheet selection (the filter
   * reads the working-copy link and the workbook's content), so the open-time
   * answer stays true while the checkboxes move.
   */
  const [withheld, setWithheld] = useState<WithheldContent[]>([]);
  /**
   * The buttons' code this push would carry (BUG-0257), from the same previews
   * as `withheld`: restored application code, held code that refuses the push,
   * and code the signed base does not have -- which the author must read and
   * tick. The ticks are the hashes the push request acknowledges.
   */
  const [buttonCode, setButtonCode] = useState<ButtonCodeRelease | null>(null);
  /**
   * WHICH sheet selection `buttonCode` answers (`sheetsSignature`). The code a
   * push carries depends on the sheets it carries, and the readiness gate reads
   * `buttonCode`: an answer for another selection used to block a push over
   * code on a sheet the author had unticked, and let a newly ticked sheet's code
   * go unshown until the backend refused it (review finding). Null = no answer.
   */
  const [buttonCodeFor, setButtonCodeFor] = useState<string | null>(null);
  const [ackedButtonCode, setAckedButtonCode] = useState<Set<string>>(new Set());
  /**
   * INCLUDE IN APPLICATION (M4): the author's own new macros, notebooks and
   * names they have chosen to ADD to the application -- each tick carrying the
   * hash RUST computed of the code they read -- and which code has been on
   * screen. A tick is refused until then (lib/includeInApplication.ts). Only
   * this dialog ever sends `includeInApplication`.
   */
  const [includeState, setIncludeState] = useState<IncludeState>(EMPTY_INCLUDE_STATE);
  /**
   * WHICH inclusion `withheld`, `added` and `unshippedLinks` answer
   * (`includeSignature`) -- the `buttonCodeFor` rule for the ticks: an answer
   * for another inclusion is fetched again, and the push waits for it.
   */
  const [includeFor, setIncludeFor] = useState<string | null>(null);
  /** The author's own items the latest answer ADDS to the application. */
  const [added, setAdded] = useState<WithheldContent[]>([]);
  /** Buttons on the ticked sheets that run a macro the push would leave out. */
  const [unshippedLinks, setUnshippedLinks] = useState<UnshippedMacroLinkItem[]>([]);
  /** Which inclusion the visible REPORT was computed for. */
  const [reportIncludeFor, setReportIncludeFor] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);
  /**
   * THE ACT RUNNING NOW, if any -- a push, from its hold-back through the
   * un-revert after it, a merge, or a Preview the author started by itself --
   * set SYNCHRONOUSLY before the act's first await, so a second press in the
   * same frame (a double-click, Push pressed again during the seconds a push
   * spends signing and writing, a Try again) finds it set before React has
   * re-rendered anything (review round 9, F3). A second push for the same
   * version and base used to go out beside the first: one landed, the other was
   * refused because the base had moved, and that refusal -- set last -- was
   * what the strip showed, for a push that had landed. ONE ref for every act: a
   * merge during a push, or a push during a merge, moves the base under the
   * other; and a Preview beside either writes the status line, the report and
   * the gates over the act's own (rounds 10 and 11).
   */
  const actInFlightRef = React.useRef<RunningAct | null>(null);
  /** The same, for rendering: Push, Merge and Preview are disabled while an act runs. */
  const [acting, setActing] = useState<RunningAct | null>(null);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  /**
   * The CODE this push changes against its signed base (owner question 14),
   * from the same working-copy diff -- the Promote dialog's summary, shown
   * first. `null` while there is no push to describe. A failed read is a
   * `failed` state that says why, never "no code changes".
   */
  const [code, setCode] = useState<PromotionCodeState | null>(null);
  const [merge, setMerge] = useState<MergeAnalysisResponse | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  /**
   * A merge analysis that FAILED, as the sentence it is shown as, and the base
   * -> head it was asked for (`mergeKey`).
   *
   * The analysis effect below used to re-run on its OWN completion: a failure
   * set `merge` back to null and `mergeBusy` back to false, which is exactly
   * that effect's trigger, so one refusal became an unbounded loop of full
   * in-memory publishes -- each pass two audited reads of the workspace, and a
   * signer refusal wrote an audit row on every one -- under a banner that said
   * "Working out whether their changes overlap yours..." for as long as the
   * dialog stayed open (review round 8). Now a failure is SAID, once, and asked
   * again only by the author (the banner's Try again) or for another base or
   * head (a merge, a re-read of the gates).
   */
  const [mergeFailure, setMergeFailure] = useState<{ key: string; message: string } | null>(null);
  /** The base -> head a merge analysis answers; a new pair gets one fresh analysis. */
  const mergeKey = `${workspace?.baseVersion ?? ""} -> ${gates?.registryLatest || workspace?.headVersion || ""}`;

  // ---- Load the workbook's own answer to "what am I?" ---------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [link, registries] = await Promise.all([
        workingCopyStatus().catch(() => null),
        listWorkspaces().catch(() => [] as SavedWorkspace[]),
      ]);
      if (cancelled) return;
      setSaved(registries);
      if (link) {
        setWorkspace(link);
        setRegistryPath(link.registryUrl);
        setPackageName(link.packageName);
        setKind(link.kind || "report");
        setVersion(link.suggestedNext?.patch ?? link.baseVersion);
        // NOT seeded from `link.baseSheets` any more: those are NAMES, and the
        // selection is now workbook indices. The backend's `defaultSheetIndices`
        // is the authority, and it already knows what to withhold.
        setMode("push");
      } else {
        setMode("create");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Preview: the content report AND the gate status --------------------
  //
  // A PREVIEW IS AN ACT TOO. Started by itself (the Preview button, Try
  // again), it holds the one act lock (`actInFlightRef`, "preview") from before
  // its first await until its `finally`, so Push and Merge render disabled and
  // refuse while it runs. `insideAct`: the act this preview is PART of -- a
  // merge refreshes the report and the gates with one once it has landed; that
  // refresh runs under the merge's lock, and neither takes it nor frees it.
  const runPreview = useCallback(
    async (label: string, insideAct?: RunningAct) => {
      // ONE ACT AT A TIME, PREVIEW INCLUDED, BOTH WAYS. A Preview pressed while
      // a push or a merge ran went out beside it, and its success path sets the
      // status line to null: "Pushing…" vanished mid-push and, once the push
      // had landed, so did "Pushed … to the development line" (review round 10).
      // And a Push or a Merge pressed while a Preview ran went out beside IT:
      // the slower Preview then took down the landed push's "Pushed …" line
      // (and the Open Application Explorer link with it) and put a "would
      // publish" preview where the published report was (review round 11,
      // RV11-TS-2). The buttons render disabled while `acting` is set; the ref
      // is the same rule for a press that beat the re-render, and for a Try
      // again (read synchronously, as the acts read it).
      if (actInFlightRef.current !== null && actInFlightRef.current !== insideAct) return;
      // SET BEFORE THE FIRST AWAIT, freed in the `finally` on every way out --
      // only by the Preview that took it: a merge's own refresh holds nothing.
      const ownsAct = insideAct === undefined;
      if (ownsAct) {
        actInFlightRef.current = "preview";
        setActing("preview");
      }
      try {
        setError(null);
        setStatus("Analyzing…");
        try {
          const target =
            registryPath.trim() && packageName.trim()
              ? { registryPath, packageName }
              : undefined;
          // BY ID: the preview describes the sheets the push will ship, wherever
          // they sit in the workbook by now.
          const asked = tickedWire();
          const including = includeList(includeState);
          const result = await publishPreview(asked, includeComments, target, kind, including);
          setReport(result.report);
          setWithheld(result.report.withheld ?? []);
          setAdded(result.report.addedToApplication ?? []);
          setIncludeState((prev) =>
            pruneTicks(prev, result.report.withheld ?? [], result.report.addedToApplication ?? []),
          );
          setUnshippedLinks(result.report.unshippedMacroLinks ?? []);
          setIncludeFor(JSON.stringify(including));
          setReportIncludeFor(JSON.stringify(including));
          setButtonCode(result.report.buttonCode ?? null);
          setButtonCodeFor(tickedSignature);
          setReportLabel(`${label} ${result.sheetNames.join(", ")}`);
          setWarnings(result.warnings);
          if (!requireVerifiedTouchedRef.current && typeof result.baseRequiresVerified === "boolean") {
            setRequireVerified(result.baseRequiresVerified);
          }
          setGates(result.gates ?? null);
          // A new list keeps every tick on ITS sheet: the ticks are ids, so a
          // renumbering since the last read moves none of them onto a neighbour.
          if (result.sheets) setAvailableSheets(result.sheets);
          if (result.defaultSheetIndices) {
            setDefaultIndices(result.defaultSheetIndices);
            if (!selectionTouchedRef.current)
              setSheetSelection(new Set(keysAt(result.defaultSheetIndices, result.sheets ?? [])));
          }
          setReportFor(previewSignature());
          setStatus(null);
        } catch (err: unknown) {
          // Every other error exactly as before; the retryable snapshot refusal
          // as its plain sentence, with "Try again" beside it; a ticked sheet
          // that is gone, or a position past the end of the list, as its plain
          // sentence, and the list read again.
          const shown = describeBackendRefusal(err);
          showActFailure("preview", err, shown);
          setStatus(null);
          if (needsTheSheetListAgain(err)) void readSheetListAgain(shown);
        }
      } finally {
        if (ownsAct) {
          actInFlightRef.current = null;
          setActing(null);
        }
      }
    },
    // The ticks and the list are read through `tickedWire` / `tickedSignature`;
    // the deps below are what actually change them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registryPath, packageName, includeComments, sheetSelection, availableSheets, includeState, kind],
  );

  // A preview with no sheet filter is how we learn the workbook's sheet names
  // for the checkbox list — there is no separate "list my sheets" call, and
  // inventing one would be a second source of truth for what a publish covers.
  useEffect(() => {
    if (mode === "loading") return;
    void (async () => {
      try {
        // The ticks as they stand when this runs; `includeFor` records which,
        // and the refresh below asks again if they have moved since.
        const including = includeList(includeState);
        const result = await publishPreview(
          [],
          false,
          registryPath.trim() && packageName.trim() ? { registryPath, packageName } : undefined,
          kind,
          including,
        );
        setWithheld(result.report.withheld ?? []);
        setAdded(result.report.addedToApplication ?? []);
        setIncludeState((prev) =>
          pruneTicks(prev, result.report.withheld ?? [], result.report.addedToApplication ?? []),
        );
        setUnshippedLinks(result.report.unshippedMacroLinks ?? []);
        setIncludeFor(JSON.stringify(including));
        setButtonCode(result.report.buttonCode ?? null);
        if (!requireVerifiedTouchedRef.current && typeof result.baseRequiresVerified === "boolean") {
          setRequireVerified(result.baseRequiresVerified);
        }
        if (result.sheets) setAvailableSheets(result.sheets);
        if (result.defaultSheetIndices) {
          setDefaultIndices(result.defaultSheetIndices);
          // Only while the user has not chosen: re-seeding after a checkbox
          // moved would silently undo their choice on every target change.
          // Only LISTED sheets: an index without a checkbox could never be
          // unticked (see lib/listedSheets.ts).
          if (!selectionTouchedRef.current) {
            // Positions read against the list FROM THIS SAME ANSWER, then kept
            // as the rows' stable ids.
            const seeded = keysAt(result.defaultSheetIndices, result.sheets ?? []);
            setSheetSelection(new Set(seeded));
            // This answer IS the default selection's -- no second fetch for it.
            setButtonCodeFor(sheetsSignature(seeded));
          } else {
            setButtonCodeFor(null);
          }
        }
        setGates(result.gates ?? null);
      } catch {
        // A failure here costs the checkbox list, not the dialog.
      }
    })();
    // Re-run when the target changes so the gate panel stays truthful -- and on
    // EVERY SHOW (`openCount`), so a dialog shown again while it is still open
    // reads the sheets the workbook has NOW (review round 9, F2). The
    // gone-sheet refusal tells the author to open the dialog again to see the
    // current sheets; before this, showing it again re-ran only the reset
    // above, and the list -- and the diff's "no longer in the workbook" --
    // stayed exactly as they were. The reset effect is declared ABOVE this one,
    // so in the same commit it has already cleared `selectionTouchedRef`, and
    // the read below seeds the backend's default from the fresh list; the diff
    // and the button-code review then follow the new list through their own
    // effects. On mount `openCount` is already set, so the list is read once.
  }, [mode, registryPath, packageName, openCount]);

  // The changes this push would make, computed by running the real publish
  // into memory and diffing it against the base. Loaded once the workbook is
  // known to be a working copy, because that is when there is a base to compare
  // against at all.
  //
  // IT DESCRIBES THE PUSH THE BUTTON WILL MAKE, which took two fixes.
  //
  // It used to call `diffWorkingCopy()` with no arguments. That meant (a) the
  // sheet selection was ignored — untick a sheet and the panel still described
  // a push that carried it — and (b) `includeComments` defaulted to false while
  // the actual publish may include them, so against a base published WITH
  // comments the working side had no `comments.json` and every comment read as
  // REMOVED. A change the push was not making, presented as a change it was.
  //
  // Deps are RAW STATE, plus `tickedSignature`, which is derived ABOVE this
  // effect: `tickedWire` and `previewSignature` are declared below it, and a
  // dep array is evaluated at the call site during render, so naming either
  // here is a ReferenceError on first render. They are called inside the body
  // instead, exactly as `runPreview` does. The signature is over stable ids, so
  // a renumbering that moves no tick asks nothing again, and a tick whose sheet
  // left the list does.
  useEffect(() => {
    if (mode !== "push" || !workspace?.baseVersion) return;
    // Explicit rather than accidental: an empty selection means "the publish
    // default", which for a working copy IS the link's base_sheets — benign,
    // but benign by coincidence. Wait until the list has loaded so the request
    // says what it means.
    if (availableSheets.length === 0) return;
    // NOTHING MOVES HERE, BEFORE THE ANSWER. Which sheets this push carries is
    // Rust's to say, not the ticked rows': a floating grid's backing sheet
    // travels with the page that hosts it, and a sheet a chart on a ticked
    // sheet reads joins the push. Sorting the unticks by the ticks HERE parked
    // an untick on such a sheet -- its row showed ticked again, the line under
    // the panel said its sheet was not in this push, and the push published the
    // cell (review round 11, RV11-TS-1). So every untick stays where the LAST
    // answer put it until THIS one lands (`.then` below). In between the push
    // is right either way: it sends every untick with its own selection, and
    // Rust holds back exactly the ones on sheets that push carries.
    //
    // NOTHING TICKED, NOTHING TO DESCRIBE. An empty selection means "the
    // default" on the wire, so fetching here would render a diff of the base
    // sheets under a list showing no selection — which is exactly the "glitchy"
    // panel this was reported as. The push is refused in that state anyway
    // (`pushBlockingReason`), so there is no push for the panel to describe --
    // and no answer to move an untick by: they all stay where they are.
    if (kind !== "library" && ticked.length === 0) {
      setDiff(null);
      setDiffError(null);
      setCode(null);
      return;
    }
    let cancelled = false;
    setDiffBusy(true);
    setDiffError(null);
    setCode(PROMOTION_CODE_LOADING);
    diffWorkingCopy({
      // By stable id, as the push sends them: the panel describes the push.
      ...tickedWire(),
      includeComments,
      includeInApplication: includeList(includeState),
      // THE CODE, from the same two sides as the cell diff: the signed base and
      // the push this dialog would make (owner question 14).
      codeSummary: true,
    })
      .then((result) => {
        if (cancelled) return;
        setDiff(result.diff);
        // THE HOLD-BACK FOLLOWS THE ANSWER, AND NEVER LOSES AN UNTICK TO IT.
        // `carriedSheetIds` is every sheet the in-memory publish behind this
        // answer wrote: the ticked ones, each floating grid's backing sheet with
        // its host, and the sheets the selection added (a chart's source). An
        // untick on one of them acts; any other is PARKED -- it holds nothing
        // back now, the line under the panel says so, and the next answer that
        // carries its sheet brings it back on its row (lib/holdBack.ts). A
        // re-read this dialog ran itself, a box moved on another sheet, or an
        // untick and re-tick of the change's own sheet (or of the page that
        // hosts it) never quietly ticks a held-back change again (review rounds
        // 9, 10 and 11). NEVER built from `diff.sheets`: that also lists every
        // unticked base sheet as "removed", which the push drops.
        const carried = new Set(result.carriedSheetIds);
        dispatchHoldBack({ type: "keepSheets", sheetIds: carried });
        // ...and on the sheets it CARRIES, only the unticks this answer shows
        // as ROWS stay. The rows are the only place an untick can be seen --
        // this dialog lists the sample and nothing else -- so one without a row
        // would act on a push nobody reviewed: the reason the set used to be
        // cleared here. ONLY those sheets (`carried`): a sheet the push does not
        // carry is not this answer's to judge -- a parked untick's sheet has no
        // rows here, and a "removed" sheet's rows describe a sheet that is not
        // published -- and that must never read as "no longer listed".
        dispatchHoldBack({ type: "keepRows", keys: rowKeysOf(result.diff), sheetIds: carried });
        // An answer without the code list is NOT "no code changes".
        setCode(
          result.code
            ? promotionCodeFromImpact(result.code)
            : promotionCodeFailed("the answer carried no code list"),
        );
      })
      .catch((e: unknown) => {
        // A missing base version or an unreachable workspace costs the diff
        // panel, not the dialog — the push gates still run server-side. The
        // code summary says the comparison failed: never swallowed. The
        // retryable snapshot refusal is said as its plain sentence (the code
        // summary's reader strips it too); the diff has no retry of its own --
        // it runs again when the selection moves.
        if (cancelled) return;
        // THE LAST ANSWER'S ROWS COME DOWN WITH IT (review round 10). They
        // described the selection BEFORE this one, and under "Could not
        // compare" they read as this push's changes -- a sheet unticked since
        // still listed, a newly ticked one missing. The unticks are kept where
        // the last answer put them, the strip under the panel goes on counting
        // the ones on sheets it said the push carries, and a push still sends
        // every one of them for Rust to judge.
        setDiff(null);
        setDiffError(describeBackendRefusal(e));
        setCode(promotionCodeFailed(e));
      })
      .finally(() => {
        if (!cancelled) setDiffBusy(false);
      });
    // THE EXCLUSIONS ARE SORTED AND PRUNED, NEVER CLEARED, ON A REFETCH (the
    // two dispatches above, both on the answer). While the answer is out -- and
    // after it fails -- the unticks stay where the last answer put them, the
    // strip under the panel keeps counting the ones on sheets it said the push
    // carries beside its "Push all" (see the strip for why that, rather than a
    // blocked Push), and a push sends every untick for Rust to judge.
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, workspace?.baseVersion, pushed, tickedSignature, availableSheets.length, includeComments, kind, includeState]);

  // When the base is stale, WHY it is stale matters more than the fact. Ask
  // whether the intervening work actually overlaps yours before telling the
  // user their push is refused — most of the time on a decomposed application it
  // does not, and "you two collided" would be false.
  const analyzeMerge = useCallback(async (key: string) => {
    setMergeBusy(true);
    setMergeFailure(null);
    try {
      setMerge(await pushMergeAnalyze());
    } catch (err: unknown) {
      // No analysis is a worse-informed banner, not a broken dialog -- but it
      // says WHY, in plain words, against the base -> head it was asked for,
      // and that pair is never asked again by itself (`mergeFailure`).
      setMerge(null);
      setMergeFailure({ key, message: explainPushError(err) });
    } finally {
      setMergeBusy(false);
    }
  }, []);

  useEffect(() => {
    const stale = gates?.baseStale ?? workspace?.isStale ?? false;
    // ONE analysis per base -> head: a failure for the pair on screen waits
    // for the author's Try again.
    if (mode === "push" && stale && !merge && !mergeBusy && mergeFailure?.key !== mergeKey) {
      void analyzeMerge(mergeKey);
    }
  }, [mode, gates?.baseStale, workspace?.isStale, merge, mergeBusy, mergeFailure, mergeKey, analyzeMerge]);

  const handleMerge = async () => {
    // ONE ACT AT A TIME (`actInFlightRef`): never a merge beside a running push,
    // a running Preview or a second merge, whether the banner's button or Try
    // again asked.
    if (actInFlightRef.current !== null) return;
    actInFlightRef.current = "merge";
    setActing("merge");
    try {
      setError(null);
      setStatus("Merging…");
      try {
        const result = await pushMergeApply();
        setStatus(
          `Merged with v${result.mergedFromVersion}` +
            (result.cellsApplied > 0
              ? ` — ${formatNumber(result.cellsApplied)} cell(s) from ${result.sheetsTouched.join(", ")}`
              : ""),
        );
        setMerge(null);
        // Everything downstream moved: the base, the gate statuses, the diff.
        const fresh = await workingCopyStatus();
        if (fresh) {
          setWorkspace(fresh);
          setVersion(fresh.suggestedNext?.patch ?? fresh.baseVersion);
        }
        // Part of THIS act, so it runs although the merge is still in flight.
        await runPreview(PREVIEW_LABEL, "merge");
      } catch (err: unknown) {
        showActFailure("merge", err, explainPushError(err));
        setStatus(null);
      }
    } finally {
      actInFlightRef.current = null;
      setActing(null);
    }
  };

  /** Everything a preview's answer depends on, as one comparable string. */
  const previewSignature = (): string =>
    JSON.stringify({ s: tickedSignature, c: includeComments });

  /**
   * The sheets to publish, as the publish doors read them: the ticked rows'
   * STABLE ids (`sheetIds`, which the backend takes in preference) beside their
   * positions in the list as last read -- positions alone only for a ticked row
   * the backend listed without an id (lib/listedSheets.ts `selectionWire`).
   * The push, its preview and the diff all send this, so a sheet dragged,
   * copied or deleted while the dialog is open can never hand a tick to a
   * neighbour, and "Try again" resends the same SHEETS, not the same positions.
   *
   * ALWAYS EXPLICIT once the list has loaded — never the empty array. Empty
   * means "resolve the default" to the backend, and the default now WITHHOLDS
   * subscribed sheets; sending it when the user has deliberately ticked one
   * would silently drop the thing they just asked for. The two collapses this
   * used to do (empty set, and all-ticked) both meant "empty", which is exactly
   * how that would have happened.
   */
  const tickedWire = (): PublishSheetSelection => {
    if (availableSheets.length === 0) return { sheetIndices: [] };
    return selectionWire(ticked);
  };

  // THE BUTTONS' CODE FOLLOWS THE TICK LIST. Whenever the selection it answers
  // is not the selection on screen, ask again -- only the button-code (and
  // withheld) part of the preview is taken, so the report the author pressed
  // Preview for is not replaced under them. Until the answer lands the push is
  // held back (`buttonCodeStale` in pushReadiness). A failed fetch leaves it
  // stale, and the readiness line says to press Preview.
  useEffect(() => {
    if (mode === "loading" || availableSheets.length === 0) return;
    const asked = tickedWire();
    const signature = tickedSignature;
    // THE INCLUSION IS PART OF THE QUESTION (M4): ticking "Include in
    // application" changes what ships, what stays behind and which buttons
    // still run a macro the push leaves out -- so a tick asks again, exactly as
    // a moved sheet checkbox does.
    const including = includeList(includeState);
    const includeSig = includeSignature(includeState);
    if (buttonCodeFor === signature && includeFor === includeSig) return;
    let cancelled = false;
    publishPreview(
      asked,
      includeComments,
      registryPath.trim() && packageName.trim() ? { registryPath, packageName } : undefined,
      kind,
      including,
    )
      .then((result) => {
        if (cancelled) return;
        setButtonCode(result.report.buttonCode ?? null);
        setWithheld(result.report.withheld ?? []);
        setAdded(result.report.addedToApplication ?? []);
        setIncludeState((prev) =>
          pruneTicks(prev, result.report.withheld ?? [], result.report.addedToApplication ?? []),
        );
        setUnshippedLinks(result.report.unshippedMacroLinks ?? []);
        setButtonCodeFor(signature);
        setIncludeFor(includeSig);
      })
      .catch(() => {
        // Stays stale: the readiness line asks for Preview.
      });
    return () => {
      cancelled = true;
    };
    // tickedWire reads state; the deps are what change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sheetSelection, availableSheets, registryPath, packageName, kind, buttonCodeFor, includeState, includeFor]);

  // Publishing is the ONE flow with two legitimate gestures, and the second is
  // not a fallback for old workspaces — Subscribe and Open-for-editing have no
  // folder button precisely because those always target a workspace that
  // already exists. Creating a NEW one is different: you cannot aim a file
  // picker at a `workspace.calcula` that has not been written yet, and it is
  // this publish that writes it.
  const handleBrowse = async () => {
    const selected = await pickWorkspaceFile();
    if (selected) setRegistryPath(selected);
  };

  const handleBrowseNewFolder = async () => {
    const selected = await pickWorkspaceFolder("Choose a Folder for the New Workspace");
    if (selected) setRegistryPath(selected);
  };

  const handlePublish = async () => {
    // ONE ACT AT A TIME, AND ONE PUSH PER VERSION (`actInFlightRef`). A press
    // while a push, a merge or a Preview is running -- or after a push has
    // landed -- does nothing at all: the button renders disabled then, and the
    // strip already says "Pushing…", "Merging…" or "Analyzing…". (A push beside
    // a Preview landed, and the slower Preview then took its receipt down:
    // review round 11, RV11-TS-2.) Deliberately NOT setError("A push is
    // already running."): the success path below never clears `error`, and the
    // strip shows `error ?? status`, so that sentence would outlive the push
    // and be the very wrong message this guard removes. `pushed` is checked
    // here because `pushBlockingReason` returns null once pushed, so only the
    // disabled button stood between a Try again and a second push.
    if (actInFlightRef.current !== null || pushed) return;
    // VALIDATE ON CLICK, don't just sit there disabled. The button used to be
    // `disabled={!canPush}`, and the single condition a filled-in-looking dialog
    // could still fail was the change summary — whose PLACEHOLDER is a complete
    // sentence, so an empty required field reads as a filled one. Pressing Push
    // then did nothing at all: no error, no status, no movement. A primary
    // action that silently ignores the click is indistinguishable from a broken
    // build, so the click now always produces an answer.
    const missing = blockingReason();
    if (missing) {
      setError(missing);
      setStatus(null);
      return;
    }
    // SET BEFORE THE FIRST AWAIT (the hold-back below), and cleared in the
    // outer `finally` only once the un-revert has finished: a next push whose
    // hold-back landed on top of this one's undo entry would make the scoped
    // un-revert refuse.
    actInFlightRef.current = "push";
    setActing("push");
    try {
      // THE SHEETS THIS PUSH SENDS, read ONCE and handed to both calls below:
      // the hold-back is told exactly the selection the publish after it sends,
      // so the cells Rust holds back are the ones on the sheets this very push
      // carries.
      const selection = tickedWire();
      setError(null);

      // HOLD BACK THE UNTICKED CELLS, then publish, then always put them back.
      //
      // The `finally` below is the entire safety property, and it is why this
      // lives here rather than inside `calp_publish`: guaranteeing an un-revert
      // across that command's six `?` sites would mean restructuring its critical
      // region, and the guard that pins that region's shape goes BLIND rather
      // than red when it moves.
      //
      // What the author sees: their sheet holds the base values while the publish
      // runs, then snaps back. If the app dies in between, the hold-back is in the
      // undo stack and the document is dirty — Ctrl+Z and AutoRecover both
      // recover it.
      //
      // THE ID, NOT A BARE UNDO. The un-revert below names the entry it is
      // reversing, because this dialog is non-modal and a publish takes seconds:
      // the author can edit, and an MCP tool or a script can write, while it runs.
      // A blind `pop_undo()` there reverses whichever of those landed last and
      // leaves the held-back cells rolled back for good.
      //
      // EVERY UNTICK, ACTING AND PARKED, WITH THE PUSH'S OWN SELECTION. Which
      // sheets a push carries is Rust's to say -- the ticked ones, each floating
      // grid's backing sheet with its host, every sheet a chart on a carried
      // sheet reads -- so the hold-back resolves this push's `kind` and
      // `selection` the way the publish does and holds back exactly the cells
      // on sheets it carries, skipping the rest (`cellsSkipped`). Sending only
      // the unticks this dialog had sorted as acting published an untick on a
      // sheet that travels with another (review round 11, RV11-TS-1), and a
      // parked untick whose sheet the push carries again before the diff says
      // so must act too. Over-sending is harmless; under-sending is the leak.
      let holdBackSeq: number | null = null;
      if (mode === "push" && untickedCells.size > 0 && workspace?.baseVersion) {
        setStatus("Holding back unticked changes…");
        try {
          const r = await holdBackCells({
            registryPath,
            packageName,
            baseVersion: workspace.baseVersion,
            cells: [...untickedCells].map(parseCellKey),
            kind,
            ...selection,
          });
          holdBackSeq = r.undoSeq ?? null;
          // A write with no id to scope its reversal to is the unsafe shape this
          // was disabled for. It should be unreachable — `undoRecorded` is now
          // derived from the id — so treat the disagreement as the refusal it is
          // rather than falling back to a bare undo.
          if (r.undoRecorded && holdBackSeq === null) {
            setStatus(null);
            setError(
              "Could not hold back the unticked changes safely, so nothing was published. " +
                "Press Ctrl+Z once if your sheet is showing the published version's values.",
            );
            return;
          }
          // The canvas is still showing what was there before the hold-back.
          window.dispatchEvent(new CustomEvent("grid:refresh"));
        } catch (e: unknown) {
          setStatus(null);
          // THE PUSH'S OWN SELECTION IS PART OF THIS REQUEST, so the hold-back
          // meets the refusals the publish would meet, BEFORE it writes
          // anything: a ticked sheet that is gone (`CALP_PUSH_SHEET_GONE`), a
          // position past the end of the list, or the retryable snapshot
          // refusal. Each is said and handled exactly as the publish's own
          // below -- its plain sentence, "Try again" only for the retryable
          // one, the sheet list read again for the other two -- never as the
          // raw code beside a Ctrl+Z hint for a write that never happened.
          // Any other CALP_PUSH_ refusal (a ticked sheet without a stable id) is
          // the resolver refusing before anything was written, too.
          if (isWorkbookChangedWhileSaving(e) || needsTheSheetListAgain(e) || /CALP_PUSH_[A-Z_]+:/.test(String(e))) {
            const shown = explainPushError(e);
            showActFailure("push", e, shown);
            if (needsTheSheetListAgain(e)) void readSheetListAgain(shown);
            return;
          }
          // Nothing was published. The hold-back either refused before writing —
          // `CALP_HOLDBACK_NOT_DERIVABLE` (a cell downstream of an unticked change
          // reads a data model, writeback submissions or a custom function, none
          // of which this workbook can recompute) — or it failed partway, in
          // which case the partial write is on the undo stack and the document
          // is dirty.
          const message = String(e).replace(/^CALP_HOLDBACK_\w+:\s*/, "");
          setError(
            `Nothing was published. ${message}` +
              (String(e).includes("CALP_HOLDBACK_")
                ? ""
                : " If your sheet is showing the published version's values, press Ctrl+Z once."),
          );
          return;
        }
      }

      setStatus(mode === "push" ? "Pushing…" : "Publishing…");
      try {
        const result = await publishApplication({
          registryPath,
          packageName,
          version,
          kind,
          // THE TICKED SHEETS BY STABLE ID (`sheetIds`, beside their positions):
          // Rust resolves them against the sheet list as it is NOW, and refuses
          // an id that is gone by name -- never a neighbour (review round 9).
          // The very `selection` the hold-back above was told.
          ...selection,
          // Stamped backend-side from the signing identity; sent for wire
          // compatibility only. A display name the caller types is a display name
          // that can disagree with the key beside it in the version list.
          publishedBy: "",
          includeComments,
          mode: mode === "push" ? "update" : "createNew",
          expectedBaseVersion: mode === "push" ? workspace?.baseVersion : undefined,
          changeSummary,
          // Only code the dialog SHOWED and the author ticked (BUG-0257).
          acknowledgedButtonCode: [...ackedButtonCode],
          // Only items whose code the dialog SHOWED, each with the hash Rust
          // computed of it (M4).
          includeInApplication: includeList(includeState),
          // The identity rule: only the author's own change (see `requireVerified`).
          requireVerifiedIdentity: identityRuleToSend(requireVerifiedTouchedRef.current, requireVerified),
        });
        // WHERE THE RELEASE NOW STANDS. "Pushed v1.5.0" answers where the bytes
        // went, not who receives them, and the whole point of environments is
        // that those are different questions. The landing line names each
        // environment and its version — and is EMPTY when the application has
        // none, so a solo workbook is not told about a feature it has not adopted.
        const landing = describePushLanding(result.version, workspace?.environments ?? []);
        setStatus(
          `${mode === "push" ? "Pushed" : "Published"} ${result.packageName} v${result.version} to the ` +
            `development line: ${formatNumber(result.sheetsPublished)} sheet(s).` +
            (landing ? ` ${landing}` : ""),
        );
        // Anything reading the pipeline is now stale: the head moved, which is
        // what the first environment promotes FROM.
        emitAppEvent(ENVIRONMENTS_CHANGED_EVENT, { registryPath, packageName });
        setReport(result.report);
        setWithheld(result.report.withheld ?? []);
        setAdded(result.report.addedToApplication ?? []);
        setUnshippedLinks(result.report.unshippedMacroLinks ?? []);
        setIncludeFor(includeSignature(includeState));
        setReportIncludeFor(includeSignature(includeState));
        setButtonCode(result.report.buttonCode ?? null);
        setButtonCodeFor(tickedSignature);
        setReportLabel(`Published ${result.packageName} v${result.version}`);
        setWarnings(result.warnings);
        setPushed(true);
        // THE HOLD-BACK BELONGS TO ONE PUSH, and this one landed: the next push
        // starts with every change ticked and nothing parked, exactly as a new
        // show does. (The un-revert in the `finally` below already has its
        // cells; the diff effect only sorts and prunes, never clears, so this
        // is the one place a landed push is forgotten.)
        dispatchHoldBack({ type: "reset" });
        // The link moved; re-read so the panel shows the new base.
        workingCopyStatus()
          .then((s) => {
            if (s) {
              setWorkspace(s);
              setMode("push");
            }
          })
          .catch(() => undefined);
      } catch (err: unknown) {
        const shown = explainPushError(err);
        showActFailure("push", err, shown);
        setStatus(null);
        // A TICKED SHEET IS GONE, or a position is past the end of the list:
        // the same request can never succeed, so there is no Try again -- the
        // list is read again instead (`readSheetListAgain`).
        if (needsTheSheetListAgain(err)) void readSheetListAgain(shown);
        // A push refused over button code the review did not show (it changed
        // since, or was never fetched for this selection): fetch it again, so
        // the items can be read and ticked instead of the refusal repeating.
        if (/CALP_PUSH_(BUTTON_CODE_UNREVIEWED|HELD_CODE_UNVERIFIED)/.test(String(err))) {
          setButtonCodeFor(null);
        }
        // Refused over what was included, or over a button whose macro the push
        // leaves out (M4): the answer on screen was wrong about this push, so
        // fetch it again -- the items and their remedies come back to act on.
        if (/CALP_PUSH_(INCLUDED_CHANGED|BUTTON_MACRO_NOT_SHIPPED)/.test(String(err))) {
          setButtonCodeFor(null);
          setIncludeFor(null);
        }
      } finally {
        // ALWAYS, on both paths. A failed publish must not leave the author's
        // workbook holding the base values, and a SUCCESSFUL one must not either
        // — the whole point is that the held-back edits stay local.
        if (holdBackSeq !== null) {
          try {
            // SCOPED to the entry the hold-back left. If anything landed on the
            // history since — the author's own edit in this non-modal dialog, an
            // MCP tool, a script — this refuses instead of reversing it, and says
            // how many Ctrl+Z it now takes to reach the hold-back.
            const r = await undo(holdBackSeq);
            // The undo restored the cells; the canvas is still showing what the
            // hold-back painted.
            window.dispatchEvent(new CustomEvent("grid:refresh"));
            if (r.refusal) {
              setError(
                `Your unticked changes were rolled back for the push and were NOT ` +
                  `restored automatically. ${r.refusal}`,
              );
            }
          } catch (e: unknown) {
            // The one failure this dialog cannot repair, so it must not be quiet:
            // the author's edits are still in the undo stack, and that is the
            // sentence they need.
            setError(
              `Your unticked changes were rolled back for the push and could NOT be ` +
                `restored automatically (${String(e)}). Press Ctrl+Z once to bring them back.`,
            );
          }
        }
      }
    } finally {
      // Every way out -- the hold-back's early returns included -- frees the
      // dialog for the next act, and only after the un-revert above.
      actInFlightRef.current = null;
      setActing(null);
    }
  };

  /**
   * The strip's "Try again": the refused act, run again through the very
   * handler its own button calls -- so a retried push holds back and puts back
   * the unticked cells exactly as the first press did, and sends the ticked
   * sheets BY ID: the renumbering that caused the refusal cannot move a tick.
   */
  const retryAct = (act: RetryableAct): void => {
    if (act === "push") void handlePublish();
    else if (act === "merge") void handleMerge();
    else void runPreview(PREVIEW_LABEL);
  };

  /**
   * A TICKED SHEET IS GONE (`CALP_PUSH_SHEET_GONE`): the push or its preview
   * named, by stable id, a sheet the workbook no longer has -- the author
   * deleted it while this non-modal dialog was open, or an agent did. Nothing
   * was published, and the same ids can never succeed, so nothing offers
   * "Try again". The list is read again instead: it then shows the sheets that
   * exist now (the gone sheet's tick has no row left to tick, so nothing sends
   * it), the review panels follow it through their own effects, and the
   * sentence on screen says the list was read. The same for a position past
   * the end of the list (`CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE`), which only the
   * positions-only fallback can send (a ticked row listed without an id,
   * lib/listedSheets.ts `selectionWire`): resending those positions could only
   * meet the same refusal, so it is never offered either.
   *
   * A failed read leaves the list as it was. The refusal's own sentence tells
   * the author to open the dialog again, and that now works: EVERY SHOW reads
   * the list again (the list loader's `openCount` dependency, review round 9
   * F2), and so does the next Preview.
   *
   * Only on these two acts the author started: the diff and the button-code
   * review run by themselves, and a re-read that re-ran them would be a loop
   * waiting for a backend that keeps saying "gone".
   */
  const readSheetListAgain = async (shown: string): Promise<void> => {
    const target =
      registryPath.trim() && packageName.trim() ? { registryPath, packageName } : undefined;
    try {
      const listed = await publishPreview([], false, target, kind, includeList(includeState));
      if (listed.sheets) setAvailableSheets(listed.sheets);
      if (listed.defaultSheetIndices && !selectionTouchedRef.current) {
        setSheetSelection(new Set(keysAt(listed.defaultSheetIndices, listed.sheets ?? [])));
      }
      setError((now) => (now === shown ? `${shown} ${SHEET_LIST_READ_AGAIN}` : now));
    } catch {
      // The list stays as it was; the sentence on screen says what to do.
    }
  };

  // Read what the workspace already holds, so a taken name is knowable BEFORE
  // the button rather than as a refusal after it. Create mode only: a push
  // already knows its application, and listing the others would be noise.
  useEffect(() => {
    if (mode !== "create" || registryPath.trim() === "") {
      setExistingApps(null);
      return;
    }
    let cancelled = false;
    setExistingApps(null);
    listApplicationsInWorkspace(registryPath)
      .then((apps) => {
        if (!cancelled) setExistingApps(apps);
      })
      .catch(() => {
        // An unreachable or not-yet-a-workspace location costs the LISTING, not
        // the dialog — the publish gates still run server-side, and refusing to
        // show the name field because a folder could not be read would be worse
        // than showing it without the hint.
        if (!cancelled) setExistingApps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, registryPath]);

  /**
   * Subscribed sheets the author has TICKED — somebody else's content, about to
   * leave under this author's name and signature.
   *
   * Not a refusal, deliberately. Republishing a vendor's sheet inside a
   * composite report is legitimate with permission, and a dead checkbox would
   * push people to copy-paste the content into a fresh sheet instead — which
   * strips the provenance badge, drops it out of the subscription ledger, and
   * takes it out of every guard built around it. That converts a DISCLOSED
   * republish into an undetectable one, which is worse than the thing it was
   * meant to prevent.
   *
   * What was thin is WHEN it is disclosed: the publish report says so
   * afterwards, and nothing said so at the moment of ticking. This is that
   * moment.
   */
  const tickedSubscribed = ticked.filter((s) => s.subscribedTo);

  /**
   * The application this name would collide with, if any.
   *
   * CASE-INSENSITIVE. `get_application_manifest` resolves a name to a directory,
   * and on Windows that lookup is case-insensitive — so `Sales` and `sales` are
   * one application on the platform this ships on, and a case-sensitive hint
   * would promise a name the publish then refuses.
   */
  const nameClash =
    mode === "create" && packageName.trim() !== ""
      ? (existingApps ?? []).find(
          (a) => a.name.toLowerCase() === packageName.trim().toLowerCase(),
        ) ?? null
      : null;

  // Why this dialog cannot push yet, in the user's words — shown live beside the
  // button AND returned on click, so the reason is visible before the gesture and
  // unmissable after it. Pure and unit-tested; see lib/pushReadiness.ts for why
  // it is a sentence rather than the boolean it used to be.
  const blockingReason = (): string | null =>
    pushBlockingReason({
      mode,
      registryPath,
      packageName,
      version,
      changeSummary,
      pushed,
      sheetsSelected: ticked.length,
      sheetsAvailable: availableSheets.length,
      kind,
      nameAlreadyTaken: nameClash !== null,
      buttonCodeRefused: buttonCode?.refused.length ?? 0,
      buttonCodeUnacknowledged: unacknowledgedButtonCode(buttonCode, ackedButtonCode),
      buttonCodeStale:
        mode !== "loading" &&
        availableSheets.length > 0 &&
        buttonCodeFor !== tickedSignature,
      unshippedMacroLinks: unshippedLinks,
      includeStale:
        mode !== "loading" &&
        availableSheets.length > 0 &&
        includeFor !== includeSignature(includeState),
      includeChanged:
        includeFor === includeSignature(includeState)
          ? unhonouredIncludes(includeState, added).map((tick) => {
              const known = [...withheld, ...added].find((w) => itemKey(w) === itemKey(tick));
              return known?.name || tick.id;
            })
          : [],
    });
  const blocked = blockingReason();
  const canPush = !blocked && !pushed && acting === null;

  /**
   * What an "Include in application" row may do, for every list in this dialog
   * (IncludeInApplicationContext). `setIncluded` refuses a tick whose code has
   * not been on screen, whatever the checkbox's own state says.
   */
  const includeControls: IncludeControls = {
    isIncluded: (item) => isIncluded(includeState, item),
    isTickedForOtherCode: (item) => isTickedForOtherCode(includeState, item),
    isReviewed: (item) => isReviewed(includeState, item),
    review: (item) => setIncludeState((prev) => markReviewed(prev, item)),
    setIncluded: (item, include) => setIncludeState((prev) => setIncluded(prev, item, include)),
  };

  // ---- layout -------------------------------------------------------------
  /**
   * FORM on the left, REVIEW pinned beside it — but only for a push.
   *
   * This is not a wizard: there is no step sequence and no dependency chain in
   * the vertical order. The banner, the diff, the warnings and the report are
   * reactive OUTPUTS that recompute from the form, and stacking them made the
   * push ~1150px tall against a frame of ~690px on 1080p — ~400px at 150%
   * scaling. Worse than the height, the order was hostile: the Sheets checklist
   * sat BELOW the "Changes since vN" box it invalidates, and the report's own
   * "Out of date — the sheet selection changed" banner rendered at the very
   * bottom of the scroll, below the control that staled it. The error strip was
   * already lifted out of this scroll for the same reason (see below).
   *
   * Create mode is excluded deliberately: it has no banner, never fetches a
   * diff, and has a null report until Preview is pressed, so a second pane
   * would open EMPTY beside five narrow fields — worse than one column.
   */
  const twoPane = mode === "push" && !isNarrowBody;
  /** Is there anything for the review side to hold? A push always has a diff. */
  const hasReview =
    mode === "push" ||
    warnings.length > 0 ||
    report !== null ||
    buttonCode !== null ||
    unshippedLinks.length > 0 ||
    added.length > 0 ||
    withheld.length > 0;

  // ---- styles -------------------------------------------------------------
  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "8%",
    transform: "translateX(-50%)",
    // Room for two panes when there are two; the old narrow column otherwise
    // (620, not 540: create mode's workspace row is an input and two buttons).
    //
    // Keyed on `mode`, NOT on `twoPane`. Deriving the width from `twoPane`
    // closes a cycle that 620px absorbs: the dialog opens in `loading` mode at
    // 620, the mount effect measures the body at ~618, `isNarrowBody` latches
    // true, and when the awaited status resolves to `push` the width expression
    // still reads 620 — so nothing ever re-measures and the two-pane layout can
    // never appear on open. `mode` is not a function of any measurement, so
    // `isNarrowBody` stays a pure CONSUMER of the width: it can only collapse a
    // dialog that is already wide, which terminates.
    width: mode === "push" ? dialogWidth(1040) : dialogWidth(620),
    maxHeight: "84vh",
    zIndex: 1050,
    display: "flex",
    flexDirection: "column",
    background: "var(--panel-bg)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: "8px",
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: "13px",
  };
  const headerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 12px",
    flexShrink: 0,
    cursor: "grab",
    userSelect: "none",
    borderBottom: "1px solid var(--border-default)",
  };
  const closeButtonStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "14px",
    lineHeight: 1,
  };
  const footerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "10px 16px",
    flexShrink: 0,
    borderTop: "1px solid var(--border-default)",
  };
  const fieldStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "10px",
  };
  const inputStyle: React.CSSProperties = {
    padding: "4px 6px",
    border: "1px solid var(--border-default)",
    borderRadius: "3px",
    fontSize: "13px",
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
  };
  const readOnlyValueStyle: React.CSSProperties = {
    padding: "4px 6px",
    background: "var(--bg-subtle, rgba(127,127,127,0.08))",
    border: "1px solid var(--border-default)",
    borderRadius: "3px",
    color: "var(--text-secondary)",
  };

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>
          {mode === "push" ? `Push to ${packageName}` : "Publish Application"}
        </span>
        <button style={closeButtonStyle} onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>

      {/*
        When there are two panes, each scrolls its own column. When there is one
        — create mode, or a push dragged narrow — the BODY scrolls and the panes
        just stack at their natural height, which is exactly the single scroller
        this dialog always had.
      */}
      <IncludeInApplicationContext.Provider value={includeControls}>
      <DialogBody
        ref={split.containerRef}
        stacked={!twoPane}
        style={twoPane ? undefined : { overflowY: "auto" }}
      >
        <DialogPane
          scroll={twoPane}
          padding="12px 16px"
          style={twoPane ? split.primaryStyle : { flex: "0 0 auto" }}
          data-testid="publish-dialog-form"
        >
        {mode === "loading" && (
          <div style={{ color: "var(--text-secondary)" }}>Reading workbook…</div>
        )}

        {mode === "push" && workspace && (
          <WorkspaceBanner
            workspace={workspace}
            gates={gates}
            merge={merge}
            mergeBusy={mergeBusy}
            // Only a failure for the base -> head on screen: one for another
            // pair is about to be asked again.
            mergeFailure={mergeFailure?.key === mergeKey ? mergeFailure.message : null}
            onRetryAnalysis={() => void analyzeMerge(mergeKey)}
            onMerge={handleMerge}
            // A push, a merge or a Preview is running: the one Merge button
            // waits for it.
            mergeDisabled={acting !== null}
          />
        )}

        {mode === "create" && (
          <div
            style={{
              fontSize: "12px",
              color: "var(--text-secondary)",
              marginBottom: "12px",
              lineHeight: 1.45,
            }}
          >
            This workbook is not yet a working copy of any package. Publishing it
            creates one and links this workbook to it, so later changes are
            pushed as new versions rather than re-entered by hand.
          </div>
        )}

        {mode === "create" && (
          <>
            <div style={fieldStyle}>
              <label>Workspace</label>
              {saved.length > 0 && (
                <select
                  style={inputStyle}
                  value={saved.find((r) => r.location === registryPath)?.id ?? ""}
                  onChange={(e) => {
                    const reg = saved.find((r) => r.id === e.target.value);
                    if (reg) setRegistryPath(reg.location);
                  }}
                >
                  <option value="">Choose a saved workspace…</option>
                  {saved.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} — {r.location}
                    </option>
                  ))}
                </select>
              )}
              <div style={{ display: "flex", gap: "4px" }}>
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={registryPath}
                  onChange={(e) => setRegistryPath(e.target.value)}
                  placeholder="C:\shared\workspace"
                />
                <button onClick={handleBrowse} style={{ whiteSpace: "nowrap" }}>
                  Browse…
                </button>
                <button
                  onClick={handleBrowseNewFolder}
                  style={{ whiteSpace: "nowrap" }}
                  title="Create a workspace in a folder that is not one yet — publishing writes its workspace.calcula pointer file"
                >
                  New workspace…
                </button>
              </div>
            </div>
            <div style={fieldStyle}>
              <label>Application Name</label>
              <input
                style={inputStyle}
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                placeholder="sales-report"
              />
              {/* WHAT IS ALREADY IN THERE. The dialog used to say nothing about
                  the workspace it was pointed at, so a name that was already
                  taken produced `ApplicationAlreadyExists` only after clicking
                  Publish — a refusal for something knowable the moment the
                  workspace was chosen. */}
              {existingApps === null && registryPath.trim() !== "" && (
                <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                  Reading the workspace…
                </div>
              )}
              {existingApps !== null && existingApps.length === 0 && (
                <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                  This workspace has no applications yet.
                </div>
              )}
              {existingApps !== null && existingApps.length > 0 && !nameClash && (
                <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                  Already here: {existingApps.map((a) => a.name).join(", ")}
                </div>
              )}
              {nameClash && (
                <div
                  style={{
                    fontSize: "12px",
                    marginTop: 4,
                    padding: "8px",
                    borderRadius: "4px",
                    background: "var(--conflict-bg, #fff3cd)",
                    color: "var(--conflict-text, #856404)",
                  }}
                >
                  <div>
                    <strong>{nameClash.name}</strong> already exists in this workspace
                    {nameClash.versions.length > 0 && (
                      <> (latest v{nameClash.versions[nameClash.versions.length - 1].version})</>
                    )}
                    . Publishing cannot create a second application under that name.
                  </div>
                  {/* THE RIGHT DOOR, not a second publish path. Adding a sheet to
                      an application you never checked out has no base version to
                      declare, so nothing could tell whether you were about to
                      overwrite somebody else's push. Checkout gives you that
                      base; your own sheets stay where they are. */}
                  <div style={{ marginTop: 6 }}>
                    To add a sheet to it, open it for editing first — your own sheets
                    stay where they are, and the push carries the application&rsquo;s.
                  </div>
                  <button
                    style={{ marginTop: 6, fontSize: "11px" }}
                    onClick={() => {
                      showDialog(CHECKOUT_DIALOG_ID, {
                        registryPath,
                        packageName: nameClash.name,
                      });
                      onClose();
                    }}
                  >
                    Open &ldquo;{nameClash.name}&rdquo; for editing instead
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {mode === "push" && (
          <div style={fieldStyle}>
            <label>Publishing to</label>
            <div style={readOnlyValueStyle}>
              {packageName} — {registryPath}
            </div>
          </div>
        )}

        {mode !== "loading" && (
          <div style={fieldStyle}>
            <label>Version</label>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                style={{ ...inputStyle, width: "120px" }}
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
              {workspace?.suggestedNext && (
                <div style={{ display: "flex", gap: "4px" }}>
                  {(["patch", "minor", "major"] as const).map((bump) => (
                    <button
                      key={bump}
                      onClick={() => setVersion(workspace.suggestedNext![bump])}
                      title={`v${workspace.suggestedNext![bump]}`}
                      style={{
                        fontSize: "11px",
                        padding: "2px 8px",
                        fontWeight: version === workspace.suggestedNext![bump] ? 600 : 400,
                      }}
                    >
                      {bump}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {workspace?.suggestedNext && (
              <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                A major bump tells subscribers their local edits may not survive.
              </div>
            )}
          </div>
        )}

        {/*
          "Changes since v…" used to render HERE, between the version and the
          summary — which put the Sheets checklist BELOW the diff that checklist
          invalidates. It is an output of this form, not a field in it, so it
          now lives on the review side; see the side pane below.
        */}

        {mode !== "loading" && (
          <div style={fieldStyle}>
            <label>
              What changed{mode === "push" ? " (required)" : " (optional)"}
            </label>
            {/*
              An EMPTY required field must not look like a filled one. The
              placeholder here is a complete sentence — good guidance, and
              indistinguishable at a glance from a value somebody typed — so the
              empty state is marked on the control itself rather than left to be
              inferred from grey text.
            */}
            <textarea
              style={{
                ...inputStyle,
                minHeight: "56px",
                resize: "vertical",
                fontFamily: "inherit",
                ...(mode === "push" && changeSummary.trim() === ""
                  ? { borderColor: "#c5221f", background: "#fdeceb" }
                  : {}),
              }}
              value={changeSummary}
              onChange={(e) => setChangeSummary(e.target.value)}
              placeholder="e.g. Adds the regional split to the summary sheet and a Refresh button."
            />
            <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
              {mode === "push" && changeSummary.trim() === "" ? (
                <span style={{ color: "#c5221f" }}>
                  Required — this box is still empty; the sentence in it is an
                  example.{" "}
                </span>
              ) : null}
              Stored inside the signed version manifest — subscribers and
              co-developers read it in the version history.
            </div>
          </div>
        )}

        {mode !== "loading" && availableSheets.length > 0 && (
          <div style={fieldStyle}>
            <label>Sheets</label>
            {/* NO 140px CAP AND NO SCROLLER OF ITS OWN. The pane this sits in
                scrolls, and a 140px box nested inside a scrolling column traps
                the wheel in the one list whose whole job is letting the author
                see what leaves the machine. */}
            <div
              style={{
                border: "1px solid var(--border-default)",
                borderRadius: "3px",
                padding: "4px 6px",
              }}
            >
              {availableSheets.map((sheet) => {
                const name = sheet.name;
                // BY SHEET ID, never by name. `base_sheets` records each name as
                // it stood at CHECKOUT, and additive checkout renames on
                // collision: pull an application's "Sheet1" into a workbook that
                // already has one and the application's sheet becomes
                // "Sheet1 (2)". Name-matching then marks the application's own
                // sheet "(new — not in v…)" while quietly counting the author's
                // unrelated "Sheet1" as part of the application. Reported from
                // live testing, from exactly that sequence.
                //
                // The ids line up because a working copy's sheet ids ARE the
                // application's — that preservation is what checkout is for.
                const inBase =
                  workspace?.baseSheets.some((s) => s.sheetId === sheet.sheetId) ?? false;
                // THE TICK IS THE SHEET'S ID, so it stays on this sheet however
                // the list is renumbered under the dialog.
                const key = sheetKey(sheet);
                return (
                  <label
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "2px 0",
                      cursor: "pointer",
                      // A HINT, not a selection. When this dialog was opened
                      // from a sheet tab, mark where that sheet sits in the
                      // push — but never tick it. A right-click that changes
                      // what leaves the machine is the thing the "(new — not in
                      // v…)" marker exists to keep deliberate.
                      background:
                        focusSheetName === name ? "var(--bg-selected, #e8f0fe)" : undefined,
                      borderRadius: focusSheetName === name ? "3px" : undefined,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={sheetSelection.has(key)}
                      onChange={(e) => {
                        setSelectionTouched(true);
                        selectionTouchedRef.current = true;
                        setSheetSelection((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                          return next;
                        });
                      }}
                    />
                    <span>{name}</span>
                    {sheet.kind === "canvas" && (
                      <span
                        data-testid="publish-sheet-kind-canvas"
                        title="A canvas sheet: a report page of charts, slicers, shapes and floating grids. Its objects travel with it."
                        style={{ marginLeft: 6, fontSize: 11, opacity: 0.75 }}
                      >
                        (canvas)
                      </span>
                    )}
                    {/*
                      A subscribed sheet is somebody else's content. It is
                      unticked by default and says whose it is right here, so
                      ticking it is an informed act rather than an accident.
                    */}
                    {sheet.subscribedTo && (
                      <span
                        style={{
                          fontSize: "11px",
                          color: "#137333",
                          background: "#e8f5e9",
                          borderRadius: "8px",
                          padding: "0 6px",
                        }}
                        title={
                          `This sheet came from the application "${sheet.subscribedTo}". ` +
                          "Publishing it republishes another publisher's content under your name."
                        }
                      >
                        ↓ from {sheet.subscribedTo}
                      </span>
                    )}
                    {mode === "push" && !inBase && !sheet.subscribedTo && (
                      <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                        (new — not in v{workspace?.baseVersion})
                      </span>
                    )}
                    {/* THE NAME IT WILL PUBLISH UNDER, when that differs from
                        the tab. A local collision rename is not carried
                        upstream, so the row said "Data (2)" while subscribers
                        received "Data" — and when the restoration produced a
                        duplicate, the refusal named a sheet that appeared
                        nowhere in this list. The component already holds both:
                        `inBase` two lines up reads the same `baseSheets`. */}
                    {mode === "push" &&
                      (() => {
                        const published = workspace?.baseSheets.find(
                          (s) => s.sheetId === sheet.sheetId,
                        )?.name;
                        return published && published !== name ? (
                          <span
                            style={{ fontSize: "11px", color: "var(--text-secondary)" }}
                            title={`This tab is named "${name}" locally. The application knows it as "${published}", and a push does not carry a rename.`}
                          >
                            publishes as &ldquo;{published}&rdquo;
                          </span>
                        ) : null;
                      })()}
                  </label>
                );
              })}
            </div>
            {/* AT THE MOMENT OF TICKING, not in the report afterwards. Ticking
                is allowed — see `tickedSubscribed` for why a dead checkbox
                would be worse — but it must not be quiet. */}
            {tickedSubscribed.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  padding: "8px",
                  borderRadius: "4px",
                  fontSize: "12px",
                  background: "var(--conflict-bg, #fff3cd)",
                  color: "var(--conflict-text, #856404)",
                }}
              >
                {tickedSubscribed.length === 1 ? (
                  <>
                    <strong>{tickedSubscribed[0].name}</strong> came from{" "}
                    <strong>{tickedSubscribed[0].subscribedTo}</strong>.
                  </>
                ) : (
                  <>
                    <strong>{tickedSubscribed.length} sheets</strong> came from{" "}
                    {[...new Set(tickedSubscribed.map((s) => s.subscribedTo))].join(", ")}.
                  </>
                )}{" "}
                Publishing {tickedSubscribed.length === 1 ? "it" : "them"} redistributes
                another publisher&rsquo;s content inside your application, under your name
                and signature. Your local edits to{" "}
                {tickedSubscribed.length === 1 ? "it" : "them"} travel too. Untick to leave{" "}
                {tickedSubscribed.length === 1 ? "it" : "them"} behind.
              </div>
            )}
          </div>
        )}

        {mode !== "loading" && (
          <div
            style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: "6px" }}
          >
            <input
              id="publish-include-comments"
              type="checkbox"
              checked={includeComments}
              onChange={(e) => setIncludeComments(e.target.checked)}
            />
            <label htmlFor="publish-include-comments" style={{ cursor: "pointer" }}>
              Include comments (threaded discussions stay private unless checked)
            </label>
          </div>
        )}

        {mode !== "loading" && (
          <div
            style={{ ...fieldStyle, flexDirection: "row", alignItems: "flex-start", gap: "6px" }}
            title={
              "Writeback answers are always signed and labelled. With this on, totals (GATHER), the " +
              "respondent list, model tables and scripts count only answers whose sender Windows could " +
              "verify; the rest are shown in Collected Responses and counted nowhere. " +
              (mode === "push"
                ? "Unless you change it, the push keeps the rule of the version it is based on."
                : "")
            }
          >
            <input
              id="publish-require-verified"
              data-testid="publish-require-verified"
              type="checkbox"
              checked={requireVerified}
              onChange={(e) => {
                requireVerifiedTouchedRef.current = true;
                setRequireVerified(e.target.checked);
              }}
            />
            <label htmlFor="publish-require-verified" style={{ cursor: "pointer" }}>
              Writeback: count only answers from verified senders (a sender is verified when Windows records
              their account as the writer and nobody else can change the answer: on a network file share
              with domain accounts and per-sender folders, or this computer&apos;s disk; never on Dropbox or
              OneDrive)
            </label>
          </div>
        )}

        {/*
          The error and the status used to be rendered HERE, inside the
          scrolling body of a dialog tall enough to need scrolling. Press Push
          with the sheet list scrolled into view and the answer appears above
          the fold — visually identical to the button doing nothing. They now
          render in the pinned strip just above the footer; see below.
        */}
        </DialogPane>

        {twoPane && split.splitter}

        {/*
          THE REVIEW SIDE. Every box here is computed FROM the form beside it —
          what this push would change, what it would degrade for subscribers,
          what it would ship — so it belongs next to that form rather than
          below the end of it.
        */}
        {hasReview && (
          <DialogSidePane
            flexible
            border={twoPane ? "left" : "none"}
            data-testid="publish-dialog-review"
            style={
              twoPane
                ? { ...split.secondaryStyle, padding: "12px 16px" }
                : // Stacked: the body is the scroller, so this just sits under
                  // the form at its natural height.
                  { flex: "0 0 auto", padding: "0 16px 12px" }
            }
          >
            {/* THE CODE, FIRST -- the Promote dialog's summary, base -> this
                push (owner question 14). A push is where the developer decides
                what code goes out under their key, and a changed macro used to
                sit somewhere inside the cell diff below. In two panes it
                shrinks and scrolls on its own, so it never pushes the diff out. */}
            {mode === "push" && code && (
              <div
                data-testid="push-code-summary"
                style={twoPane ? { flex: "0 1 auto", minHeight: 0, overflowY: "auto" } : undefined}
              >
                <PromotionCodeSummary
                  state={code}
                  environment={PUSH_CODE_AUDIENCE}
                  firstPromotion={false}
                  toVersion={version}
                  act="push"
                />
              </div>
            )}

            {mode === "push" && (
              <div
                style={
                  twoPane
                    ? // Fills the pane and scrolls INSIDE it. 260px was a
                      // letterbox onto the one panel an author reviews a push
                      // in, nested inside another scroller.
                      { ...fieldStyle, flex: "1 1 0", minHeight: 140, marginBottom: 0 }
                    : fieldStyle
                }
              >
                <label>Changes since v{workspace?.baseVersion}</label>
                <div
                  style={{
                    border: "1px solid var(--border-default)",
                    borderRadius: 3,
                    padding: "8px",
                    overflowY: "auto",
                    ...(twoPane ? { flex: "1 1 0", minHeight: 0 } : { maxHeight: "260px" }),
                  }}
                >
                  {diffBusy && (
                    <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
                      Working out what you changed…
                    </span>
                  )}
                  {diffError && !diffBusy && (
                    <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
                      Could not compare against v{workspace?.baseVersion}: {diffError}
                    </span>
                  )}
                  {diff && !diffBusy && (
                    <VersionDiffView
                      diff={diff}
                      // Only a PUSH can hold a change back. A first publish has
                      // no base version to take the held-back value from, so a
                      // checkbox there would be a control with nothing behind
                      // it.
                      //
                      // DISABLED 2026-09-01 by this session's adversarial review
                      // and RE-ENABLED 2026-09-02 on the condition that review
                      // set. The problem was that `undo()` was a BLIND
                      // `pop_undo()` taking no token, while this dialog is
                      // deliberately non-modal — so an edit made during the
                      // seconds a publish spends signing and writing to a share
                      // was what the `finally` reversed. The hold-back then
                      // stayed applied, permanently and silently: the author's
                      // value gone from their own workbook, the dialog
                      // reporting success, a save persisting the base value. Nor
                      // does AutoRecover save them — it snapshots LIVE state,
                      // which at that moment holds the base values, and the undo
                      // stack is never serialized.
                      //
                      // `calp_hold_back_cells` now returns the id of the entry
                      // it left, and the un-revert pops ONLY if the top of the
                      // history is still that entry — refusing with a sentence
                      // that says how many Ctrl+Z it now takes, rather than
                      // reversing somebody else's work. The author's own edit is
                      // no longer the quiet failure; it is a message.
                      selection={
                        mode === "push" && workspace?.baseVersion
                          ? {
                              // EVERY untick shows unticked, the parked ones too:
                              // a "removed" sheet's row is on screen although the
                              // push does not carry its sheet.
                              excluded: untickedCells,
                              label: "Push",
                              onToggle: (sheetId, c, include) =>
                                dispatchHoldBack({ type: "toggle", key: cellKeyOf(sheetId, c), include }),
                            }
                          : undefined
                      }
                    />
                  )}
                </div>
                {/* PINNED BELOW THE SCROLL, not inside it: this was the one
                    control that undoes an exclusion, and it scrolled away with
                    the rows it is about.

                    AND ON SCREEN WHENEVER ANYTHING IS HELD BACK -- also while
                    the comparison is worked out again and after it failed, when
                    the rows themselves are not listed (review round 9, F1).
                    That, rather than a blocked Push, is the honest answer to
                    "an exclusion must never act unseen": what acts is only the
                    author's own unticks, so a push then holds back no more than
                    they chose (the base value stays, and it is already
                    published), and this count and its "Push all" say so. A
                    block would strand the author after a failed comparison
                    instead, because nothing but a moved box asks for it again.
                    It counts `excluded` only -- the unticks on sheets the latest
                    comparison says this push CARRIES. A PARKED untick has a line
                    of its own: the push sends it too, and Rust holds it back the
                    moment the push carries its sheet. */}
                {excludedCells.size > 0 && (
                  <div
                    data-testid="push-holdback-strip"
                    style={{
                      fontSize: "11px",
                      marginTop: 6,
                      flexShrink: 0,
                      display: "flex",
                      gap: 8,
                      alignItems: "baseline",
                    }}
                  >
                    <span style={{ color: "var(--conflict-text, #856404)" }}>
                      {formatNumber(excludedCells.size)} change(s) stay local — the published version keeps
                      v{workspace?.baseVersion}&rsquo;s value there.
                    </span>
                    <button
                      style={{ fontSize: "11px" }}
                      onClick={() => dispatchHoldBack({ type: "includeAll" })}
                    >
                      Push all
                    </button>
                  </div>
                )}
                {/* UNTICKS ON A SHEET THIS PUSH DOES NOT CARRY (`parked`,
                    lib/holdBack.ts): they hold nothing back now, and act again
                    the moment the push carries their sheet. TRUE BY
                    CONSTRUCTION: it counts only unticks whose sheet the LATEST
                    comparison says the push does not carry (its
                    `carriedSheetIds`), never a guess from the sheet boxes --
                    the guess said "not in this push" of a floating grid's
                    backing sheet and of a chart's source, both of which shipped
                    (review round 11, RV11-TS-1). And "no longer held back,
                    because their sheet is no longer in this push" stayed on
                    screen after the sheet was ticked again and its changes were
                    pushed (review round 10, R10-1). */}
                {holdBack.parked.size > 0 && (
                  <div
                    data-testid="push-holdback-parked"
                    style={{
                      fontSize: "11px",
                      marginTop: 6,
                      flexShrink: 0,
                      color: "var(--text-secondary)",
                    }}
                  >
                    {describeParkedHoldBacks(holdBack.parked.size)}
                  </div>
                )}
                {/* UNTICKS A NEW COMPARISON TOOK AWAY, in plain words: it was
                    asked for their sheet and no longer lists their row
                    (lib/holdBack.ts). Never silently -- a dropped untick is a
                    change the next push publishes. */}
                {holdBack.dropped > 0 && (
                  <div
                    data-testid="push-holdback-dropped"
                    style={{
                      fontSize: "11px",
                      marginTop: 6,
                      flexShrink: 0,
                      color: "var(--conflict-text, #856404)",
                    }}
                  >
                    {describeDroppedHoldBacks(holdBack.dropped, workspace?.baseVersion ?? "")}
                  </div>
                )}
              </div>
            )}

            {/* The warnings and the report share whatever height the diff does
                not take, and scroll between themselves when there is not
                enough — nothing here may push the diff out of the pane. */}
            <div
              style={
                twoPane
                  ? { flex: "0 1 auto", minHeight: 0, overflowY: "auto" }
                  : { flexShrink: 0 }
              }
            >
        {/* WHAT THIS PUSH LEAVES BEHIND, named, before anything is pushed.
            Once a report is up it names the same list itself (PublishReportView),
            so this box stands in only until then. */}
        {withheld.length > 0 && report === null && (
          <div
            data-testid="push-withheld-notice"
            style={{
              fontSize: "12px",
              margin: "8px 0",
              padding: "6px 8px",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
            }}
          >
            <WithheldContentList items={withheld} />
          </div>
        )}

        {/* WHAT THIS PUSH ADDS from your own content ("Include in
            application", M4), each with its code and the tick to take it back
            out. Once a report is up it names the same list itself. */}
        {added.length > 0 && report === null && (
          <div
            data-testid="push-added-notice"
            style={{
              fontSize: "12px",
              margin: "8px 0",
              padding: "6px 8px",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
            }}
          >
            <AddedToApplicationList items={added} />
          </div>
        )}

        {/* BUTTONS THAT RUN A MACRO THIS PUSH LEAVES OUT (M4): the push is
            refused while any remain, so each is named with the remedy that
            works -- for your own macro, the include tick in place. */}
        <UnshippedMacroLinks links={unshippedLinks} withheld={withheld} />

        {/* THE BUTTONS' CODE, with the code on screen, before anything is
            pushed (BUG-0257). */}
        <ButtonCodeReview
          release={buttonCode}
          acknowledged={ackedButtonCode}
          onAcknowledge={(hash, acked) =>
            setAckedButtonCode((prev) => {
              const next = new Set(prev);
              if (acked) next.add(hash);
              else next.delete(hash);
              return next;
            })
          }
        />

        {warnings.length > 0 && (
          <div
            style={{
              fontSize: "12px",
              margin: "8px 0",
              padding: "6px 8px",
              backgroundColor: "#fff3cd",
              borderRadius: 4,
              color: "#664d03",
            }}
          >
            <strong>Warnings ({warnings.length})</strong> — the application
            publishes as-is.
            {warnings.map((w, i) => (
              <div key={i} style={{ marginLeft: 8, marginTop: 4 }}>
                {w}
              </div>
            ))}
          </div>
        )}

        {report && (
          <div
            style={{
              margin: "8px 0",
              padding: "8px",
              border: "1px solid var(--border-default)",
              borderRadius: "3px",
              fontSize: "12px",
              ...(reportFor !== null && reportFor !== previewSignature()
                ? { opacity: 0.55 }
                : {}),
            }}
          >
            {reportIncludeFor !== null && reportIncludeFor !== includeSignature(includeState) && (
              // Ticking "Include in application" changes what ships; a report
              // computed before the tick overstates or understates it.
              <div style={{ color: "#a05a00", fontWeight: 600, marginBottom: "4px" }}>
                Out of date — what you included in the application changed. Press Preview again.
              </div>
            )}
            {reportFor !== null && reportFor !== previewSignature() && (
              // The report names the sheets it would ship. Once the selection
              // moves it is describing a publish nobody is about to make, and
              // saying so is the only honest option: silently leaving it up
              // overstates what would leave the machine.
              <div style={{ color: "#a05a00", fontWeight: 600, marginBottom: "4px" }}>
                Out of date — the sheet selection changed. Press Preview again.
              </div>
            )}
            <div style={{ fontWeight: 600, marginBottom: "4px" }}>{reportLabel}</div>
            <PublishReportView report={report} />
          </div>
        )}
            </div>
          </DialogSidePane>
        )}
      </DialogBody>
      </IncludeInApplicationContext.Provider>

      {/*
        THE ANSWER STRIP — pinned, outside the scroll, directly above the button
        it is about, so the reply to a click is read in the same glance as the
        gesture. One strip and one priority order rather than three scattered
        messages: what just FAILED beats what just happened, which beats what is
        stopping you from trying.
      */}
      {(error || status || (blocked && !pushed)) && (
        <div
          style={{
            flexShrink: 0,
            padding: "6px 16px",
            fontSize: "12px",
            lineHeight: 1.35,
            whiteSpace: "pre-wrap",
            borderTop: "1px solid var(--border-default)",
            ...(error
              ? { background: "#fdeceb", color: "#c5221f" }
              : status
                ? { background: "#e8f5e9", color: "#137333" }
                : { color: "var(--text-secondary)" }),
          }}
        >
          {error ?? status ?? blocked}
          {/* THE RETRYABLE REFUSAL -- the workbook changed while it was being
              read, so nothing was written -- runs the same act again from here.
              Only beside the error it belongs to (`retry.shown`). */}
          {error !== null && retry !== null && retry.shown === error && (
            <>
              {" "}
              <button
                data-testid="publish-dialog-retry"
                style={STRIP_LINK_STYLE}
                onClick={() => retryAct(retry.act)}
              >
                Try again
              </button>
            </>
          )}
          {/* A push cannot be undone from here, so the next gesture — deciding
              who receives it — needs a door, not a memory. */}
          {pushed && (workspace?.environments?.length ?? 0) > 0 && (
            <>
              {" "}
              <button
                style={STRIP_LINK_STYLE}
                onClick={() => openPanel(APPLICATION_EXPLORER_PANEL_ID)}
              >
                Open Application Explorer
              </button>
            </>
          )}
        </div>
      )}

      {/*
        THE HOTFIX SHAPE. This working copy's base is what an environment is
        RUNNING, and the line has moved past it. The developer's mental model is
        "I am fixing what is live", but the line is linear: this push lands at
        the head and carries every unreleased change in between. Promoting it
        therefore ships all of that, which is the opposite of a hotfix and is
        invisible at the moment of the push unless it is said here.
      */}
      {!pushed && mode === "push" && workspace?.baseIsPromoted && (
        <div
          style={{
            flexShrink: 0,
            padding: "6px 16px",
            fontSize: "12px",
            lineHeight: 1.35,
            background: "#fff3cd",
            color: "#664d03",
            borderTop: "1px solid var(--border-default)",
          }}
        >
          You are patching the version <strong>{workspace.baseIsPromoted}</strong> runs
          (v{workspace.baseVersion}), but this push lands at the head of the development
          line — so promoting it would also ship everything published since. Promote it
          through your pipeline rather than straight to {workspace.baseIsPromoted}.
        </div>
      )}

      <div style={footerStyle}>
        <button onClick={onClose}>{pushed ? "Close" : "Cancel"}</button>
        {/* Disabled while any act runs (`acting`) -- a push, a merge, or a
            Preview already running: a preview beside an act would clear the
            "Pushing…" / "Pushed…" line it is under, and a second Preview has
            nothing to add (runPreview's own guard says why). */}
        <button onClick={() => void runPreview(PREVIEW_LABEL)} disabled={acting !== null}>
          Preview
        </button>
        {/*
          NOT `disabled`. A disabled primary button explains nothing, and the one
          condition a complete-looking dialog still fails is the change summary,
          whose placeholder is a full sentence and reads as a value. Clicking now
          always answers — see `handlePublish`. Disabled only once the push has
          landed, and while a push, a merge or a Preview is running (`acting`),
          when the strip above already says "Pushing…", "Merging…" or
          "Analyzing…" -- a push beside a Preview had its receipt taken down by
          the slower Preview (review round 11, RV11-TS-2).
        */}
        <button
          onClick={handlePublish}
          disabled={pushed || acting !== null}
          title={blocked ?? undefined}
          style={{ fontWeight: 600, opacity: canPush ? 1 : 0.65 }}
        >
          {mode === "push" ? "Push" : "Publish"}
        </button>
      </div>

      {win.resizeHandles}
    </div>
  );
}

/**
 * Where this working copy stands: which application, which base, and whether the
 * workspace has moved on since.
 */
function WorkspaceBanner({
  workspace,
  gates,
  merge,
  mergeBusy,
  mergeFailure,
  onRetryAnalysis,
  onMerge,
  mergeDisabled,
}: {
  workspace: WorkingCopyStatus;
  gates: PushGateStatus | null;
  merge: MergeAnalysisResponse | null;
  mergeBusy: boolean;
  /** Why the merge analysis for the base -> head on screen failed, as a sentence; null = it did not. */
  mergeFailure: string | null;
  /** Ask the analysis again -- the author's gesture; nothing else re-asks a failed one. */
  onRetryAnalysis: () => void;
  onMerge: () => void;
  /** A push, a merge or a Preview is running: Merge waits for it (the dialog's `acting`). */
  mergeDisabled: boolean;
}) {
  const stale = gates?.baseStale ?? workspace.isStale;
  const unreachable = !workspace.registryReachable && !gates?.registryLatest;
  const keyProblem = gates ? !gates.keyContinuityOk : !workspace.holdsPublisherKey;

  const boxStyle = (tone: "info" | "warn" | "error"): React.CSSProperties => ({
    fontSize: "12px",
    padding: "8px 10px",
    marginBottom: "12px",
    borderRadius: "4px",
    lineHeight: 1.45,
    background:
      tone === "error" ? "#fdecea" : tone === "warn" ? "#fff3cd" : "var(--bg-subtle, rgba(127,127,127,0.08))",
    color: tone === "error" ? "#842029" : tone === "warn" ? "#664d03" : "var(--text-primary)",
  });

  if (unreachable) {
    return (
      <div style={boxStyle("warn")}>
        <strong>{workspace.packageName}</strong> — you are based on v
        {workspace.baseVersion}. The registry could not be read
        {workspace.registryError ? `: ${workspace.registryError}` : ""}, so
        whether anyone has published since is unknown. A push will check before
        it writes anything.
      </div>
    );
  }

  if (stale) {
    const head = merge?.headVersion || gates?.registryLatest || workspace.headVersion;
    // WHO, only from the head's VERIFIED manifest (the merge analysis, which
    // also checked the signer is an authorised publisher). The version
    // listing's "published by" is unsigned -- a share-writer can type a
    // colleague's name there -- so when the analysis did not verify the head,
    // nobody is named.
    const signer = merge?.headSigner;
    const landed = (
      <>
        <strong>{workspace.packageName}</strong> is now at v{head}
        {signer ? (
          <span data-testid="stale-head-signer">
            {`, signed by ${signer.name || "an unnamed publisher"} (key ${signer.fingerprint})`}
          </span>
        ) : null}{" "}
        — you are working from v{workspace.baseVersion}.
        {merge?.headChangeSummary ? ` They wrote: “${merge.headChangeSummary}”` : ""}
      </>
    );

    // THE ANALYSIS FAILED: say why, once, and let the author ask again. It used
    // to keep saying "Working out..." while the dialog re-ran the analysis in
    // an unbounded loop (see `mergeFailure` in the dialog).
    if (!mergeBusy && !merge && mergeFailure !== null) {
      return (
        <div style={boxStyle("warn")} data-testid="merge-analysis-failed">
          {landed}
          <div style={{ marginTop: 4 }}>
            Could not work out whether their changes overlap yours: {mergeFailure}{" "}
            <button
              data-testid="merge-analysis-retry"
              style={{ fontSize: "11px" }}
              onClick={onRetryAnalysis}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }

    if (mergeBusy || !merge) {
      return (
        <div style={boxStyle("warn")}>
          {landed}
          <div style={{ marginTop: 4 }}>
            Working out whether their changes overlap yours…
          </div>
        </div>
      );
    }

    // Disjoint work is the common case on an application made of addressable
    // pieces, and calling it a conflict would be false.
    if (merge.analysis.verdict === "canMerge") {
      return (
        <div style={boxStyle("info")}>
          {landed}
          <ChangeLists analysis={merge.analysis} />
          <div style={{ marginTop: 6 }}>
            Your changes and theirs touch different things, so both can land.
            Merging brings their work into this workbook and recalculates —
            after that, push as usual.
          </div>
          <button onClick={onMerge} disabled={mergeDisabled} style={{ marginTop: 6, fontWeight: 600 }}>
            Merge with v{head}
          </button>
        </div>
      );
    }

    if (merge.analysis.verdict === "conflict") {
      return (
        <div style={boxStyle("error")}>
          {landed}
          <div style={{ marginTop: 6 }}>
            The same thing was changed on both sides:
            <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
              {merge.analysis.collisions.map((c, i) => (
                <li key={i}>{c.description}</li>
              ))}
            </ul>
          </div>
          <div style={{ marginTop: 6 }}>
            There is no way to merge two versions of the same cell without
            discarding one of them, so this push is refused. Open v{head} for
            editing and re-apply your work.
          </div>
        </div>
      );
    }

    // NOTHING OF THEIRS TO BRING ACROSS. A `FastForward` verdict with an empty
    // summary and nothing unmergeable means the intervening version changed
    // nothing this analysis can act on — which became reachable for a whole new
    // class of version when the diff stopped reporting derived-only changes: a
    // publisher who edits a sheet outside the published set recomputes formulas
    // and nothing else, so `pieces_touched(theirs)` is empty.
    //
    // Without this branch that fell through to the sentence below and rendered
    // "this version cannot bring across ." — an empty join, a dangling
    // sentence, and an instruction to re-do work for no reason.
    if (
      merge.analysis.verdict === "fastForward" &&
      merge.analysis.unmergeable.length === 0
    ) {
      return (
        <div style={boxStyle("warn")}>
          {landed}
          <div style={{ marginTop: 6 }}>
            Nothing in v{head} conflicts with your work — it changed no content
            this push would touch. Your base is still v{workspace.baseVersion},
            so the push is refused until you move to v{head}: open it for
            editing, and your changes come with you.
          </div>
        </div>
      );
    }

    // cannotApply — disjoint, but out of reach for now. Worth distinguishing:
    // "you collided" and "we cannot do this yet" call for different reactions.
    return (
      <div style={boxStyle("warn")}>
        {landed}
        <ChangeLists analysis={merge.analysis} />
        <div style={{ marginTop: 6 }}>
          Your work and theirs do not overlap, but this version cannot bring
          across {merge.analysis.unmergeable.join("; ")}. Open v{head} for
          editing and re-apply your changes.
        </div>
      </div>
    );
  }

  if (keyProblem) {
    return (
      <div style={boxStyle("error")}>
        <strong>{workspace.packageName}</strong> was published with a different
        signing key than this computer holds. Pushing would break every
        subscriber&rsquo;s trust pin, so it will be refused — ask the publisher to
        push this change.
      </div>
    );
  }

  return (
    <div style={boxStyle("info")}>
      <strong>{workspace.packageName}</strong> is at v
      {gates?.registryLatest || workspace.headVersion || workspace.baseVersion} — you are based on v
      {workspace.baseVersion}. Your push will be the next version.
    </div>
  );
}

/** Side by side: what landed, and what you changed. */
function ChangeLists({ analysis }: { analysis: MergeAnalysisResponse["analysis"] }) {
  if (analysis.theirSummary.length === 0 && analysis.yourSummary.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
      <div style={{ minWidth: 160 }}>
        <div style={{ fontWeight: 600 }}>They changed</div>
        <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
          {analysis.theirSummary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
      <div style={{ minWidth: 160 }}>
        <div style={{ fontWeight: 600 }}>You changed</div>
        <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
          {analysis.yourSummary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The answer strip's text buttons: they read as links in the strip's own colour. */
const STRIP_LINK_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  padding: 0,
  font: "inherit",
  textDecoration: "underline",
};

/**
 * A sheet selection as one comparable string: which selection a button-code
 * answer belongs to. Order-insensitive, and over the ticks' STABLE ids
 * (`sheetKey`), so a renumbering that moves no tick changes nothing here and
 * a tick whose sheet left the list does.
 */
export function sheetsSignature(keys: readonly string[]): string {
  return JSON.stringify([...keys].sort());
}

/**
 * Every row a working-copy diff LISTS, as `cellKeyOf` strings: its sheets'
 * sample rows, the only rows this dialog shows -- it offers no "Show all" --
 * and so the only cells an author can untick (the hold-back's `keepRows`).
 * They include a "removed" sheet's rows; `keepRows` judges only the sheets the
 * answer says the push carries, so those never keep an untick acting.
 */
function rowKeysOf(diff: VersionDiff): Set<string> {
  const keys = new Set<string>();
  for (const sheet of diff.sheets) {
    for (const cell of sheet.sample) keys.add(cellKeyOf(sheet.sheetId, cell));
  }
  return keys;
}

/**
 * A refusal whose SAME request can never succeed, because the sheets it named
 * are not the workbook's any more: a ticked id that is gone
 * (`CALP_PUSH_SHEET_GONE`), or a position past the end of the sheet list
 * (`CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE`, which only the positions-only
 * fallback for a row listed without an id can meet). Never "Try again": the
 * act the author started reads the sheet list again instead
 * (`readSheetListAgain`), so resending the same positions can never loop.
 */
function needsTheSheetListAgain(err: unknown): boolean {
  return isSheetGoneRefusal(err) || isSheetIndexOutOfRangeRefusal(err);
}

/**
 * Turn a backend refusal into the sentence it already contains.
 *
 * The backend prefixes gate refusals with a stable `CALP_PUSH_*` /
 * `CALP_MERGE_*` code so a UI can branch; the human half is the rest of the
 * string. The retryable snapshot refusal (`WORKBOOK_CHANGED_WHILE_SAVING`), the
 * gone-sheet refusal (`CALP_PUSH_SHEET_GONE`) and the past-the-end refusal
 * (`CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE`) are read by the ONE shared recogniser,
 * `@api/backendRefusal` -- never a second pattern here. Showing any code to the
 * user would be showing them our internal vocabulary.
 */
function explainPushError(err: unknown): string {
  if (isWorkbookChangedWhileSaving(err) || needsTheSheetListAgain(err)) return describeBackendRefusal(err);
  const raw = String(err);
  const match = raw.match(/CALP_(?:PUSH|MERGE)_[A-Z_]+:\s*(.*)$/s);
  return match ? match[1].trim() : raw;
}
