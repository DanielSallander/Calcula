//! FILENAME: app/extensions/Controls/PropertiesPane/HeldCodeSection.tsx
// PURPOSE: Show a button's HELD application code read-only (BUG-0257), and the
//          three explicit steps that change it: replace it with the author's
//          own, remove it, or make it the author's own.
// CONTEXT: A button's code that came with an application is kept in the held
//          compartment, stamped with where it came from: at a checkout (a
//          working copy publishes it unchanged at the next push) and, since
//          phase 4, at a subscribe or refresh too. It TRAVELS with its
//          application and runs only after that application's approval: a held
//          macro LINK runs the application's macro (phase 3,
//          lib/applicationMacroLink.ts), and held static INLINE code runs through
//          the Rust button door (`run_control_action`) once the approval screen
//          has shown its exact bytes (phase 4). What a click does is the door's
//          to decide, so the inline note here says it by the door's own rule
//          (`heldInlineVerdict`) -- never "inert", which an approved click
//          contradicts.
//
//          The code must be VISIBLE where it lives, so it is shown here verbatim
//          -- never as an editable field. The editable OnSelect field is hidden
//          while held code exists: on such a button it read "" and committed on
//          blur, so tabbing through it used to replace the application's code
//          with nothing. Each step that changes held code shows it first
//          (confirmAsync, awaited, failing closed):
//            * REPLACE unlocks OnSelect; the backend removes the held code when
//              the author's own code is committed, as one undoable step;
//            * REMOVE discards it (an empty OnSelect commit is the tab-through
//              no-op, so without it an application button's action could not be
//              removed at all -- the next push restored it);
//            * MAKE THIS MY OWN (phase 4) MOVES it into the live slots in Rust
//              (`adopt_held_button_code`), as one undoable, always-audited step.
//              It sends back exactly the texts the confirm showed, captured
//              before the confirm was asked, and Rust refuses if the held code
//              is no longer those texts. Button CONTROLS only (owner decision
//              Q4): a button CELL's held action keeps "give it an action of your
//              own", because dropping its stamp would widen what it runs. The
//              button's right-click menu offers the same step through this same
//              confirm (`requestHeldAdoption`, owner question 8:
//              lib/controlContextMenu.ts `makeHeldButtonCodeOwn`).

import React, { useCallback, useState } from "react";
import { confirmAsync } from "@api/dialogs";
import {
  describeHeldMacroLink,
  describeHeldOrigin,
  type HeldButtonCode,
  type HeldInlineVerdict,
} from "@api/heldButtonCode";

const v = (token: string) => `var(${token})`;

const noteStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.45,
  color: v("--text-secondary"),
  padding: "4px 12px",
};

const codeStyle: React.CSSProperties = {
  margin: "4px 12px",
  padding: "6px 8px",
  fontFamily: "Consolas, 'Cascadia Mono', monospace",
  fontSize: 11,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 180,
  overflow: "auto",
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 3,
  backgroundColor: v("--panel-bg"),
  color: v("--text-primary"),
  userSelect: "text",
};

const buttonStyle: React.CSSProperties = {
  margin: "6px 12px 8px",
  padding: "4px 10px",
  fontSize: 11,
  border: `1px solid ${v("--border-default")}`,
  borderRadius: 3,
  backgroundColor: v("--bg-surface"),
  color: v("--text-primary"),
  cursor: "pointer",
  fontFamily: v("--font-family-sans"),
};

/** The options every confirm here passes (the shape of `confirmAsync`'s). */
type ConfirmOptions = { title?: string; kind?: "info" | "warning" | "error"; okLabel?: string };
/** `confirmAsync`'s shape: a Promise, as under Tauri -- never a synchronous boolean. */
type Confirm = (message: string, options?: ConfirmOptions) => Promise<boolean>;

/**
 * What the held inline code does when its button is clicked, in one sentence,
 * by the Rust button door's own rule (`heldInlineVerdict`, mirroring
 * `control_action::decide_control`): it runs once the application's code is
 * approved, or no click ever runs it, and why. Exported for the unit tier.
 */
export function describeHeldInlineNote(verdict: HeldInlineVerdict): string {
  return verdict.runs
    ? "Runs when clicked, after you approve the application's code."
    : `Never runs here: ${verdict.why}.`;
}

