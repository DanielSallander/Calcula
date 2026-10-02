// FILENAME: app/extensions/Collaboration/lib/pushReadiness.ts
// PURPOSE: Why the Publish dialog cannot push yet, in the user's words.
// CONTEXT: This was inline in the dialog as a boolean, `canPush`, wired to
//          `disabled={!canPush}` — so the button went dead and said nothing.
//          The one condition a complete-looking dialog still fails is the change
//          summary, whose PLACEHOLDER is a full sentence and therefore reads as
//          a value somebody typed. Pressing Push produced no error, no status
//          and no movement, which is indistinguishable from a broken build.
//
//          A boolean cannot explain itself, so the boolean is gone: this returns
//          the REASON, named per field, and the dialog both shows it live beside
//          the button and returns it on click.

import type { UnshippedMacroLinkItem } from "@api";

/**
 * One button whose macro the push does not publish, as the sentence the
 * dialog shows -- naming the remedy that WORKS for it (M4). The push itself
 * refuses these by name (`CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED`); this says so
 * before the button is pressed.
 */
export function describeUnshippedLink(link: UnshippedMacroLinkItem): string {
  const button = link.kind === "cell" ? `The button cell at ${link.cell}` : `The button at ${link.cell}`;
  const name = link.macroName || link.macroId;
  switch (link.remedy) {
    case "include":
      return (
        `${button} runs the macro "${name}", which this push does not publish: tick Include in ` +
        "application next to it, or unlink the button."
      );
    case "otherApplication":
      return (
        `${button} runs "${name}", which belongs to the application "${link.owner || "another application"}": ` +
        "a button in this application cannot run another application's macro. Unlink it, or copy the macro " +
        "to your own and include the copy."
      );
    case "missing":
      return (
        `${button} runs the macro "${link.macroId}", which does not exist in this workbook: unlink the ` +
        "button, or restore the macro."
      );
  }
}

/** The inputs a push decision depends on. */
export interface PushReadinessInput {
  /** `"loading"` until the working-copy link has been read. */
  mode: "loading" | "push" | "create";
  registryPath: string;
  packageName: string;
  version: string;
  changeSummary: string;
  /** True once a push has landed — the dialog is then a receipt. */
  pushed: boolean;
  /** How many sheets are ticked. */
  sheetsSelected: number;
  /** How many the dialog is offering. 0 while the list is still loading. */
  sheetsAvailable: number;
  /**
   * The application kind. `"library"` is the one kind for which zero sheets is
   * the CORRECT answer — a function library ships no data — so it is the one
   * kind the empty-selection refusal must not apply to.
   */
  kind: string;
  /**
   * True when CREATE mode has been typed a name that already exists in the
   * chosen workspace.
   *
   * The backend refuses it (`CalpError::ApplicationAlreadyExists`), but only
   * after the click. Knowing it earlier is what lets the dialog offer the right
   * door — opening that application for editing — instead of a dead end.
   */
  nameAlreadyTaken: boolean;
  /**
   * Held button code the push cannot prove is the application's (BUG-0257).
   * Any refuses the push, so the button says so before it is pressed.
   */
  buttonCodeRefused?: number;
  /**
   * Button code the application's signed version does not have that the author
   * has not ticked yet. Each must be read and acknowledged.
   */
  buttonCodeUnacknowledged?: number;
  /**
   * The button-code review on screen answers a DIFFERENT sheet selection than
   * the one ticked (it is being fetched again, or the fetch failed). Its counts
   * cannot be trusted either way, so the push waits for the right answer.
   */
  buttonCodeStale?: boolean;
  /**
   * Buttons on the ticked sheets that run a macro this push does not publish
   * (M4). The push refuses while any remain, so the first one is named here
   * with its remedy.
   */
  unshippedMacroLinks?: readonly UnshippedMacroLinkItem[];
  /**
   * What the author ticked under "Include in application" is not what the
   * answer on screen was computed for (it is being fetched again, or the fetch
   * failed). Like `buttonCodeStale`, its counts cannot be trusted either way.
   */
  includeStale?: boolean;
  /**
   * The names of ticked items the answer did not add as they were read: their
   * code changed since, or they are no longer the author's to add. The push
   * would refuse them (`CALP_PUSH_INCLUDED_CHANGED`).
   */
  includeChanged?: readonly string[];
}

