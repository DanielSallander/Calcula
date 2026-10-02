//! FILENAME: app/extensions/ScriptableObjects/components/ScriptConsentDialog.tsx
// PURPOSE: Security consent prompt for distributed object scripts.
// CONTEXT: When a workbook contains scripts from a .calp package, the user
//          is asked to review and approve them before they can run. One screen
//          per application covers its object scripts, its macros and -- since
//          M6 (phase 4 of BUG-0257) -- its BUTTON ACTIONS: the inline code its
//          buttons carry, shown verbatim with every place it sits, approved by
//          the hash of its exact bytes. Since plan_M8 S3 it also covers the
//          Calcula COMMANDS the application's button cells run -- recorded
//          under their own key, `button-commands:<application>`, never in the
//          application's bare record -- and names any command no click can run.

import React, { useState, useCallback, useEffect, useMemo } from "react";
import { emitAppEvent } from "@api/events";
import { requireScriptEditorProvider } from "@api/scriptEditorService";
import { DialogBody, DialogPane, DialogPaneTitle, dialogWidth } from "@api/dialogLayout";
import type { CapabilityId } from "@api";
import { lineDiff, changedLineCount, type DiffRowType } from "../lib/lineDiff";
import { describeConsentMacroButton, type ConsentMacroButton } from "../lib/consentMacroButtons";
import { describeButtonActionLocation, type ConsentButtonAction } from "../lib/consentButtonActions";

/** One Calcula command the application's button cells run (plan_M8 S3). */
interface ConsentCommand {
  commandId: string;
  commandName: string;
  buttons: ConsentMacroButton[];
}

/** ...and one no click can run, with why. */
interface ConsentCommandWontRun extends ConsentCommand {
  why: string;
}

/** One entry in the consent prompt's requested-capabilities list. */
interface RequestedCapability {
  capability: CapabilityId;
  description: string;
  origins: string[];
}

/** A script whose source changed since the last consent (T3 re-consent diff). */
interface ChangedScriptData {
  id: string;
  name: string;
  oldSource: string;
  newSource: string;
}

const diffRowBg: Record<DiffRowType, string> = {
  same: "transparent",
  add: "#e6ffed",
  del: "#ffeef0",
};

/** Collapsible old->new line diff for one changed script. */
function ScriptChangeDiff({ name, oldSource, newSource }: ChangedScriptData): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => lineDiff(oldSource, newSource), [oldSource, newSource]);
  const changed = changedLineCount(rows);
  return (
    <div style={{ marginBottom: 6, border: "1px solid #f0c36d", borderRadius: 4 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          textAlign: "left",
          background: "#fffdf5",
          border: "none",
          padding: "4px 6px",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 600,
          color: "#7a4a00",
        }}
      >
        {open ? "[hide]" : "[show]"} {name} &mdash; {changed} line{changed === 1 ? "" : "s"} changed
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            maxHeight: 200,
            overflow: "auto",
            fontFamily: "Consolas, monospace",
            fontSize: 10.5,
            lineHeight: 1.4,
            background: "#fff",
          }}
        >
          {rows.map((r, i) => (
            <div key={i} style={{ background: diffRowBg[r.type], padding: "0 4px", whiteSpace: "pre" }}>
              <span style={{ opacity: 0.5, userSelect: "none" }}>
                {r.type === "add" ? "+" : r.type === "del" ? "-" : " "}
              </span>{" "}
              {r.text || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 20000,
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
};

/**
 * The frame. WIDTH IS NOT HERE: it is a function of how much this particular
 * application makes the user read (see `twoColumn` below), so the component
 * supplies it. Everything else about the box is constant.
 */
const dialogStyle: React.CSSProperties = {
  backgroundColor: "#FFF",
  borderRadius: 8,
  boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "16px 20px",
  borderBottom: "1px solid #E0E0E0",
  display: "flex",
  alignItems: "center",
  gap: 10,
  // The header and the footer are the two things that must never scroll away:
  // the footer holds Block/Allow, and the header is what the prompt is about.
  flexShrink: 0,
};

const shieldIcon: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 12,
  backgroundColor: "#FFF4CE",
  color: "#8A6914",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
  fontWeight: 700,
  flexShrink: 0,
};

/**
 * The prose settings of the body — typography only. The BOX behaviour (flex,
 * min-height, the scrollbar) now belongs to `DialogPane`, which is what lets
 * two columns scroll independently while the footer stays put.
 *
 * `display: "block"` overrides the pane's own flex column on purpose: this pane
 * holds paragraphs, and block flow is what collapses adjacent <p> margins. As
 * flex items each paragraph would keep both margins and the disclosure would
 * get TALLER, which is the opposite of the point.
 */
const bodyTextStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  lineHeight: "1.6",
  color: "#333",
};

/** Padding of a body pane — the same inset the single-column body always had. */
const BODY_PADDING = "16px 20px";

/** The hairline between the two columns, in this dialog's own palette. */
const paneDividerStyle: React.CSSProperties = {
  borderLeft: "1px solid #E8E8E8",
};

/**
 * A pane in the STACKED (single-column) arrangement. It is not a column there,
 * just a group in one flow, so it takes its natural height and the body around
 * it does the scrolling — otherwise two column-flex siblings would split the
 * height between them and each scroll on its own.
 */
const stackedPaneStyle: React.CSSProperties = {
  ...bodyTextStyle,
  flex: "0 0 auto",
};

/**
 * The column captions. `DialogPaneTitle` paints from the CSS custom properties;
 * this dialog hard-codes a light palette, so the colour is overridden to match
 * the rest of the prompt rather than the app theme.
 */
const paneTitleStyle: React.CSSProperties = {
  color: "#666",
  marginBottom: 8,
};

/**
 * The re-consent diffs, FULL WIDTH beneath the columns. A changed script's
 * old->new lines are code: a column would give them less room than the
 * single-column body did, not more. Its own scroller so an expanded diff
 * cannot push Block/Allow off the screen.
 */
const diffStripStyle: React.CSSProperties = {
  // `0 1 auto` + `minHeight: 0`, not `flexShrink: 0` and a percentage cap: a
  // percentage max-height against an auto-height box resolves to none, and an
  // unshrinkable strip of expanded diffs would push the footer out of the
  // clipped dialog — the very failure this rollout exists to end.
  flex: "0 1 auto",
  minHeight: 0,
  maxHeight: 260,
  overflowY: "auto",
  padding: "10px 20px 12px",
  borderTop: "1px solid #E0E0E0",
  fontSize: 12,
  lineHeight: "1.6",
  color: "#333",
};

const scriptListStyle: React.CSSProperties = {
  margin: "10px 0",
  padding: "8px 12px",
  backgroundColor: "#F8F8F8",
  borderRadius: 4,
  border: "1px solid #E8E8E8",
};

const scriptItemStyle: React.CSSProperties = {
  padding: "3px 0",
  fontSize: 11,
  color: "#555",
  fontFamily: "'Cascadia Code', Consolas, monospace",
};

/** The "what can start a macro" list. Plain bullets — this is prose, not data. */
const triggerListStyle: React.CSSProperties = {
  margin: "6px 0 10px",
  paddingLeft: 18,
};

/** "Buttons that run this macro", under one macro in the list. */
const macroButtonsStyle: React.CSSProperties = {
  margin: "0 0 4px 12px",
  fontSize: 11,
  color: "#555",
};

const macroButtonListStyle: React.CSSProperties = {
  margin: "2px 0 0",
  paddingLeft: 16,
  fontFamily: "'Cascadia Code', Consolas, monospace",
};

/** One button action: its code, verbatim, then where it sits. */
const buttonActionStyle: React.CSSProperties = {
  padding: "6px 0",
  borderTop: "1px solid #E8E8E8",
};

const buttonActionCodeStyle: React.CSSProperties = {
  margin: "0 0 4px",
  padding: "4px 6px",
  maxHeight: 160,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 11,
  background: "#FFF",
  border: "1px solid #E2E2E2",
  borderRadius: 3,
};

const buttonActionNoteStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#555",
};