/** The confirm text: the held code, verbatim, and what replacing it does. */
export function describeHeldReplacement(held: HeldButtonCode): string {
  const parts = [`This button's code came with the application ${describeHeldOrigin(held)}:`];
  if (held.onSelect !== null) parts.push(`OnSelect:\n${held.onSelect}`);
  if (held.macroRef !== null) parts.push(`Runs the macro "${held.macroRef}".`);
  parts.push(
    "Replace it with your own code? Once you enter your code in OnSelect, the " +
      "application's code is removed from this button (Ctrl+Z brings it back). In a " +
      "working copy, the next push publishes YOUR code here and asks you to review it " +
      "first; in a subscribed workbook, the application's next update puts its own " +
      "button back.",
  );
  return parts.join("\n\n");
}

/**
 * Ask before unlocking the OnSelect field of a held button. Resolves true only
 * on an explicit yes: `confirmAsync` fails closed, so a dialog that cannot be
 * shown is a refusal. `confirm` is injectable for the unit tier.
 */
export async function requestHeldReplacement(
  held: HeldButtonCode,
  confirm: Confirm = confirmAsync,
): Promise<boolean> {
  return confirm(describeHeldReplacement(held), {
    title: "Replace the application's code",
    kind: "warning",
    okLabel: "Replace",
  });
}

/** The confirm text for REMOVING the held code: the code, verbatim, and what removing does. */
export function describeHeldRemoval(held: HeldButtonCode): string {
  const parts = [`This button's code came with the application ${describeHeldOrigin(held)}:`];
  if (held.onSelect !== null) parts.push(`OnSelect:\n${held.onSelect}`);
  if (held.macroRef !== null) parts.push(`Runs the macro "${held.macroRef}".`);
  parts.push(
    "Remove it? The button is left with no code, and the next push publishes it WITHOUT " +
      "the application's code (Ctrl+Z brings it back).",
  );
  return parts.join("\n\n");
}

/**
 * Ask before REMOVING a held button's code. Resolves true only on an explicit
 * yes (`confirmAsync` fails closed). `confirm` is injectable for the unit tier.
 */
export async function requestHeldRemoval(
  held: HeldButtonCode,
  confirm: Confirm = confirmAsync,
): Promise<boolean> {
  return confirm(describeHeldRemoval(held), {
    title: "Remove the application's code",
    kind: "warning",
    okLabel: "Remove",
  });
}

/**
 * The held texts a "Make this my own" confirm SHOWED, exactly as it showed
 * them (null for a slot it did not show). This, and never a fresh read, is
 * what goes back to Rust: Rust compares it with what the button holds under
 * the lock of the move, so code that changed while the dialog was open is
 * refused, not adopted unseen.
 */
export interface HeldAdoptionShown {
  onSelect: string | null;
  macroRef: string | null;
}

/**
 * The confirm text for MAKING the held code the author's own: the code,
 * verbatim, and what adopting it means -- whose code it becomes, what still
 * needs the application's approval, what a push and an update do, the undo,
 * and the audit row.
 */
export function describeHeldAdoption(held: HeldButtonCode): string {
  const parts = [`This button's code came with the application ${describeHeldOrigin(held)}:`];
  if (held.onSelect !== null) parts.push(`OnSelect:\n${held.onSelect}`);
  if (held.macroRef !== null) parts.push(`Runs the macro "${held.macroRef}".`);
  parts.push(
    "Make it your own? It moves into this button's own code and becomes YOUR code: a " +
      "click runs it without asking for the application's approval. " +
      (held.macroRef !== null
        ? "The macro it runs stays the application's, and still runs only after you " +
          "approve the application's code."
        : "A macro of the application that it calls stays the application's, and still " +
          "runs only after you approve the application's code."),
  );
  parts.push(
    "In a working copy, the next push publishes it as YOUR code, and asks you to review " +
      "it first if it differs from the signed version. In a subscribed workbook, the " +
      "application's next update puts its own button back.",
  );
  parts.push(
    "Ctrl+Z brings the application's code back. This step is recorded in the audit trail.",
  );
  return parts.join("\n\n");
}

/**
 * Ask before MAKING a held button's code the author's own. Resolves true only
 * on an explicit `true`: anything else -- a no, a value that is not a boolean,
 * a dialog that rejects -- is a refusal (`confirmAsync` fails closed, and so
 * does this). `confirm` is injectable for the unit tier.
 */
