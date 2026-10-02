//! FILENAME: app/extensions/Collaboration/components/ButtonActionsNotice.tsx
// PURPOSE: Say which button-CELL actions an application brought that did not
//          arrive armed (BUG-0260) -- removed on a subscribe or a refresh, held
//          at a checkout -- which button-CONTROL macro links a subscribe or
//          refresh removed (phase 3 of BUG-0257, `ButtonLinksNotice`), and
//          which button-CONTROL inline code it removed or held (phase 4,
//          `InlineButtonCodeNotice`, `describeInlineButtonCodeHeld`).
// CONTEXT: A button cell from an application runs only a macro that
//          application brought into this workbook, and a command only when it
//          is on Calcula's list of commands such buttons may run (plan_M8;
//          `DISTRIBUTABLE_BUTTON_COMMANDS`, empty today) and approved. Rust
//          decides that at every door (app/src-tauri/src/button_cells.rs) and
//          returns one sentence per action it did not keep live
//          ("Dashboard!C3: runs the macro 'macro-report', which ..."). A button
//          that silently does nothing is the failure this feature has fought
//          before, so the list is shown where the pull, refresh or checkout
//          reports its result.

import React from "react";

export interface ButtonActionsNoticeProps {
  /** One sentence per action, as the backend wrote it. */
  actions: readonly string[] | null | undefined;
  /** "removed" (subscribe, refresh) or "held" (checkout). */
  mode: "removed" | "held";
  testId?: string;
}

const boxStyle: React.CSSProperties = {
  fontSize: "12px",
  margin: "8px 0",
  padding: "6px 8px",
  border: "1px solid var(--border-default)",
  borderRadius: 4,
};

/** The heading line for `count` actions. Pure, for tests and callers. */
export function describeButtonActions(count: number, mode: "removed" | "held"): string {
  const plural = count === 1 ? "" : "s";
  return mode === "removed"
    ? `${count} button cell${plural} came with ${count === 1 ? "an action" : "actions"} this ` +
        "workbook will not run, and " +
        (count === 1 ? "it was" : "they were") +
        " removed: a button from an application runs only a macro that application brought in, " +
        "and a command only when it is on Calcula's list of commands such buttons may run."
    : `${count} button cell action${plural} came with this application but ` +
        (count === 1 ? "runs" : "run") +
        " a macro it did not bring in, or a command that is not on Calcula's list of commands such buttons may run. " +
        (count === 1 ? "It does" : "They do") +
        " not run in this working copy; your next push publishes " +
        (count === 1 ? "it" : "them") +
        " unchanged, after checking against this signed version.";
}

export function ButtonActionsNotice({
  actions,
  mode,
  testId,
}: ButtonActionsNoticeProps): React.ReactElement | null {
  if (!actions || actions.length === 0) return null;
  return (
    <div style={boxStyle} data-testid={testId ?? `button-actions-${mode}`}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>Button cells</div>
      <div>{describeButtonActions(actions.length, mode)}</div>
      <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
        {actions.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================================
// Button CONTROLS' macro links (phase 3 of BUG-0257)
// ============================================================================
//
// A button control from an application keeps its link to that application's
// macro -- held, stamped, run after approval -- only when the pull or refresh
// actually brought that macro into this workbook. Any other link is removed by
// the Rust admission (`DistributedWiring::LinkLanded`,
// app/src-tauri/src/held_button_code.rs), which returns one sentence per link
// ("Dashboard!C3: links the macro \"X\", which ..."). The same reason as above
// applies: a button that silently does nothing is the failure to avoid.

/** The heading line for `count` removed links. Pure, for tests and callers. */
export function describeButtonLinksRemoved(count: number): string {
  const plural = count === 1 ? "" : "s";
  return (
    `${count} button${plural} linked a macro this application did not bring into this ` +
    `workbook, and ${count === 1 ? "the link was" : "the links were"} removed: a button from an ` +
    "application runs only that application's own macros, never one of yours with the same name."
  );
}

/** One clause for a summary line: how many buttons kept a link to the application's macros. */
export function describeButtonLinksHeld(count: number): string {
  if (count <= 0) return "";
  return (
    `${count} button${count === 1 ? "" : "s"} linked to its macros ` +
    "(they run after you approve the application's code)"
  );
}

export function ButtonLinksNotice({
  links,
  testId,
}: {
  /** One sentence per removed link, as the backend wrote it. */
  links: readonly string[] | null | undefined;
  testId?: string;
}): React.ReactElement | null {
  if (!links || links.length === 0) return null;
  return (
    <div style={boxStyle} data-testid={testId ?? "button-links-removed"}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>Buttons</div>
      <div>{describeButtonLinksRemoved(links.length)}</div>
      <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
        {links.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================================
// Button CONTROLS' inline code (phase 4 of BUG-0257)
// ============================================================================
//
// A button control's own inline code (`onSelect`) now travels with its
// application: a subscribe or refresh HOLDS static code, stamped with the
// application, and the Rust button door runs it only after the approval screen
// has shown those exact bytes (`DistributedWiring::LinkLanded`,
// app/src-tauri/src/held_button_code.rs). Code written as a FORMULA cannot be
// approved as exact bytes, so it is removed, one sentence per button
// ("Dashboard!B2: its action is a formula, which Calcula does not run as
// button code; it was removed").

/** The heading line for `count` buttons whose inline code was removed. Pure, for tests and callers. */
export function describeInlineButtonCodeRemoved(count: number): string {
  const plural = count === 1 ? "" : "s";
  return (
    `${count} button${plural} came with code written as a formula, which Calcula does not run as ` +
    `button code, and ${count === 1 ? "it was" : "they were"} removed: a button runs an ` +
    "application's own code only when you can approve its exact text."
  );
}

/** One clause for a summary line: how many buttons arrived with code of their own, held until approved. */
export function describeInlineButtonCodeHeld(count: number): string {
  if (count <= 0) return "";
  return (
    `${count} button${count === 1 ? "" : "s"} with code of ${count === 1 ? "its" : "their"} own ` +
    `(${count === 1 ? "it runs" : "they run"} only after you approve that code; the approval screen shows it)`
  );
}

export function InlineButtonCodeNotice({
  removed,
  testId,
}: {
  /** One sentence per removed inline action, as the backend wrote it. */
  removed: readonly string[] | null | undefined;
  testId?: string;
}): React.ReactElement | null {
  if (!removed || removed.length === 0) return null;
  return (
    <div style={boxStyle} data-testid={testId ?? "inline-button-code-removed"}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>Button code</div>
      <div>{describeInlineButtonCodeRemoved(removed.length)}</div>
      <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
        {removed.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