/**
 * What a button action's code may touch, as the first sentence of the reach
 * paragraph: a button action runs where a macro runs -- the Rust button door
 * hands its bytes to the same isolated interpreter `run_script` uses.
 */
function interpreterReachSubject(macros: boolean, buttons: boolean, objectScriptMacrosToo: boolean): string {
  // When some of the macros ARE written as object scripts, "a macro is not an
  // object script" would be false of them: name the runtime this paragraph is
  // about, and let the object-script paragraph speak for the rest.
  const macro = objectScriptMacrosToo ? "A macro written for the workbook script runtime" : "A macro";
  if (macros && buttons) {
    return `${macro} is not an object script, and neither is a button action: neither runs in that realm. Each runs`;
  }
  if (macros) return `${macro} is not an object script and does not run in that realm. It runs`;
  return "A button action is not an object script and does not run in that realm. It runs";
}

/**
 * What an application's macro WRITTEN AS AN OBJECT SCRIPT (the Macro
 * Recorder's default) may do once approved -- owner decision B: when YOU run
 * it, from one of the doors that carry a person's pass, it may also read and
 * change the cells of any sheet, and nothing more; a run that stops part-way
 * is undone whole (follow-up F9); started by another script it keeps only what
 * every restricted script has. Every clause is a statement about the code
 * (scriptHost/explicitRunGrant.ts, host.ts), and the doors named are the ones
 * that mint a pass -- macroSurfaceReachHonesty.test.tsx reads them from the
 * mint census, so wiring or unwiring a door turns it red until this follows.
 * Exported for that test.
 */
export function describeObjectScriptMacroReach(objectScriptMacros: number, macros: number): string {
  const subject =
    objectScriptMacros === macros
      ? macros === 1
        ? "This macro is written as an object script"
        : "These macros are written as object scripts"
      : objectScriptMacros === 1
        ? "One of these macros is written as an object script"
        : `${objectScriptMacros} of these macros are written as object scripts`;
  const runs = objectScriptMacros === 1 ? "it runs" : "each runs";
  const one = objectScriptMacros === 1 ? "it" : "one";
  return (
    `${subject}: ${runs} once, in a restricted space of its own, not in Calcula's interpreter. ` +
    `When you run ${one} yourself -- from Developer ▸ Macros ▸ Run, by clicking a button that ` +
    "runs it, or from the command line -- it may also read and change the cells of any sheet " +
    "in this workbook (filling a range also copies the formatting of the cells it fills from, " +
    "as a module macro's fill does), and nothing more: no other formatting, no sheet " +
    "structure, no files, no other macros. If it stops part-way, every change it made is " +
    "undone. Started by another script, it has only what every restricted script has: the " +
    "sheet on screen."
  );
}

const capListStyle: React.CSSProperties = {
  margin: "10px 0",
  padding: "4px 0",
  listStyle: "none",
};

const capItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "6px 0",
  borderTop: "1px solid #F0F0F0",
};

const capIconStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 4,
  backgroundColor: "#FDECEA",
  color: "#C0392B",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 700,
  flexShrink: 0,
  marginTop: 1,
};

const capOriginStyle: React.CSSProperties = {
  display: "block",
  marginTop: 2,
  fontSize: 11,
  color: "#666",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  wordBreak: "break-all",
};

/** Per-capability glyph (ASCII) for the requested-capabilities list. */
const CAP_ICON: Record<CapabilityId, string> = {
  "net.fetch": "@",
  "bi.query": "?",
  "bi.sql": "DB",
  storage: "#",
  "ui.html": "<>",
  "ui.htmlInput": "[<>]",
  "formula.udf": "fx",
  "bi.model": "M",
  "bi.connector": "->M",
  "ui.dialog": "[?]",
  "ui.pane": "[=]",
  "distribution.writeback": "->P",
  schedule: "->S",
  "file.picker": "[/]",
  "ui.shortcut": "[^+]",
  "grid.read": "[#]",
  "distribution.publish": "P->",
  "distribution.subscribe": "<-P",
};

const footerStyle: React.CSSProperties = {
  padding: "12px 20px",
  borderTop: "1px solid #E0E0E0",
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  flexShrink: 0,
};

const btnStyle: React.CSSProperties = {
  padding: "6px 16px",
  fontSize: 12,
  border: "1px solid #CCC",
  borderRadius: 4,
  backgroundColor: "#FFF",
  cursor: "pointer",
};

const btnPrimaryStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: "#0078D4",
  color: "#FFF",
  borderColor: "#0078D4",
};

const btnDangerStyle: React.CSSProperties = {
  ...btnStyle,
  color: "#D13438",
  borderColor: "#D13438",
};

// ============================================================================
// Component
// ============================================================================

import type { DialogProps } from "@api/uiTypes";

