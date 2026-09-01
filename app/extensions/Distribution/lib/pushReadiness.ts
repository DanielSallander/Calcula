// FILENAME: app/extensions/Distribution/lib/pushReadiness.ts
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
