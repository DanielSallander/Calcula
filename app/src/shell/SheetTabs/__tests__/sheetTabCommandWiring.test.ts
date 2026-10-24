//! FILENAME: app/src/shell/SheetTabs/__tests__/sheetTabCommandWiring.test.ts
// PURPOSE: The wiring between the core.sheet.* commands and the sheet tab
//          strip, and the one-rename-prompt rule, read from the source.
// CONTEXT: SOURCE-TEXT assertions for the strip itself, as in
//          sheetTabContextIdentity.test.ts and sheetTabAddCanvas.test.ts:
//          rendering SheetTabs means mocking ~25 symbols across three modules.
//          Everything the strip DELEGATES to is tested behaviourally:
//          sheetCommands.test.ts (the commands), sheetTabFlows.test.ts (the
//          backend sequences), sheetDeletePolicy.test.ts (when Delete asks),
//          sheetPlacement.test.ts (the arithmetic). The temporary sheet's
//          observer, discard and keep are ALSO proven behaviourally, on the
//          mounted strip against a FIFO backend model
//          (sheetTabsTemporarySheets.test.tsx) and as pure rules
//          (ephemeralSheets.test.ts); the pins here only keep the wiring those
//          tests rely on from being rewired around them.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const APP = path.resolve(__dirname, "../../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8");

/** Comments quote the behaviour they replaced, so a scanner must not read them. */
const code = (src: string): string =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TABS = code(read("src/shell/SheetTabs/SheetTabs.tsx"));
const EXT = code(read("src/shell/registries/sheetExtensions.ts"));
const GRID_EXT = code(read("src/shell/registries/gridExtensions.ts"));
const GUARD = code(read("extensions/Protection/handlers/sheetTabGuard.ts"));