export default function ScriptConsentDialog({
  onClose,
  data,
}: DialogProps): React.ReactElement {
  const packageName = (data?.packageName as string) ?? "Unknown";
  // THE IDENTITY OF THIS SCREEN, echoed back with Allow. The grant handler
  // records the artifact set THIS prompt enumerated and refuses a grant whose
  // prompt is no longer standing — so a workbook that changed while the user was
  // reading (a subscription refresh, a gateway pull) re-asks instead of
  // recording an approval for code that was never displayed.
  const promptId = data?.promptId as string | undefined;
  const scriptCount = (data?.scriptCount as number) ?? 0;
  const scriptNames = (data?.scriptNames as string[]) ?? [];
  const scriptIds = (data?.scriptIds as string[]) ?? [];
  // The application's MACROS (module scripts). Allowing writes them into the
  // same consent record as the object scripts — the record the Rust module gate
  // reads before it will run one — so this prompt names them. Anything the
  // grant covers has to be on the screen that produces the grant.
  const moduleScriptNames = (data?.moduleScriptNames as string[]) ?? [];
  // The macro IDS, so Inspect has something to open when the application shipped
  // no object scripts at all. An application MAY ship only macros
  // (`core/calp/src/pull.rs` materializes modules independently of object
  // scripts), and this is the screen that approves them.
  const moduleScriptIds = (data?.moduleScriptIds as string[]) ?? [];
  // Which of those macros are WRITTEN AS OBJECT SCRIPTS (the Macro Recorder's
  // default, `runtime=objectScript`): they do not run in the interpreter the
  // macro paragraph describes, and since owner decision B a run YOU start may
  // change the cells of any sheet -- so they get a paragraph of their own.
  const objectScriptMacroIdSet = new Set((data?.objectScriptMacroIds as string[] | undefined) ?? []);
  const objectScriptMacroCount = moduleScriptIds.filter((id) => objectScriptMacroIdSet.has(id)).length;
  const runtimeMacroCount = moduleScriptNames.length - objectScriptMacroCount;
  // WHICH BUTTONS ALLOWING ARMS (phase 3 of BUG-0257): macro id -> the buttons
  // THIS application put in the workbook to run it (Sheet!A1 + caption). Built
  // by the one emitter (lib/consentMacroButtons.ts), filtered to the
  // application, so another application's buttons and the user's own are never
  // shown as armed by this grant.
  const macroButtons = (data?.macroButtons as Record<string, ConsentMacroButton[]> | undefined) ?? {};
  // Macros this grant CANNOT cover: their id is already claimed by one of the
  // application's object scripts, and one consent record is a flat id-keyed
  // list. Allow will not approve them and Rust will keep refusing them at Run,
  // so the screen names them. While this was silent, the freshness check still
  // demanded their hash — the record could never satisfy it, the application
  // re-prompted on every open, and pressing Allow could not end the loop.
  const unapprovableMacroNames = (data?.unapprovableMacroNames as string[]) ?? [];
  // Object scripts and macros whose id sits in the `buttonAction:` namespace,
  // which belongs to button actions alone. Allow cannot approve them.
  const reservedIdNames = (data?.reservedIdNames as string[] | undefined) ?? [];
  // THE APPLICATION'S BUTTON ACTIONS (M6, phase 4 of BUG-0257): every piece of
  // inline code its buttons carry, by the hash of its exact bytes, with every
  // place it sits. Allowing records each one, and the Rust button door runs a
  // held button's code only when its exact bytes are in that record.
  const buttonActions = (data?.buttonActions as ConsentButtonAction[] | undefined) ?? [];
  // THE CALCULA COMMANDS ITS BUTTON CELLS RUN (plan_M8 S3): each command with
  // the buttons that run it. Allowing records them under the application's
  // command key, and a click then runs the command -- Calcula's own code, at a
  // moment the application's button decides. The ones no click can run are
  // named, never recorded.
  const commandButtons = (data?.commandButtons as ConsentCommand[] | undefined) ?? [];
  const commandsWontRun = (data?.commandsWontRun as ConsentCommandWontRun[] | undefined) ?? [];
  const commandButtonCount = commandButtons.reduce((n, c) => n + c.buttons.length, 0);
  // The workbook carries an approval for this application that does not count
  // here: it was made on another computer, or before approvals were tied to one.
  const approvalMadeElsewhere = data?.approvalMadeElsewhere === true;
  const requestedCapabilities =
    (data?.requestedCapabilities as RequestedCapability[]) ?? [];
  const changedScripts = (data?.changedScripts as ChangedScriptData[]) ?? [];
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  // The dialog instance is reused when the consent queue advances to the
  // next package — reset per-package UI state.
  useEffect(() => {
    setInspecting(false);
    setInspectError(null);
  }, [packageName]);

  const handleAllow = useCallback(() => {
    emitAppEvent("scriptable-objects:consent-granted", { packageName, promptId });
    onClose();
  }, [packageName, promptId, onClose]);

  const handleBlock = useCallback(() => {
    emitAppEvent("scriptable-objects:consent-denied", { packageName });
    onClose();
  }, [packageName, onClose]);

  // What Inspect can actually open. An object script goes through the ordinary
  // EDIT_SCRIPT route (targeting by scriptId opens the existing script — never
  // scaffolds); with no object scripts it opens the first MACRO through the
  // `@api/scriptEditorService` seam, which is the only route to a module script's
  // source. With neither there is nothing to show, and the button is not
  // rendered at all rather than left inert.
  const canInspect = scriptIds.length > 0 || moduleScriptIds.length > 0;

  const handleInspect = useCallback(() => {
    setInspectError(null);
    if (scriptIds.length > 0) {
      emitAppEvent("scriptable-objects:edit-script", { scriptId: scriptIds[0] });
      setInspecting(true);
      return;
    }
    if (moduleScriptIds.length === 0) return;
    setInspecting(true);
    // The seam THROWS when the editor cannot be reached (and rejects for a macro
    // that is gone). Surface it on the prompt: a consent screen that promises
    // "you can inspect the source" must not swallow the failure to do so.
    void (async () => {
      try {
        await requireScriptEditorProvider().openMacroInEditor(moduleScriptIds[0]);
      } catch (e) {
        setInspecting(false);
        setInspectError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [scriptIds, moduleScriptIds]);

  // WHEN A SECOND COLUMN EARNS ITS KEEP. The light payload — one object script,
  // no macros, no capabilities — is a few hundred pixels of prose, and the
  // 460px column reads it well. It is the heavy payload that buries a third of
  // the disclosure below the fold while "Allow Scripts" is already visible in
  // the fixed footer, so both the width and the split are a function of what
  // this application actually ships rather than a constant. A re-consent counts
  // as heavy by itself: that is the prompt with the most at stake on it. So is a
  // single button action: it is CODE, shown in full, and the screen exists to
  // put it in front of the user.
  const twoColumn =
    moduleScriptNames.length > 0 ||
    buttonActions.length > 0 ||
    commandButtons.length > 0 ||
    changedScripts.length > 0 ||
    requestedCapabilities.length >= 2 ||
    scriptNames.length >= 3;

  return (
    <div style={overlayStyle} onClick={handleBlock}>
      <div
        style={{ ...dialogStyle, width: twoColumn ? dialogWidth(860) : 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={shieldIcon}>!</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>
              Script Security
            </div>
            <div style={{ fontSize: 11, color: "#666" }}>
              This workbook contains scripts from an external package
            </div>
          </div>
        </div>

        {/* THE BODY IS THE ONLY SCROLLER — the box clips, so the header and the
            Block/Allow footer cannot slide out of view. Two columns once this
            application makes the user read enough to bury the second half of
            the disclosure; otherwise the two groups stack in the order they
            have always had, inside one scroller, exactly as before. */}
        <DialogBody
          stacked={!twoColumn}
          style={twoColumn ? undefined : { overflowY: "auto" }}
        >
          {/* WHAT IS IN THIS APPLICATION — the inventory. Nothing here is split
              from the colon that introduces it: the macro intro, its trigger
              bullets, "They will not run at all..." and the macro list are ONE
              unit, because both of those sentences end on a colon whose list is
              the node after it. */}
          <DialogPane
            scroll={twoColumn}
            padding={twoColumn ? BODY_PADDING : "16px 20px 0"}
            style={twoColumn ? bodyTextStyle : stackedPaneStyle}
          >
            {twoColumn && (
              <DialogPaneTitle style={paneTitleStyle}>
                What is in this application
              </DialogPaneTitle>
            )}
            {/* An application may ship object scripts, macros, or ONLY macros —
                the pull materializes the two independently. Each list is rendered
                only when it has entries, so a macro-only application is not
                introduced as including "0 object scripts". */}
            {scriptCount > 0 && (
              <>
                <p>
                  The package <strong>"{packageName}"</strong> includes {scriptCount} object
                  script{scriptCount !== 1 ? "s" : ""} that can run code in your workbook:
                </p>

                <div style={scriptListStyle}>
                  {scriptNames.map((name, i) => (
                    <div key={i} style={scriptItemStyle}>{name}</div>
                  ))}
                </div>
              </>
            )}

            {moduleScriptNames.length > 0 && (
              <>
                <p>
                  {scriptCount > 0 ? (
                    <>It also includes </>
                  ) : (
                    <>The package <strong>"{packageName}"</strong> includes </>
                  )}
                  {moduleScriptNames.length} macro
                  {moduleScriptNames.length !== 1 ? "s" : ""} (module scripts).
                  Nothing puts a macro on a timer and nothing starts one when you
                  open this workbook &mdash; but allowing arms every way one can be
                  started here:
                </p>
                {/* CONSENT TEXT &mdash; VERIFIED AGAINST THE RUN PATHS, NOT WRITTEN
                    FROM MEMORY. This used to read "Nothing runs them on its own —
                    you run them yourself, from the macro library". The macro
                    library stopped being the only surface the moment macros were
                    folded into this one grant, and the surface that was missing
                    belongs to the PUBLISHER.

                    A BUTTON CELL. A `calcula.button` cell carries `action: { kind:
                    "script", scriptId }` in its cell-type params, those params
                    publish as a `cellType` custom object, and on pull the action is
                    KEPT, stamped `fromApplication`, when it names a macro this
                    application brought into the workbook (admit_button_cells,
                    app/src-tauri/src/button_cells.rs -- BUG-0260: an action naming
                    anything else, or a command not on Calcula's list of commands
                    such buttons may run, is removed on the way in; a command on
                    that list is the command section below). One click
                    resolves the module by id and runs its stored source verbatim,
                    and only a module of THAT application: the rule is Rust's
                    (`plan_cell_action`, app/src-tauri/src/scripting/
                    control_action.rs, behind the button door `run_control_action`),
                    and the module's own approval -- this grant -- is asked of
                    exactly those bytes. So a .calp ships the button AND the macro,
                    and this grant is what arms it.

                    A BUTTON CONTROL'S LINK (phase 3 of BUG-0257). A macroRef naming
                    a macro THIS pull landed for the application is kept HELD and
                    stamped (DistributedWiring::LinkLanded,
                    app/src-tauri/src/held_button_code.rs), and one click runs it
                    through Controls' one click rule
                    (extensions/Controls/lib/applicationMacroLink.ts), which asks the
                    macro-run seam for exactly that application's macro
                    (requirePackage) -- and this grant is what lets it run. Each
                    macro below lists the buttons of this application that run it,
                    so the screen names what Allow arms rather than only saying "a
                    button". A link to anything else is removed on the way in and
                    named in the subscribe or refresh notice.

                    A BUTTON CONTROL'S INLINE CODE (phase 4, M6). It no longer
                    arrives removed: a subscribe or refresh moves a STATIC onSelect
                    into the held compartment, stamped (the same LinkLanded arm), and
                    the Rust button door runs it only after THIS grant approves its
                    exact bytes (`buttonAction:<sha256>` in the application's bare
                    record, application_code_gate::button_run_gate). It runs as its
                    own code, never composed with the user's modules, and a held
                    `Name()` reaches only the application's own modules
                    (control_action::plan_held_inline) -- so code that calls one of
                    these macros by name is one more way a click starts it, and the
                    button-action list says which. A formula-typed onSelect is
                    removed on the way in and named.

                    The two negatives are load-bearing and both hold: cap.schedule*
                    runs one of the SCRIPT'S OWN methods, never a stored macro
                    (allowlist.ts), and no path mounts or runs a module script at
                    open — only object scripts mount, and api.runMacro is
                    unlocked-tier, which a distributed script can never reach
                    (accessLevelForOrigin, scriptOrigin.ts). Pinned by
                    macroConsentTriggerHonesty.test.ts. */}
                <ul style={triggerListStyle}>
                  <li>
                    Developer &#9656; Macros, where you pick one and press Run.
                  </li>
                  <li>
                    A button the publisher put on a sheet &mdash; its link to one of
                    these macros travels inside the application, so one click runs
                    the macro it names. Each macro below lists the buttons that run
                    it.
                    {buttonActions.length > 0 && (
                      <>
                        {" "}
                        A button whose code calls one of them by name runs it too;
                        the button actions below say which.
                      </>
                    )}
                  </li>
                  <li>
                    Anything of your own you point at one later: a button, a view
                    bookmark, or the command line. One of your own scripts can start
                    one too, but never with its reach: a macro for the workbook
                    script runtime is then refused, and one written as an object
                    script runs restricted.
                  </li>
                </ul>
                <p>
                  They will not run at all until this application&apos;s code is
                  approved, and allowing approves them:
                </p>
                <div style={scriptListStyle}>
                  {moduleScriptNames.map((name, i) => {
                    const id = moduleScriptIds[i];
                    const buttons = (id !== undefined ? macroButtons[id] : undefined) ?? [];
                    return (
                      <div key={i} data-consent-macro={id ?? name}>
                        <div style={scriptItemStyle}>{name}</div>
                        {buttons.length > 0 && (
                          <div style={macroButtonsStyle} data-consent-macro-buttons={id}>
                            <div>Buttons that run this macro:</div>
                            <ul style={macroButtonListStyle}>
                              {buttons.map((button) => (
                                <li key={`${button.kind}:${button.cell}`}>
                                  {describeConsentMacroButton(button)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {buttonActions.length > 0 && (
              <div data-consent-button-actions>
                {/* THE APPLICATION'S BUTTON ACTIONS, AS CODE. A subscribe or
                    refresh HOLDS a button's static inline code, and the Rust
                    button door runs it only after this grant approves its exact
                    bytes -- so the screen shows the bytes, never a summary, and
                    every place they sit. Two buttons carrying the same code are
                    one item with two places: the hash is the identity. A changed
                    button's code is a NEW item (its hash changed), shown in full
                    rather than as a diff. */}
                <p>
                  {scriptCount > 0 || moduleScriptNames.length > 0 ? (
                    <>Its buttons also carry code of their own: </>
                  ) : (
                    <>
                      The package <strong>"{packageName}"</strong> put buttons in this
                      workbook that carry code of their own:{" "}
                    </>
                  )}
                  {buttonActions.length} button action
                  {buttonActions.length !== 1 ? "s" : ""}. Each arrived held &mdash;
                  it runs only after this approval, only when its button is clicked,
                  and as its own code, never mixed with yours. This is exactly the
                  code each one carries, and every place it sits:
                </p>
                <div style={{ ...scriptListStyle, fontSize: 11 }}>
                  <div style={{ fontWeight: 600, color: "#333", marginBottom: 2 }}>
                    Button actions ({buttonActions.length})
                  </div>
                  {buttonActions.map((action) => (
                    <div key={action.id} style={buttonActionStyle} data-consent-button-action-item={action.hash}>
                      <pre style={buttonActionCodeStyle} data-consent-button-action={action.hash}>
                        {action.source}
                      </pre>
                      <div style={buttonActionNoteStyle} data-consent-button-action-locations={action.hash}>
                        <div>
                          {action.locations.length === 1 ? "On the button:" : `On ${action.locations.length} buttons:`}
                        </div>
                        <ul style={macroButtonListStyle}>
                          {action.locations.map((location) => (
                            <li key={location.cell}>{describeButtonActionLocation(location)}</li>
                          ))}
                        </ul>
                      </div>
                      {action.runsMacro !== null && (
                        <div style={buttonActionNoteStyle} data-consent-button-action-runs={action.hash}>
                          Runs the application&apos;s macro {action.runsMacro}.
                        </div>
                      )}
                      {action.refusedBecause !== null && (
                        <div
                          style={{ ...buttonActionNoteStyle, color: "#9a5b00", fontWeight: 600 }}
                          data-consent-button-action-refused={action.hash}
                        >
                          Will not run even if you allow it: {action.refusedBecause}.
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {commandButtons.length > 0 && (
              <div data-consent-commands>
                {/* THE CALCULA COMMANDS THE APPLICATION'S BUTTONS RUN (plan_M8
                    S3). A command is Calcula's own code, not the application's,
                    so there is no source to show -- what Allow approves is that
                    THIS application's buttons may decide when it runs. Rust's
                    command gate asks this approval at every click, under the
                    application's command key, and the page runs the command only
                    when its live registration opts in and Rust says yes again.
                    Listed by command, each with every button that runs it. */}
                <p>
                  {scriptCount > 0 || moduleScriptNames.length > 0 || buttonActions.length > 0 ? (
                    <>Its button cells also run Calcula commands:</>
                  ) : (
                    <>
                      The package <strong>"{packageName}"</strong> put buttons in this
                      workbook that run a Calcula command:
                    </>
                  )}
                </p>
                <div style={{ ...scriptListStyle, fontSize: 11 }}>
                  <div style={{ fontWeight: 600, color: "#333", marginBottom: 2 }}>
                    Buttons that run a Calcula command ({commandButtonCount})
                  </div>
                  {commandButtons.map((command) => (
                    <div key={command.commandId} style={buttonActionStyle} data-consent-command={command.commandId}>
                      <div style={scriptItemStyle}>
                        &quot;{command.commandName}&quot; ({command.commandId})
                      </div>
                      <div style={macroButtonsStyle} data-consent-command-buttons={command.commandId}>
                        <div>
                          {command.buttons.length === 1 ? "On the button:" : `On ${command.buttons.length} buttons:`}
                        </div>
                        <ul style={macroButtonListStyle}>
                          {command.buttons.map((button) => (
                            <li key={`${button.kind}:${button.cell}`}>{describeConsentMacroButton(button)}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ))}
                  <p style={{ ...buttonActionNoteStyle, margin: "6px 0 0" }}>
                    Each command is part of Calcula, not code from this application: allowing
                    lets this application&apos;s buttons decide when it runs, and it runs only
                    when you click one of them.
                  </p>
                </div>
              </div>
            )}

            {commandsWontRun.length > 0 && (
              <div data-consent-command-wont-run>
                {/* A stamped command no click can run -- its live registration
                    does not opt in, another registration has replaced it, or it
                    is not registered. Approving it would be a false yes, so it
                    is named, never recorded. */}
                <p style={{ color: "#9a5b00", fontWeight: 600, margin: "8px 0 4px" }}>
                  {commandsWontRun.length} command{commandsWontRun.length !== 1 ? "s" : ""} its
                  buttons name will not run even if you allow it:
                </p>
                <div style={scriptListStyle}>
                  {commandsWontRun.map((command) => (
                    <div key={command.commandId} style={scriptItemStyle}>
                      &quot;{command.commandName}&quot; ({command.commandId}): {command.why}.
                    </div>
                  ))}
                </div>
              </div>
            )}

            {reservedIdNames.length > 0 && (
              <>
                {/* A crafted workbook can name an object script or a macro with
                    an id from the button-action namespace. Rust refuses those at
                    pull, at mount and at record, so Allow cannot cover them --
                    and the screen says so rather than leaving the user to find
                    out at Run. */}
                <p style={{ color: "#9a5b00", fontWeight: 600, margin: "8px 0 4px" }}>
                  {reservedIdNames.length} item{reservedIdNames.length !== 1 ? "s" : ""} in this
                  application use an id Calcula reserves for button code, so{" "}
                  {reservedIdNames.length !== 1 ? "they" : "it"} cannot be approved and will not
                  run:
                </p>
                <div style={scriptListStyle}>
                  {reservedIdNames.map((name, i) => (
                    <div key={i} style={scriptItemStyle}>{name}</div>
                  ))}
                </div>
              </>
            )}

            {unapprovableMacroNames.length > 0 && (
              <>
                {/* A prompt that Allow cannot satisfy must SAY so. This
                    application ships a macro whose id is already used by one of
                    its object scripts; one consent record is a flat list keyed by
                    id, so the record cannot hold both and the object script keeps
                    the id. Allowing therefore leaves these refused — and while
                    that was unsaid, the freshness check still required their hash,
                    so the application asked again on every single open and no
                    amount of pressing Allow could stop it. */}
                <p style={{ color: "#9a5b00", fontWeight: 600, margin: "8px 0 4px" }}>
                  {unapprovableMacroNames.length} macro
                  {unapprovableMacroNames.length !== 1 ? "s" : ""} in this
                  application cannot be approved and will not run. Each one uses
                  the same internal id as one of the application&apos;s object
                  scripts, and an approval records one artifact per id &mdash; so
                  allowing does not cover {unapprovableMacroNames.length !== 1 ? "them" : "it"}.
                  Ask the publisher to give {unapprovableMacroNames.length !== 1 ? "them" : "it"} {" "}
                  {unapprovableMacroNames.length !== 1 ? "distinct ids" : "a distinct id"}.
                </p>
                <div style={scriptListStyle}>
                  {unapprovableMacroNames.map((name, i) => (
                    <div key={i} style={scriptItemStyle}>{name}</div>
                  ))}
                </div>
              </>
            )}
          </DialogPane>

          {/* WHAT ALLOWING PERMITS — the consequence. The capability list and
              both reach paragraphs say "these scripts", meaning the lists in the
              pane beside this one, so they belong next to them and not a screen
              below them. The re-consent DIFFS are deliberately not here: code
              needs the dialog's whole width, so they go full width underneath. */}
          <DialogPane
            scroll={twoColumn}
            padding={twoColumn ? BODY_PADDING : "0 20px 16px"}
            style={
              twoColumn ? { ...bodyTextStyle, ...paneDividerStyle } : stackedPaneStyle
            }
          >
            {twoColumn && (
              <DialogPaneTitle style={paneTitleStyle}>
                What allowing permits
              </DialogPaneTitle>
            )}
            {requestedCapabilities.length > 0 && (
              <>
                <p>
                  Allowing grants these scripts the following capabilities:
                </p>
                <ul style={capListStyle}>
                  {requestedCapabilities.map((cap) => (
                    <li key={cap.capability} style={capItemStyle}>
                      <span style={capIconStyle} aria-hidden="true">
                        {CAP_ICON[cap.capability] ?? "*"}
                      </span>
                      <span>
                        {cap.description}
                        {cap.origins.map((origin) => (
                          <code key={origin} style={capOriginStyle}>{origin}</code>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* THE REACH PARAGRAPH IS A FUNCTION OF WHAT THIS GRANT COVERS.
                Both sentences below describe the OBJECT-SCRIPT realm — the
                worker realm, clamped by the host to the sheet currently shown —
                so neither may be rendered on a prompt that has no object scripts
                in it. A macro-only application used to end with the
                restricted-mode sentence anyway: the last screen before a
                stranger's code runs described the containment of a surface that
                application does not use, and understated the one it does. The
                macro paragraph below states the macro surface's own reach, and it
                is pinned against core/script-engine/src/manifest.rs. */}
            {scriptCount > 0 &&
              (requestedCapabilities.length > 0 ? (
                /* CONSENT TEXT — held to the same bar as the capability itself.
                   "Scripts can only reach the objects they're attached to" was
                   false: the whole `sheet.*` family in scriptHost/allowlist.ts is
                   `tier: "restricted"`, so cell reads and writes need no
                   capability at all. What a capability gates is reach BEYOND the
                   workbook. Say that, and say the grid access plainly, rather
                   than implying an isolation the sandbox does not provide.
                   Mirrors CapabilityRequestDialog.tsx, which records the same
                   correction. */
                <p style={{ fontSize: 11, color: "#888" }}>
                  Anything not listed stays blocked. Even with nothing listed,
                  these scripts can read and write the cells of the sheet
                  currently shown — that is what an object script is for — but
                  they reach nothing outside this workbook: no network, no files,
                  no BI data.
                </p>
              ) : (
                /* "cannot read or write arbitrary cells" was simply not true:
                   sheet.getCellValue / sheet.setCellValue and the rest of the
                   sheet.* family are restricted-tier rows in
                   scriptHost/allowlist.ts, granted to every mounted object
                   script with no capability involved. Restricted mode limits
                   which SHEET — the host clamps to the sheet currently shown —
                   and it blocks everything outside the workbook. It does not
                   keep a script out of your cells. Wording matches the allowlist
                   rows' own `desc` on purpose. */
                <p>
                  Object scripts run in <strong>restricted mode</strong> — they
                  can read and write the cells of the sheet currently shown, and
                  they reach nothing outside this workbook: no network, no files,
                  no BI data. They have asked for no other permissions.
                </p>
              ))}

            {(moduleScriptNames.length > 0 || buttonActions.length > 0) && (
              <>
                {/* THE MACRO SURFACE'S OWN REACH, DERIVED — NOT BORROWED.
                    (A BUTTON ACTION runs on the same surface: the Rust button
                    door hands its bytes to `run_in_interpreter`, the very core
                    `run_script` uses -- so the same six classes describe it, and
                    the paragraph names whichever of the two this application
                    ships.)
                    A macro is a MODULE script: the run routes hand its source to
                    `run_script`, which is the `one-off-script` surface of the Rust
                    QuickJS interpreter. `SURFACE_PROFILES` in
                    core/script-engine/src/manifest.rs records how that realm is
                    built — no ModelDataProvider, no granted capability ids, host
                    globals left in place — and `surface_reach()` derives from it
                    exactly the six reach classes this paragraph enumerates:
                    grid, workbook, view, bookmarks, appMetadata, output. The
                    clauses below are in that order, and
                    macroSurfaceReachHonesty.test.ts fails if the manifest grows a
                    class this sentence does not name, or grants a capability this
                    sentence says cannot be granted.

                    It is deliberately WIDER than the object-script sentence in
                    two ways the user has to be told: a macro is not clamped to the
                    sheet currently shown, and there is no capability to withhold
                    because none is consulted.

                    A macro WRITTEN AS AN OBJECT SCRIPT is not on that surface: it
                    runs in a restricted worker realm, and owner decision B gives a
                    run YOU start cell access on any sheet and nothing more. It gets
                    its own paragraph below; this one then names the runtime it
                    describes, and is left out when no macro runs there. */}
                {(runtimeMacroCount > 0 || buttonActions.length > 0) && (
                  <p>
                    {interpreterReachSubject(runtimeMacroCount > 0, buttonActions.length > 0, objectScriptMacroCount > 0)}{" "}
                    in Calcula&apos;s isolated interpreter, on a copy of this
                    workbook, and what it may touch there is fixed &mdash; there is
                    no permission to grant and none to withhold: the cells of any
                    sheet in this workbook; its sheets, document properties and
                    calculation settings; how it is displayed; its bookmarks;
                    Calcula&apos;s own version and locale settings, which it can
                    read; and the results it prints back to you. It reaches nothing
                    else: no network, no files, no BI data.
                  </p>
                )}
                {objectScriptMacroCount > 0 && (
                  <p data-consent-object-script-macros={objectScriptMacroCount}>
                    {describeObjectScriptMacroReach(objectScriptMacroCount, moduleScriptNames.length)}
                  </p>
                )}
              </>
            )}

            {commandButtons.length > 0 && (
              /* A COMMAND'S REACH (plan_M8 S3) is the command's own: the page
                 runs the very registration a ribbon or menu would, with the same
                 context (buttonCommandRun.ts, buildCommandContext) -- the
                 approval decides who may start it, never what it may touch. */
              <p data-consent-command-reach>
                A command runs as the Calcula feature it is, with the same reach it has when
                you run it yourself; allowing changes only who may start it &mdash; this
                application&apos;s buttons, when you click them.
              </p>
            )}

            {/* SEALED TO THIS COMPUTER (M6). An approval is kept in the workbook
                but counts only on the computer that made it
                (app/src-tauri/src/consent_seal.rs), so the sentence says where
                it is remembered -- and when this workbook carries an approval
                that does not count here, the screen says why it is asking. */}
            {approvalMadeElsewhere && (
              <p style={{ fontSize: 11, color: "#7a4a00" }} data-consent-approval-elsewhere>
                This workbook carries an approval of this application that was made on
                another computer, or before approvals were tied to a computer, and it does
                not count here &mdash; so you are asked again on this one.
              </p>
            )}
            <p style={{ fontSize: 11, color: "#888" }}>
              You can inspect the source before allowing. Allowing is remembered
              with this workbook on this computer only; if the application changes
              any script&apos;s, macro&apos;s or button&apos;s code, or requests new
              capabilities, you will be asked again.
            </p>
          </DialogPane>
        </DialogBody>

        {/* THE RE-CONSENT DIFF, FULL WIDTH AND OUTSIDE BOTH PANES. This is the
            highest-stakes thing on a re-consent prompt and it is CODE: a column
            would hand it less room than the old single-column body did, not
            more. Its own scroller, below the panes and above the footer, so an
            expanded diff can never push Block/Allow off the screen. */}
        {changedScripts.length > 0 && (
          <div style={diffStripStyle}>
            <p style={{ color: "#9a5b00", fontWeight: 600, margin: "0 0 4px" }}>
              {changedScripts.length} script{changedScripts.length === 1 ? "" : "s"} changed
              since you last approved this package &mdash; review what changed before allowing:
            </p>
            {changedScripts.map((cs) => (
              <ScriptChangeDiff key={cs.id} {...cs} />
            ))}
          </div>
        )}

        <div style={footerStyle}>
          {canInspect && (
            <button style={btnStyle} onClick={handleInspect}>
              {inspecting ? "Inspecting..." : "Inspect Scripts"}
            </button>
          )}
          {inspectError !== null && (
            <span style={{ fontSize: 11, color: "#D13438", alignSelf: "center" }}>
              {inspectError}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button style={btnDangerStyle} onClick={handleBlock}>
            Block
          </button>
          <button style={btnPrimaryStyle} onClick={handleAllow}>
            Allow Scripts
          </button>
        </div>
      </div>
    </div>
  );
}