/**
 * `null` when the dialog is ready to push, otherwise one sentence naming the
 * field that is not.
 *
 * Ordered by what the user would fix first, and deliberately NOT collapsed into
 * "fill in the required fields" — that message is what sent people looking at
 * the wrong field in the first place.
 */
export function pushBlockingReason(i: PushReadinessInput): string | null {
  if (i.mode === "loading") return "Still reading this workbook's working-copy link.";
  if (i.pushed) return null;
  if (i.registryPath.trim() === "") {
    return i.mode === "push"
      ? "This working copy names no workspace. Re-open the application for editing."
      : "Choose the workspace to publish into.";
  }
  if (i.packageName.trim() === "") return "Give the application a name.";
  // Refused here rather than left to the backend, because the remedy is a UI
  // branch: this workbook cannot create a second application under that name,
  // but it CAN open the existing one for editing and add a sheet to it.
  if (i.nameAlreadyTaken) {
    return (
      `An application called "${i.packageName.trim()}" already exists in this ` +
      "workspace. Choose another name, or open that one for editing and push a " +
      "new version of it."
    );
  }
  if (i.version.trim() === "") return "Give this version a number.";
  // AN EMPTY TICK-LIST IS NOT AN EMPTY PUBLISH. On the wire, an empty
  // `sheetIndices` means "resolve the default", which for a working copy is the
  // base version's sheets — so pressing Push with every box clear would publish
  // the default set, and the diff panel above would (correctly, and very
  // confusingly) describe that set while the list showed nothing selected.
  //
  // Reported from live testing as "even if no sheets are selected it shows a
  // diff in the section above. It looks a bit glitchy." The glitch was the
  // dialog being honest about a push the checkboxes denied.
  //
  // Refused rather than reinterpreted: "publish nothing" is not a gesture
  // anybody wants, and "publish the default" is not what an empty list says.
  if (
    i.kind !== "library" &&
    i.sheetsAvailable > 0 &&
    i.sheetsSelected === 0
  ) {
    return "Tick at least one sheet to publish.";
  }
  if (i.buttonCodeStale) {
    return (
      "Checking the button code for the sheets you ticked. If this does not clear, press " +
      "Preview."
    );
  }
  if (i.includeStale) {
    return (
      "Checking what you included in the application. If this does not clear, press " +
      "Preview."
    );
  }
  if ((i.buttonCodeRefused ?? 0) > 0) {
    return (
      `${i.buttonCodeRefused} button code slot(s) came with an application but cannot be ` +
      'proved to be its code, so the push would be refused. See "Button code in this push".'
    );
  }
  if ((i.buttonCodeUnacknowledged ?? 0) > 0) {
    return (
      `Read and tick the ${i.buttonCodeUnacknowledged} piece(s) of button code under ` +
      "\"Button code in this push\": the application's signed version does not have them, " +
      "and they would be published under your key."
    );
  }
  const changed = i.includeChanged ?? [];
  if (changed.length > 0) {
    return (
      `${changed.map((n) => `"${n}"`).join(", ")} changed since you read it, or can no longer be ` +
      "added: open its code again and tick Include in application, or untick it. What you add goes " +
      "out under your key, so it must be exactly what you read."
    );
  }
  const links = i.unshippedMacroLinks ?? [];
  if (links.length > 0) {
    const more = links.length - 1;
    return (
      describeUnshippedLink(links[0]) +
      (more > 0 ? ` (and ${more} more button(s) under "Buttons that run a macro this push leaves out")` : "")
    );
  }
  // CREATE may omit it — there is no history to explain yet. A PUSH may not:
  // the summary is what the next reader of the version list actually sees.
  if (i.mode === "push" && i.changeSummary.trim() === "") {
    return (
      "Say what changed. A push records it in the signed manifest, so subscribers " +
      "and co-developers can read it in the version history — it is the one field " +
      "a push cannot omit."
    );
  }
  return null;
}