/** The body of `const <name> = useCallback(` up to its dependency list. */
function callback(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at, `${name} is gone`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  );", at);
  return src.slice(at, end === -1 ? at + 3000 : end);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("the strip seats the controller the commands reach it through", () => {
  it("registers it once and releases it on unmount", () => {
    expect(TABS).toMatch(/registerSheetTabsController\(\{/);
    const at = TABS.indexOf("registerSheetTabsController({");
    // Released by the same effect's cleanup.
    expect(TABS.slice(at, at + 2500)).toMatch(/releaseController\(\)/);
  });

  it("every controller method routes to the strip's own handler (never the raw @api wrapper)", () => {
    const at = TABS.indexOf("registerSheetTabsController({");
    const body = TABS.slice(at, TABS.indexOf("});", at));
    expect(body).toMatch(/insertSheetBefore:/);
    expect(body).toMatch(/deleteSheet: \(index\) => handleDeleteSheetRef\.current\(\{ index \}, \{ confirm: "whenNotBlank" \}\)/);
    // Rename carries the id the command read BEFORE its prompt; Move or Copy carries ids only.
    expect(body).toMatch(/renameSheet: \(index, newName, sheetId\) => handleRenameSheetRef\.current\(\{ index, sheetId \}, newName\)/);
    expect(body).toMatch(/moveOrCopySheet: \(sourceSheetId, beforeSheetId, copy\) =>\s*handleMoveOrCopySheetRef\.current\(sourceSheetId, beforeSheetId, copy\)/);
    // core.sheet.insert { atEnd } is the strip's own "+", with the kind asked for.
    expect(body).toMatch(/appendSheet: \(kind\) => handleAddSheetRef\.current\(kind\)/);
    expect(body).toMatch(/insertSheetBefore: \(beforeIndex, kind\) => handleInsertSheetBeforeRef\.current\(beforeIndex, kind\)/);
    // SABOTAGE: `deleteSheet: (index) => deleteSheet(index)` skips the switch steps.
    expect(body).not.toMatch(/=> deleteSheet\(/);
    expect(body).not.toMatch(/=> addSheet\(/);
  });

  it("the snapshot is read from a ref the render keeps current (the commands are asked synchronously)", () => {
    expect(TABS).toMatch(/controllerStateRef\.current = \{ sheets, activeIndex, locked: structuralLocked \}/);
  });
});

describe("insert before / move or copy apply through the strip's commit-before-switch steps", () => {
  it("insert-before runs the flow and FORCES the switch steps (the active index can be unchanged while the sheet is new)", () => {
    const body = callback(TABS, "handleInsertSheetBefore");
    expect(body).toMatch(/insertSheetBefore\(/);
    expect(body).toMatch(/forceSwitch: true/);
    expect(body).toMatch(/if \(structuralLocked\)/);
    // The kind the command named reaches the backend add (a canvas, not a worksheet).
    expect(body).toMatch(/addSheet: \(\) => addSheet\(undefined, kind\)/);
  });

  it("move or copy runs the flow and forces the switch for a copy", () => {
    const body = callback(TABS, "handleMoveOrCopySheet");
    expect(body).toMatch(/moveOrCopySheet\(/);
    expect(body).toMatch(/forceSwitch: copy/);
  });

  it("applySheetsResult honours forceSwitch", () => {
    expect(TABS).toMatch(/if \(switchSheet && \(forceSwitch \|\| result\.activeIndex !== activeIndex\)\)/);
  });
});

describe("Delete Sheet asks only when the sheet holds something (Excel) -- from the COMMAND", () => {
  it("both doors go through handleDeleteSheet; only the Excel-rule door consults the policy -- about the sheet found again BY ID", () => {
    const body = callback(TABS, "handleDeleteSheet");
    // The sheet is taken by identity before anything is awaited.
    const takeAt = body.indexOf("const target = doorTargetFor(sheets, request);");
    expect(takeAt).toBeGreaterThan(-1);
    const askAlways = body.indexOf('if (options.confirm !== "whenNotBlank") {');
    expect(askAlways).toBeGreaterThan(takeAt);
    expect(body.slice(askAlways, askAlways + 200)).toMatch(/setDeleteConfirm\(target\);\s*return;/);
    // The Excel-rule door asks the policy and deletes INSIDE the door, at the re-found index, by id.
    const door = body.slice(body.indexOf("await runSheetDoor([target], \"deleted\""));
    expect(door).toMatch(/await sheetDeleteNeedsConfirmation\(\s*\{ index: sheet\.index,/);
    expect(door).toMatch(/executeDeleteSheet\(sheet\.index, sheet\.sheetId\)/);
    // SABOTAGE: the index read before the await, as it was.
    expect(body).not.toMatch(/executeDeleteSheet\(index\)|executeDeleteSheet\(request\.index/);
  });

  it("the tab menu's door keeps ALWAYS asking (journeys drive that confirmation; moving it is the owner's call)", () => {
    const listener = TABS.slice(TABS.indexOf("const handleDelete = async"));
    expect(listener.slice(0, 200)).toMatch(/await handleDeleteSheetRef\.current\(requestFrom\(index, sheetId\)\);/);
  });

  it("the confirmation remembers the sheet BY ID and its Delete runs the by-id door, never the index it opened with", () => {
    expect(TABS).toMatch(/useState<DoorTarget \| null>\(null\)/);
    expect(TABS).toMatch(/const target = deleteConfirm;\s*setDeleteConfirm\(null\);\s*void confirmDeleteSheet\(target\);/);
    const confirm = callback(TABS, "confirmDeleteSheet");
    expect(confirm).toMatch(/runSheetDoor\(\[target\], "deleted"/);
    expect(confirm).toMatch(/executeDeleteSheet\(sheet\.index, sheet\.sheetId\)/);
  });

  it("a delete tells Core's per-sheet view cache which index went away, and names its sheet to the backend by id", () => {
    const body = callback(TABS, "executeDeleteSheet");
    expect(body).toMatch(/removalReorderDetail\(index\)/);
    expect(body).toMatch(/deleteSheet\(index, expectedSheetId === undefined \? undefined : \{ expectedSheetId \}\)/);
    // The id-check refusal is the backend's sentence in a toast, not the modal.
    expect(body).toMatch(/reason\.trim\(\) === SHEETS_CHANGED_UNDER_THE_DELETE/);
    expect(body).toMatch(/showToast\(reason, \{ variant: "warning" \}\)/);
  });
});

describe("Duplicate Sheet tells the view cache about the inserted copy", () => {
  it("dispatches the insertion remap after the copy lands", () => {
    const at = TABS.indexOf("const copySheetAt = async");
    expect(at).toBeGreaterThan(-1);
    expect(TABS.slice(at, at + 900)).toMatch(/insertionReorderDetail\(result\.activeIndex\)/);
  });
});

describe("the Unhide dialog's double-click unhides the sheet it was double-clicked on", () => {
  it("passes the clicked sheet's index (the old closure unhid the PREVIOUS selection)", () => {
    expect(TABS).toMatch(/onDoubleClick=\{\(\) => \{?\s*void handleUnhideConfirm\(sheet\.index\)/);
  });
});

describe("ONE rename prompt", () => {
  it("the question is asked in exactly one source file of the shell and the extensions", () => {
    const files = [...sourceFiles(path.join(APP, "src")), ...sourceFiles(path.join(APP, "extensions"))];
    const asking = files.filter((f) => code(fs.readFileSync(f, "utf8")).includes('"Enter new sheet name:"'));
    expect(asking.map((f) => path.relative(APP, f).replace(/\\/g, "/"))).toEqual([
      "src/shell/SheetTabs/renameSheetPrompt.ts",
    ]);
  });

  it("the tab double-click and the tab menu's Rename use it", () => {
    expect(callback(TABS, "handleDoubleClick")).toMatch(/promptForSheetName\(/);
    const item = EXT.slice(EXT.indexOf('id: "core:rename"'));
    expect(item.slice(0, 500)).toMatch(/promptForSheetName\(/);
  });

  it("Protection's Rename override runs the rename COMMAND for the clicked sheet (the seam, not a copy)", () => {
    const item = GUARD.slice(GUARD.indexOf('id: "core:rename"'));
    expect(item.slice(0, 900)).toMatch(/CommandRegistry\.execute\(CoreCommands\.SHEET_RENAME, \{ index: context\.index \}\)/);
  });
});

/** The text from `start` up to and including `end` (first occurrence after it). */
function between(src: string, start: string, end: string): string {
  const at = src.indexOf(start);
  expect(at, `${start} is gone`).toBeGreaterThan(-1);
  const to = src.indexOf(end, at);
  expect(to, `${end} is gone`).toBeGreaterThan(at);
  return src.slice(at, to + end.length);
}

// docs/design/model-drillthrough.md 2.7: a TEMPORARY (drill-through) sheet is
// discarded when the user leaves it and kept on a double-click of its tab.
// The discard has its OWN body -- not executeDeleteSheet, a SWITCH body that
// replayed onto a sheet the user already reached restores that sheet's old
// selection -- and the leave observer runs ONLY on the backend-derived read.
describe("a temporary sheet's discard and keep (model-drillthrough.md 2.7)", () => {
  it("the controller seats discardSheet and keepSheet through refs of the strip's own handlers, passing the STABLE id straight through", () => {
    const at = TABS.indexOf("registerSheetTabsController({");
    const body = TABS.slice(at, TABS.indexOf("});", at));
    expect(body).toMatch(/discardSheet: \(sheetId\) => discardByIdRef\.current\(sheetId\)/);
    expect(body).toMatch(/keepSheet: \(sheetId\) => keepSheetRef\.current\(sheetId\)/);
    // SABOTAGE: turning the id back into an index from the strip's list.
    expect(body).not.toMatch(/sheetAt\(controllerStateRef/);
  });

  it("the discard goes BY ID to the backend primitive, renumbers the view cache at the index the BACKEND reports, adopts the list and repairs the context -- and runs NO switch step", () => {
    const body = callback(TABS, "discardSheetById");
    expect(body).toMatch(/const sent = discardEphemeralSheet\(sheetId\);[\s\S]*discarded = await sent;/);
    // Review TSHELL-3: it waits out the strip's own two-step flows BEFORE it sends, and a
    // sent discard is registered for a later flow to await.
    const hold = body.indexOf("while (leaveObserver.flowsInFlight() > 0) await leaveObserver.whenFlowsIdle();");
    expect(hold).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(body.indexOf("discardEphemeralSheet(sheetId)"));
    // Never SENT under a cell edit (review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT): asked
    // AFTER the hold (an edit can open during it), BEFORE the send; the leave is owed.
    const underEdit = body.indexOf("if (editPausedNow()) {");
    expect(underEdit).toBeGreaterThan(hold);
    expect(underEdit).toBeLessThan(body.indexOf("discardEphemeralSheet(sheetId)"));
    expect(body.slice(underEdit, body.indexOf("discardEphemeralSheet(sheetId)"))).toMatch(
      /leaveObserver\.leaveDeferred\(sheetId\);[\s\S]*return false;/,
    );
    expect(body).toMatch(/discardsSent\.add\(sent\)/);
    expect(body).toMatch(/announceReorder\(removalReorderDetail\(deletedIndex\)\)/);
    expect(body).toMatch(/dispatch\(setSheetContext\(/);
    // SABOTAGE: an index-based delete, or reusing executeDeleteSheet's switch body / the switch's events.
    expect(body).not.toMatch(/deleteSheet\(/);
    expect(body).not.toMatch(/sheet:beforeSwitch|primeSheetSwitch|setActiveSheet\(|sheet:normalSwitch|SHEET_CHANGED|executeDeleteSheet/);
    // The discard body is the ref the observer and the controller reach.
    expect(TABS).toMatch(/discardByIdRef\.current = discardSheetById;/);
  });

  it("a second request for the same id gets the in-flight discard's own promise (C7), released however it ends", () => {
    const body = callback(TABS, "discardSheetById");
    expect(body).toMatch(/const pending = discardInFlight\.get\(sheetId\);\s*if \(pending\) return pending;/);
    expect(body).toMatch(/discardInFlight\.set\(sheetId, run\)/);
    expect(body).toMatch(/if \(discardInFlight\.get\(sheetId\) === run\) discardInFlight\.delete\(sheetId\)/);
    // MODULE-level (a remount or the delete's own re-read finds it), keyed by id, holding the answer.
    expect(TABS).toMatch(/^const discardInFlight = new Map<string, Promise<boolean>>\(\);/m);
  });

  it("a refused discard KEEPS the sheet BY ITS ID and toasts once from the outcome rule -- never a modal", () => {
    const body = callback(TABS, "discardSheetById");
    const catchAt = body.indexOf("catch (err)");
    expect(catchAt).toBeGreaterThan(-1);
    const refusal = body.slice(catchAt);
    expect(refusal).toMatch(/keepEphemeralSheet\(sheetId\)/);
    expect(refusal).toMatch(/refusedDiscardOutcome\(reason, state, keepRefusal\)/);
    // The keep's ANSWERED list decides "kept" (review TSHELL-2), as keepSheet's does.
    expect(refusal).toMatch(/state = temporarySheetStateIn\(kept, sheetId\)/);
    expect(refusal).toMatch(/if \(state === "kept"\) leaveObserver\.kept\(sheetId\);/);
    expect(refusal).toMatch(/showToast\(outcome\.notice\.message/);
    expect(refusal).not.toMatch(/alertAsync/);
    // SABOTAGE: the old unconditional "kept" toast.
    expect(refusal).not.toMatch(/showToast\(`Temporary sheet kept/);
  });

  it("the leave observer has ONE site, inside loadSheets, with the ticket taken BEFORE the read is awaited; the error fallback never reaches it", () => {
    const load = between(TABS, "const loadSheets = useCallback(", "}, [dispatch]);");
    const ticketAt = load.indexOf("const ticket = leaveObserver.readSent();");
    const readAt = load.indexOf("await getSheets()");
    expect(ticketAt).toBeGreaterThan(-1);
    expect(ticketAt).toBeLessThan(readAt);
    expect(load).toMatch(/leaveObserver\.observe\(result, ticket\)/);
    expect(TABS.match(/leaveObserver\.observe\(/g)).toHaveLength(1);
    const catchAt = load.indexOf("catch (err)");
    expect(catchAt).toBeGreaterThan(-1);
    expect(load.slice(catchAt)).not.toMatch(/leaveObserver\.observe/);
  });

  // The pause rule itself (a cell edit OPEN, not "expects a reference") is
  // proven behaviourally: leaveObserverPaused in ephemeralSheets.test.ts, and
  // the point-mode trip on the mounted strip in sheetTabsTemporarySheets.test.tsx.
  it("the observer pauses on the strip's editing ref, the live external session and Core's synchronous edit flags -- NOT on structuralLocked -- and re-reads once when that pause ends", () => {
    expect(TABS).toMatch(
      /paused: \(\) => leaveObserverPaused\(editingRef\.current, getExternalEditSession\(\), syncEditFlags\(\)\)/,
    );
    expect(TABS).toMatch(/editingRef\.current = editing;/);
    expect(TABS).toMatch(/const observerPaused = leaveObserverPaused\(editing, pointKey, syncEditFlags\(\)\);/);
    // An edit that is still OPENING (review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT): the
    // flags are read at the moment of asking, never kept from a render.
    expect(TABS).toMatch(
      /const syncEditFlags = \(\): SyncEditFlags => \(\{\s*coreEditOpen: getGlobalIsEditing\(\),\s*editorOpening: isEditorOpening\(\),\s*\}\);/,
    );
    expect(TABS).toMatch(/if \(wasPaused && !observerPaused && leaveObserver\.pauseEnded\(\)\) loadSheets\(\);/);
    // SABOTAGE: the faulty rule-3 predicate, or the old structural-lock edge.
    expect(TABS).not.toMatch(/isGlobalFormulaMode\(\) \|\| isCrossSheetPointMode\(\) \|\| getCrossSheetPointModeKey\(\) !== null/);
    expect(TABS).not.toMatch(/wasLocked && !structuralLocked/);
  });

  // Review TSHELL3-CONVERSE-OTHER-DOORS. Behaviour: sheetTabsTemporarySheets.test.tsx
  // drives every door against a discard landing inside its window.
  it("ONE door runner holds the observer from before the resolve to after the step, and re-reads once when it settles", () => {
    const door = callback(TABS, "runSheetDoor");
    const started = door.indexOf("leaveObserver.flowStarted();");
    const resolved = door.indexOf("await resolveDoorTargets(targets, done);");
    const step = door.indexOf("await step(resolved.found, resolved.fresh);");
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeLessThan(resolved);
    expect(resolved).toBeLessThan(step);
    expect(door).toMatch(/finally \{\s*if \(leaveObserver\.flowSettled\(\)\) void loadSheets\(\);/);
    expect(TABS.match(/const runSheetDoor = useCallback\(/g)).toHaveLength(1);
  });

  // Review TSHELL4-DOOR-WAIT-SKIPS-STRUCTURAL-LOCK. Behaviour: sheetTabsTemporarySheets.test.tsx
  // opens a formula edit inside a door's wait, both while a discard is in flight and
  // during the door's own fresh read.
  it("the door asks the structural lock AGAIN between the resolve and the step, as it stands NOW, with the lock's own sentence", () => {
    const door = callback(TABS, "runSheetDoor");
    const resolved = door.indexOf("await resolveDoorTargets(targets, done);");
    const recheck = door.indexOf("if (structureLockedNow()) {");
    const step = door.indexOf("await step(resolved.found, resolved.fresh);");
    expect(recheck, "the re-check is gone").toBeGreaterThan(-1);
    expect(resolved).toBeLessThan(recheck);
    expect(recheck).toBeLessThan(step);
    expect(door.slice(recheck, step)).toMatch(/showToast\(STRUCTURE_LOCKED, \{ variant: "info" \}\);\s*return;/);
    // SABOTAGE: the render-closure lock -- the lock as it was when the door STARTED.
    expect(door).not.toMatch(/if \(structuralLocked\)/);
    // NOW: the render's verdict through a ref, OR the synchronous globals a keystroke moved since.
    expect(TABS).toMatch(/structuralLockedRef\.current = structuralLocked;/);
    expect(TABS).toMatch(
      /structuralLockedRef\.current \|\|\s*isGlobalFormulaMode\(\) \|\|\s*isCrossSheetPointMode\(\) \|\|\s*getExternalEditSession\(\) !== null/,
    );
    // The commands' refusals ask the same lock.
    expect(TABS).toMatch(/snapshot: \(\) => \(\{ \.\.\.controllerStateRef\.current, locked: structureLockedNow\(\) \}\)/);
  });

  // Review TSHELL4-DRAG-STATE-ARMED-DURING-DOOR / TSHELL4-DRAG-STALE-APPLYSHEETSRESULT.
  // Behaviour: the drag tests in sheetTabsTemporarySheets.test.tsx.
  it("the drag is DISARMED before its door is awaited, and its move is applied through the CURRENT applySheetsResult", () => {
    const at = TABS.indexOf("const handleMouseUp = async");
    expect(at).toBeGreaterThan(-1);
    const handler = TABS.slice(at, TABS.indexOf("document.addEventListener(\"mousemove\"", at));
    const disarm = handler.indexOf("setDragState(null);");
    const door = handler.indexOf("await runSheetDoor([source, drop], \"moved\"");
    expect(disarm, "the drag is never disarmed").toBeGreaterThan(-1);
    expect(disarm, "the drag stays armed while its door runs").toBeLessThan(door);
    expect(handler.match(/setDragState\(null\);/g)).toHaveLength(1);
    expect(handler).toMatch(/await applySheetsResultRef\.current\(result, \{ backendHandledSwitch: true \}\);/);
    expect(handler).not.toMatch(/await applySheetsResult\(/);
  });

  it("the ONE resolver ALWAYS settles the sent discards, then re-reads, then finds each sheet by identity -- refusing a gone one with a toast", () => {
    const at = TABS.indexOf("async function resolveDoorTargets(");
    expect(at).toBeGreaterThan(-1);
    const body = TABS.slice(at, TABS.indexOf("\n}\n", at));
    const settle = body.indexOf("await settleSentDiscards();");
    const read = body.indexOf("const fresh = await getSheets();");
    expect(settle).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(read);
    // SABOTAGE: the old gate on the settle's boolean (a discard that already landed left nothing to settle).
    expect(body).not.toMatch(/if \(\s*\(?await settleSentDiscards\(\)/);
    expect(body).toMatch(/findSameSheet\(fresh\.sheets, target\)/);
    expect(body).toMatch(/showToast\(goneNotice\(target, done\), \{ variant: "warning" \}\)/);
    expect(body).not.toMatch(/alertAsync/);
    expect(TABS.match(/async function resolveDoorTargets\(/g)).toHaveLength(1);
  });

  it("every index-addressed door runs through the door runner: Insert, Move or Copy, Delete, Rename, Unhide, the drag, and the event doors", () => {
    for (const name of ["handleInsertSheetBefore", "handleMoveOrCopySheet", "handleDeleteSheet", "confirmDeleteSheet", "handleRenameSheet"]) {
      expect(callback(TABS, name), name).toMatch(/await runSheetDoor\(/);
    }
    expect(TABS.slice(TABS.indexOf("const handleUnhideConfirm = useCallback("))).toMatch(/^[\s\S]{0,600}await runSheetDoor\(/);
    const effectAt = TABS.indexOf("const handleMouseUp = async");
    expect(TABS.slice(effectAt, effectAt + 1400)).toMatch(/await runSheetDoor\(\[source, drop\], "moved"/);
    for (const name of ["moveSheetBeside", "moveSheetTo", "copySheetAt", "hideSheetAt", "setTabColorAt"]) {
      const start = TABS.indexOf(`const ${name} = async`);
      expect(start, name).toBeGreaterThan(-1);
      expect(TABS.slice(start, start + 600), name).toMatch(/await runSheetDoorRef\.current\(/);
    }
    // Move or Copy takes ids, and never maps a gone target to "(move to end)".
    const moveOrCopy = callback(TABS, "handleMoveOrCopySheet");
    expect(moveOrCopy).toMatch(/async \(sourceSheetId: string, beforeSheetId: string \| null, copy: boolean\)/);
    expect(moveOrCopy).not.toMatch(/\?\? null/);
  });

  it("the tab menu keeps the right-clicked SHEET and finds it again by id at the click; a gone sheet closes the menu with a toast", () => {
    expect(TABS).toMatch(/sheet: SheetInfo;\s*\} \| null>\(null\)/);
    const click = callback(TABS, "handleContextMenuItemClick");
    expect(click).toMatch(/const sheet = findSameSheet\(sheets, contextMenu\.sheet\);/);
    expect(click).toMatch(/showToast\(goneNotice\(doorTargetOf\(contextMenu\.sheet\), "done"\)/);
    expect(click).not.toMatch(/contextMenu\.sheet\.index|sheetIndex/);
  });

  it("the tab double-click asks resolveTabDoubleClick BEFORE the rename prompt and keeps the tab's sheet BY ITS ID", () => {
    const body = callback(TABS, "handleDoubleClick");
    const decide = body.indexOf('resolveTabDoubleClick(sheet) === "keep"');
    expect(decide).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(body.indexOf("promptForSheetName("));
    expect(body).toMatch(/await keepSheet\(sheet\?\.sheetId\)/);
  });

  it("the keep says 'Sheet kept' only through the state rule, and moves the observer's memory only when kept", () => {
    const body = between(TABS, "const keepSheet = useCallback(", "}, []);");
    expect(body).toMatch(/await keepEphemeralSheet\(sheetId\)/);
    expect(body).toMatch(/state = temporarySheetStateIn\(result, sheetId\)/);
    expect(body).toMatch(/if \(state === "kept"\) leaveObserver\.kept\(sheetId\);/);
    expect(body).toMatch(/const notice = keepNotice\(state, refusal\);/);
    expect(body).not.toMatch(/showToast\("Sheet kept"/);
  });

  it("the tab is marked and explained", () => {
    expect(TABS).toMatch(/\$isEphemeral=\{sheet\.ephemeral === true\}/);
    expect(TABS).toMatch(/sheet\.ephemeral === true \? \[EPHEMERAL_TAB_TOOLTIP\] : \[\]/);
  });

  it("Keep Sheet is the FIRST core item, shows only on a temporary sheet, and keeps through the controller BY THE SHEET'S ID", () => {
    const keep = EXT.indexOf('id: "core:keepSheet"');
    const rename = EXT.indexOf('id: "core:rename"');
    expect(keep).toBeGreaterThan(-1);
    expect(keep).toBeLessThan(rename);
    const item = EXT.slice(keep, keep + 400);
    expect(item).toMatch(/visible: \(context\) => context\.sheet\.ephemeral === true/);
    expect(item).toMatch(/getSheetTabsController\(\)\?\.keepSheet\(context\.sheetId\)/);
    expect(item).not.toMatch(/keepSheet\(context\.index\)/);
  });
});

describe("bootstrap registers the commands with the core menus", () => {
  it("the sheet commands ride registerCoreSheetContextMenu", () => {
    const fn = EXT.slice(EXT.indexOf("export function registerCoreSheetContextMenu"));
    expect(fn.slice(0, 600)).toMatch(/registerSheetCommands\(\)/);
  });

  it("the Cell Size / Visibility commands ride registerCoreGridContextMenu", () => {
    const fn = GRID_EXT.slice(GRID_EXT.indexOf("export function registerCoreGridContextMenu"));
    expect(fn.slice(0, 900)).toMatch(/registerGridFormatCommands\(\)/);
  });
});
