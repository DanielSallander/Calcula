//! FILENAME: app/extensions/Controls/lib/buttonClickDiagnosis.ts
// PURPOSE: When a run-mode click on a button did NOT run anything, say why.
// CONTEXT: "I click the button and nothing happens" has been the report on this
//          feature twice, and both times the click path was silent by
//          construction: it dispatched `button:clicked` into the void, ran an
//          empty `onSelect`, and returned. A click is the single best moment to
//          explain a broken binding — the user is looking straight at the
//          control they expected to work — and it was the one moment that said
//          nothing at all.
//
//          Four distinguishable states, four different remedies:
//            1. no inline action AND no object script  -> nothing is bound
//            2. a script exists but is not mounted     -> Script Security, or
//                                                         it failed to start
//            3. mounted, but no `button.onClick` hook  -> the script's setup()
//                                                         never registered one
//            4. anything ran                           -> silence is correct
//
//          Kept out of index.ts so it can be tested without booting the whole
//          extension, and so the wording lives in one readable place.

/** What the click found. `null` = something ran; nothing to say. */
export interface ButtonClickDiagnosis {
  reason: "unbound" | "notMounted" | "noClickHandler";
  message: string;
  variant: "warning" | "error";
}

/** The facts the diagnosis is derived from, supplied by the caller. */
export interface ButtonClickFacts {
  /** True when the control's own inline `onSelect` source ran. */
  ranInline: boolean;
  /** The object script bound to this control's instanceId, if any. */
  script: { id: string; name: string } | null;
  /** Whether that script is currently mounted (running). */
  mounted: boolean;
  /** Whether the mounted script registered a `button.onClick` handler. */
  hasClickHandler: boolean;
}

export function diagnoseButtonClick(
  facts: ButtonClickFacts,
): ButtonClickDiagnosis | null {
  if (facts.ranInline) return null;

  if (!facts.script) {
    return {
      reason: "unbound",
      variant: "warning",
      message:
        "This button has no action bound to it yet: no inline OnSelect code and " +
        "no object script for it. Add one from Developer ▸ Macros… " +
        "(Add Button) or the button's Properties pane.",
    };
  }

  if (!facts.mounted) {
    return {
      reason: "notMounted",
      variant: "error",
      message:
        `"${facts.script.name}" is bound to this button but is NOT running — ` +
        "its object script never mounted (Script Security may have blocked it, " +
        "or it failed to start). Mount it from Developer ▸ Object Scripts " +
        "to see why.",
    };
  }

  if (!facts.hasClickHandler) {
    return {
      reason: "noClickHandler",
      variant: "warning",
      message:
        `"${facts.script.name}" is running, but it never registered a click ` +
        "handler (`context.onClick(...)` in its `setup`), so this click has " +
        "nowhere to go.",
    };
  }

  // Mounted, hooked, and the host forwarded the event: the script owns the
  // outcome from here, including any error it reports itself.
  return null;
}