export async function requestHeldAdoption(
  held: HeldButtonCode,
  confirm: Confirm = confirmAsync,
): Promise<boolean> {
  try {
    const answer = await confirm(describeHeldAdoption(held), {
      title: "Make the application's code your own",
      kind: "warning",
      okLabel: "Make it my own",
    });
    return answer === true;
  } catch (err) {
    console.warn("[Controls] The \"Make this my own\" dialog could not be shown; nothing was changed:", err);
    return false;
  }
}

export interface HeldCodeSectionProps {
  held: HeldButtonCode;
  /**
   * Whether a click can run the held INLINE code once it is approved -- the
   * door's rule, from `heldInlineVerdict` over the control's stored properties.
   * Null when the button holds no inline code.
   */
  inlineVerdict: HeldInlineVerdict | null;
  /** Called after the author confirmed; unlocks the OnSelect field. */
  onReplace: () => void;
  /**
   * Called after the author confirmed REMOVING the held code: discards it in the
   * backend as one undoable step. Absent = no remove button.
   */
  onRemove?: () => Promise<void> | void;
  /**
   * Called after the author confirmed MAKING the held code their own, with
   * exactly the texts the confirm showed. Absent = no "Make this my own" button.
   */
  onAdopt?: (shown: HeldAdoptionShown) => Promise<void> | void;
}

export const HeldCodeSection: React.FC<HeldCodeSectionProps> = ({
  held,
  inlineVerdict,
  onReplace,
  onRemove,
  onAdopt,
}) => {
  const [asking, setAsking] = useState(false);
  const replace = useCallback(async () => {
    setAsking(true);
    try {
      if (await requestHeldReplacement(held)) onReplace();
    } finally {
      setAsking(false);
    }
  }, [held, onReplace]);
  const remove = useCallback(async () => {
    if (!onRemove) return;
    setAsking(true);
    try {
      if (await requestHeldRemoval(held)) await onRemove();
    } finally {
      setAsking(false);
    }
  }, [held, onRemove]);
  const adopt = useCallback(async () => {
    if (!onAdopt) return;
    // Exactly what the confirm is about to show, captured BEFORE it is asked:
    // if the held code changes while the dialog is open, Rust refuses these
    // texts -- a fresh read here would adopt code the author never saw.
    const shown: HeldAdoptionShown = { onSelect: held.onSelect, macroRef: held.macroRef };
    setAsking(true);
    try {
      if (await requestHeldAdoption(held)) await onAdopt(shown);
    } finally {
      setAsking(false);
    }
  }, [held, onAdopt]);

  const version = held.version ? `v${held.version}` : "version";
  return (
    <div data-held-code-section={held.application}>
      <div style={noteStyle}>
        This button&apos;s code came with the application {describeHeldOrigin(held)} and stays
        the application&apos;s. In a working copy a push publishes it unchanged, after checking it
        against the signed {version}.
      </div>
      {held.onSelect !== null ? (
        <>
          {/* Phase 4 of BUG-0257: held INLINE code runs through the Rust button
              door once its exact bytes are approved -- unless no click can run
              it (a link wins, a formula, an unreadable stamp), which is said. */}
          {inlineVerdict ? (
            <div style={noteStyle} data-held-code-note="onSelect">
              {describeHeldInlineNote(inlineVerdict)}
            </div>
          ) : null}
          <pre style={codeStyle} data-held-code="onSelect">
            {held.onSelect}
          </pre>
        </>
      ) : null}
      {held.macroRef !== null ? (
        // Phase 3 of BUG-0257: a held LINK runs its application's macro, behind
        // the application's approval -- never an inert slot.
        <div style={noteStyle} data-held-code="macroRef">
          {describeHeldMacroLink(held.macroRef)}
        </div>
      ) : null}
      <button type="button" style={buttonStyle} disabled={asking} data-held-replace onClick={() => void replace()}>
        Replace the application&apos;s code…
      </button>
      {onRemove ? (
        <button type="button" style={buttonStyle} disabled={asking} data-held-remove onClick={() => void remove()}>
          Remove the application&apos;s code…
        </button>
      ) : null}
      {onAdopt ? (
        <button type="button" style={buttonStyle} disabled={asking} data-held-adopt onClick={() => void adopt()}>
          Make this my own…
        </button>
      ) : null}
    </div>
  );
};
