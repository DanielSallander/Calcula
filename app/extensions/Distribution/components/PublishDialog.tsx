// FILENAME: app/extensions/Distribution/components/PublishDialog.tsx
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

import React, { useCallback, useEffect, useState } from "react";
import type {
  DialogProps,
  MergeAnalysisResponse,
  PublishReport,
  PushGateStatus,
  PublishPreviewSheet,
  VersionDiff,
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
import { holdBackCells, type HoldBackCellRef } from "@api/distribution";
import { CHECKOUT_DIALOG_ID, APPLICATION_EXPLORER_PANEL_ID } from "../manifest";
import { VersionDiffView, cellKeyOf } from "./VersionDiffView";

/**
 * `cellKeyOf` in reverse. The key carries the diff row's SHEET ID, which for a
 * working copy is directly the application's — so this is a parse, not a lookup
 * that could go stale between the tick and the push.
 */
const parseCellKey = (k: string): HoldBackCellRef => {
  const colAt = k.lastIndexOf(":");
  const rowAt = k.lastIndexOf(":", colAt - 1);
  return {
    sheetId: k.slice(0, rowAt),
    row: Number(k.slice(rowAt + 1, colAt)),
    col: Number(k.slice(colAt + 1)),
  };
};
import { listWorkspaces, type SavedWorkspace } from "@api/distributionWorkspaces";
import { useDialogWindow } from "@api/dialogWindow";
import { pickWorkspaceFile, pickWorkspaceFolder } from "../lib/pickWorkspace";
import { pushBlockingReason } from "../lib/pushReadiness";
import { describePushLanding } from "../lib/environments";
import { PublishReportView } from "./ApplicationExplorerPanel";

/** Which of the two things this dialog is doing right now. */
type Mode = "loading" | "push" | "create";

export function PublishDialog({ onClose, data }: DialogProps) {
  // Opened from a sheet tab? Then highlight where that sheet sits in the push.
  // Narrowed with a typeof guard rather than cast: `data` is
  // `Record<string, unknown>` and comes from a caller this component does not
  // control.
  const focusSheetName = typeof data?.focusSheetName === "string" ? data.focusSheetName : undefined;
  const win = useDialogWindow({ minWidth: 460, minHeight: 400 });

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
   * Cells the author unticked in the diff, as `cellKeyOf` strings.
   *
   * AN EXCLUSION SET. The diff rows are a bounded sample, so a changed cell may
   * have no row — storing what was opted OUT of means every cell the dialog
   * could not show is pushed, which is exactly what a push has always done.
   */
  const [excludedCells, setExcludedCells] = useState<Set<string>>(new Set());

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
    setExcludedCells(new Set());
    setSelectionTouched(false);
    selectionTouchedRef.current = false;
  }, [openCount]);
  /**
   * What the chosen workspace already holds. `null` while unread — which is a
   * different state from "read, and empty", and the two must not look alike:
   * "no applications yet" is a fact, "not asked yet" is not.
   */
  const [existingApps, setExistingApps] = useState<ApplicationInfo[] | null>(null);
  /**
   * Ticked sheets, by TRUE workbook index.
   *
   * Was a Set of NAMES mapped back to an index by POSITION in the name list —
   * which was already fragile and became wrong the moment the default stopped
   * being "every sheet": object-backed sheets and now subscribed ones make list
   * position and workbook index different numbers.
   */
  const [sheetSelection, setSheetSelection] = useState<Set<number>>(new Set());
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

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const [pushed, setPushed] = useState(false);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [merge, setMerge] = useState<MergeAnalysisResponse | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);

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
  const runPreview = useCallback(
    async (label: string) => {
      setError(null);
      setStatus("Analyzing…");
      try {
        const target =
          registryPath.trim() && packageName.trim()
            ? { registryPath, packageName }
            : undefined;
        const result = await publishPreview(selectedIndices(), includeComments, target, kind);
        setReport(result.report);
        setReportLabel(`${label} ${result.sheetNames.join(", ")}`);
        setWarnings(result.warnings);
        setGates(result.gates ?? null);
        if (result.sheets) setAvailableSheets(result.sheets);
        if (result.defaultSheetIndices) {
          setDefaultIndices(result.defaultSheetIndices);
          if (!selectionTouchedRef.current) setSheetSelection(new Set(result.defaultSheetIndices));
        }
        setReportFor(previewSignature());
        setStatus(null);
      } catch (err: unknown) {
        setError(String(err));
        setStatus(null);
      }
    },
    // selectedIndices reads state; the deps below are what actually change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registryPath, packageName, includeComments, sheetSelection],
  );

  // A preview with no sheet filter is how we learn the workbook's sheet names
  // for the checkbox list — there is no separate "list my sheets" call, and
  // inventing one would be a second source of truth for what a publish covers.
  useEffect(() => {
    if (mode === "loading") return;
    void (async () => {
      try {
        const result = await publishPreview(
          [],
          false,
          registryPath.trim() && packageName.trim() ? { registryPath, packageName } : undefined,
          kind,
        );
        if (result.sheets) setAvailableSheets(result.sheets);
        if (result.defaultSheetIndices) {
          setDefaultIndices(result.defaultSheetIndices);
          // Only while the user has not chosen: re-seeding after a checkbox
          // moved would silently undo their choice on every target change.
          if (!selectionTouchedRef.current) setSheetSelection(new Set(result.defaultSheetIndices));
        }
        setGates(result.gates ?? null);
      } catch {
        // A failure here costs the checkbox list, not the dialog.
      }
    })();
    // Re-run when the target changes so the gate panel stays truthful.
  }, [mode, registryPath, packageName]);

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
  // Deps are RAW STATE only: `selectedIndices` and `previewSignature` are
  // declared below this effect, and a dep array is evaluated at the call site
  // during render, so naming either here is a ReferenceError on first render.
  // They are called inside the body instead, exactly as `runPreview` does.
  useEffect(() => {
    if (mode !== "push" || !workspace?.baseVersion) return;
    // Explicit rather than accidental: an empty selection means "the publish
    // default", which for a working copy IS the link's base_sheets — benign,
    // but benign by coincidence. Wait until the list has loaded so the request
    // says what it means.
    if (availableSheets.length === 0) return;
    // NOTHING TICKED, NOTHING TO DESCRIBE. An empty `sheetIndices` means "the
    // default" on the wire, so fetching here would render a diff of the base
    // sheets under a list showing no selection — which is exactly the "glitchy"
    // panel this was reported as. The push is refused in that state anyway
    // (`pushBlockingReason`), so there is no push for the panel to describe.
    if (kind !== "library" && sheetSelection.size === 0) {
      setDiff(null);
      setDiffError(null);
      setExcludedCells(new Set());
      return;
    }
    let cancelled = false;
    setDiffBusy(true);
    setDiffError(null);
    diffWorkingCopy({ sheetIndices: selectedIndices(), includeComments })
      .then((result) => {
        if (!cancelled) setDiff(result.diff);
      })
      .catch((e: unknown) => {
        // A missing base version or an unreachable workspace costs the diff
        // panel, not the dialog — the push gates still run server-side.
        if (!cancelled) setDiffError(String(e));
      })
      .finally(() => {
        if (!cancelled) setDiffBusy(false);
      });
    // THE EXCLUSIONS DO NOT SURVIVE A REFETCH. The diff re-runs when the sheet
    // selection or includeComments changes, and a key kept from the previous
    // answer could name a row that no longer exists — an invisible exclusion
    // acting on a push nobody reviewed. Clearing is the honest reset: every
    // change on screen is ticked, which is where the dialog always starts.
    setExcludedCells(new Set());
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, workspace?.baseVersion, pushed, sheetSelection, availableSheets.length, includeComments, kind]);

  // When the base is stale, WHY it is stale matters more than the fact. Ask
  // whether the intervening work actually overlaps yours before telling the
  // user their push is refused — most of the time on a decomposed application it
  // does not, and "you two collided" would be false.
  const analyzeMerge = useCallback(async () => {
    setMergeBusy(true);
    try {
      setMerge(await pushMergeAnalyze());
    } catch {
      // No analysis is a worse-informed banner, not a broken dialog.
      setMerge(null);
    } finally {
      setMergeBusy(false);
    }
  }, []);

  useEffect(() => {
    const stale = gates?.baseStale ?? workspace?.isStale ?? false;
    if (mode === "push" && stale && !merge && !mergeBusy) {
      void analyzeMerge();
    }
  }, [mode, gates?.baseStale, workspace?.isStale, merge, mergeBusy, analyzeMerge]);

  const handleMerge = async () => {
    setError(null);
    setStatus("Merging…");
    try {
      const result = await pushMergeApply();
      setStatus(
        `Merged with v${result.mergedFromVersion}` +
          (result.cellsApplied > 0
            ? ` — ${result.cellsApplied} cell(s) from ${result.sheetsTouched.join(", ")}`
            : ""),
      );
      setMerge(null);
      // Everything downstream moved: the base, the gate statuses, the diff.
      const fresh = await workingCopyStatus();
      if (fresh) {
        setWorkspace(fresh);
        setVersion(fresh.suggestedNext?.patch ?? fresh.baseVersion);
      }
      await runPreview("Preview — would publish");
    } catch (err: unknown) {
      setError(explainPushError(String(err)));
      setStatus(null);
    }
  };

  /** Selected sheet NAMES resolved to workbook indices; [] = every sheet. */
  /** Everything a preview's answer depends on, as one comparable string. */
  const previewSignature = (): string =>
    JSON.stringify({ i: selectedIndices(), c: includeComments });

  /**
   * The sheets to publish, as TRUE workbook indices.
   *
   * ALWAYS EXPLICIT once the list has loaded — never the empty array. Empty
   * means "resolve the default" to the backend, and the default now WITHHOLDS
   * subscribed sheets; sending it when the user has deliberately ticked one
   * would silently drop the thing they just asked for. The two collapses this
   * used to do (empty set, and all-ticked) both meant "empty", which is exactly
   * how that would have happened.
   */
  const selectedIndices = (): number[] => {
    if (availableSheets.length === 0) return [];
    return Array.from(sheetSelection).sort((a, b) => a - b);
  };

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
    let holdBackSeq: number | null = null;
    if (mode === "push" && excludedCells.size > 0 && workspace?.baseVersion) {
      setStatus("Holding back unticked changes…");
      try {
        const r = await holdBackCells({
          registryPath,
          packageName,
          baseVersion: workspace.baseVersion,
          cells: [...excludedCells].map(parseCellKey),
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
        // Nothing was published. The hold-back either refused before writing —
        // `CALP_HOLDBACK_NOT_DERIVABLE` (a cell downstream of an unticked change
        // reads a data model, writeback submissions or a custom function, none
        // of which this workbook can recompute) or `CALP_HOLDBACK_NO_SHEET` —
        // or it failed partway, in which case the partial write is on the undo
        // stack and the document is dirty.
        setStatus(null);
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
        sheetIndices: selectedIndices(),
        // Stamped backend-side from the signing identity; sent for wire
        // compatibility only. A display name the caller types is a display name
        // that can disagree with the key beside it in the version list.
        publishedBy: "",
        includeComments,
        mode: mode === "push" ? "update" : "createNew",
        expectedBaseVersion: mode === "push" ? workspace?.baseVersion : undefined,
        changeSummary,
      });
      // WHERE THE RELEASE NOW STANDS. "Pushed v1.5.0" answers where the bytes
      // went, not who receives them, and the whole point of environments is
      // that those are different questions. The landing line names each
      // environment and its version — and is EMPTY when the application has
      // none, so a solo workbook is not told about a feature it has not adopted.
      const landing = describePushLanding(result.version, workspace?.environments ?? []);
      setStatus(
        `${mode === "push" ? "Pushed" : "Published"} ${result.packageName} v${result.version} to the ` +
          `development line: ${result.sheetsPublished} sheet(s).` +
          (landing ? ` ${landing}` : ""),
      );
      // Anything reading the pipeline is now stale: the head moved, which is
      // what the first environment promotes FROM.
      emitAppEvent(ENVIRONMENTS_CHANGED_EVENT, { registryPath, packageName });
      setReport(result.report);
      setReportLabel(`Published ${result.packageName} v${result.version}`);
      setWarnings(result.warnings);
      setPushed(true);
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
      setError(explainPushError(String(err)));
      setStatus(null);
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
  const tickedSubscribed = availableSheets.filter(
    (s) => s.subscribedTo && sheetSelection.has(s.index),
  );

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
      sheetsSelected: sheetSelection.size,
      sheetsAvailable: availableSheets.length,
      kind,
      nameAlreadyTaken: nameClash !== null,
    });
  const blocked = blockingReason();
  const canPush = !blocked && !pushed;

  // ---- styles -------------------------------------------------------------
  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "8%",
    transform: "translateX(-50%)",
    width: "540px",
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
  const bodyStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "12px 16px",
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

      <div style={bodyStyle}>
        {mode === "loading" && (
          <div style={{ color: "var(--text-secondary)" }}>Reading workbook…</div>
        )}

        {mode === "push" && workspace && (
          <WorkspaceBanner
            workspace={workspace}
            gates={gates}
            merge={merge}
            mergeBusy={mergeBusy}
            onMerge={handleMerge}
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

        {mode === "push" && (
          <div style={fieldStyle}>
            <label>Changes since v{workspace?.baseVersion}</label>
            <div
              style={{
                border: "1px solid var(--border-default)",
                borderRadius: 3,
                padding: "8px",
                maxHeight: "260px",
                overflowY: "auto",
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
                  // Only a PUSH can hold a change back. A first publish has no
                  // base version to take the held-back value from, so a
                  // checkbox there would be a control with nothing behind it.
                  //
                  // DISABLED 2026-09-01 by this session's adversarial review and
                  // RE-ENABLED 2026-09-02 on the condition that review set. The
                  // problem was that `undo()` was a BLIND `pop_undo()` taking no
                  // token, while this dialog is deliberately non-modal — so an
                  // edit made during the seconds a publish spends signing and
                  // writing to a share was what the `finally` reversed. The
                  // hold-back then stayed applied, permanently and silently: the
                  // author's value gone from their own workbook, the dialog
                  // reporting success, a save persisting the base value. Nor
                  // does AutoRecover save them — it snapshots LIVE state, which
                  // at that moment holds the base values, and the undo stack is
                  // never serialized.
                  //
                  // `calp_hold_back_cells` now returns the id of the entry it
                  // left, and the un-revert pops ONLY if the top of the history
                  // is still that entry — refusing with a sentence that says how
                  // many Ctrl+Z it now takes, rather than reversing somebody
                  // else's work. The author's own edit is no longer the quiet
                  // failure; it is a message.
                  selection={
                    mode === "push" && workspace?.baseVersion
                      ? {
                          excluded: excludedCells,
                          label: "Push",
                          onToggle: (sheetId, c, include) =>
                            setExcludedCells((prev) => {
                              const next = new Set(prev);
                              const key = cellKeyOf(sheetId, c);
                              if (include) next.delete(key);
                              else next.add(key);
                              return next;
                            }),
                        }
                      : undefined
                  }
                />
              )}
              {excludedCells.size > 0 && (
                <div
                  style={{
                    fontSize: "11px",
                    marginTop: 6,
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                  }}
                >
                  <span style={{ color: "var(--conflict-text, #856404)" }}>
                    {excludedCells.size} change(s) stay local — the published version keeps
                    v{workspace?.baseVersion}&rsquo;s value there.
                  </span>
                  <button style={{ fontSize: "11px" }} onClick={() => setExcludedCells(new Set())}>
                    Push all
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

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
            <div
              style={{
                border: "1px solid var(--border-default)",
                borderRadius: "3px",
                maxHeight: "140px",
                overflowY: "auto",
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
                return (
                  <label
                    key={sheet.index}
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
                      checked={sheetSelection.has(sheet.index)}
                      onChange={(e) => {
                        setSelectionTouched(true);
                        selectionTouchedRef.current = true;
                        setSheetSelection((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(sheet.index);
                          else next.delete(sheet.index);
                          return next;
                        });
                      }}
                    />
                    <span>{name}</span>
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

        {/*
          The error and the status used to be rendered HERE, inside the
          scrolling body of a dialog tall enough to need scrolling. Press Push
          with the sheet list scrolled into view and the answer appears above
          the fold — visually identical to the button doing nothing. They now
          render in the pinned strip just above the footer; see below.
        */}

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
            publishes as-is; these only degrade for subscribers.
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
          {/* A push cannot be undone from here, so the next gesture — deciding
              who receives it — needs a door, not a memory. */}
          {pushed && (workspace?.environments?.length ?? 0) > 0 && (
            <>
              {" "}
              <button
                style={{
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  padding: 0,
                  font: "inherit",
                  textDecoration: "underline",
                }}
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
        <button onClick={() => void runPreview("Preview — would publish")}>Preview</button>
        {/*
          NOT `disabled`. A disabled primary button explains nothing, and the one
          condition a complete-looking dialog still fails is the change summary,
          whose placeholder is a full sentence and reads as a value. Clicking now
          always answers — see `handlePublish`.
        */}
        <button
          onClick={handlePublish}
          disabled={pushed}
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
  onMerge,
}: {
  workspace: WorkingCopyStatus;
  gates: PushGateStatus | null;
  merge: MergeAnalysisResponse | null;
  mergeBusy: boolean;
  onMerge: () => void;
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
    const who = merge?.headPublishedBy || gates?.latestPublishedBy || "";
    const landed = (
      <>
        <strong>{workspace.packageName}</strong> is now at v{head}
        {who ? `, published by ${who}` : ""} — you are working from v
        {workspace.baseVersion}.
        {merge?.headChangeSummary ? ` They wrote: “${merge.headChangeSummary}”` : ""}
      </>
    );

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
          <button onClick={onMerge} style={{ marginTop: 6, fontWeight: 600 }}>
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

/**
 * Turn a backend gate refusal into the sentence it already contains.
 *
 * The backend prefixes gate refusals with a stable `CALP_PUSH_*` code so a UI
 * can branch; the human half is the rest of the string. Showing the code to the
 * user would be showing them our internal vocabulary.
 */
function explainPushError(raw: string): string {
  const match = raw.match(/CALP_(?:PUSH|MERGE)_[A-Z_]+:\s*(.*)$/s);
  return match ? match[1].trim() : raw;
}
