//! FILENAME: app/src/core/lib/pointerClaims.ts
// PURPOSE: The one generic rule that decides whether a GESTURE on the grid
//          belongs to the GRID or to something an extension put on top of it: a
//          gesture whose target lies inside an element carrying
//          `data-pointer-claim` is not the grid's gesture. "Gesture" is both a
//          pointer press and a KEYSTROKE — see "THE KEYBOARD IS THE SAME RULE".
//
// CONTEXT: Core's pointer entry is bound to `S.GridArea`
//          (components/Spreadsheet/Spreadsheet.tsx, `onMouseDown`), which is an
//          ANCESTOR of everything the on-grid surfaces append into
//          `canvas.parentElement`. So an element stacked over the canvas that
//          believes it has taken a gesture has taken nothing: the native
//          `mousedown` bubbles straight past it into Core, which then re-selects
//          the object under it, moves the cell selection, and — because
//          `handleCellMouseDown` calls `event.preventDefault()` before its first
//          await — cancels the browser's focus on whatever the user clicked.
//          `stopPropagation` on `pointerdown`/`click` does not help: Core does
//          not listen for those, and it is not on the canvas.
//
//          Three shipped defects were ONE defect wearing three coats:
//            1. a right-press on a run-mode button reached
//               `handleOverlayMoveMouseDown`, which dispatched
//               `floatingObject:selected`, which Controls turns into
//               `button:clicked` — a right-click RAN the macro;
//            2. a shape script's DECLARED hit rectangle (M3b) was decorative:
//               the click inside it still selected the shape and opened the
//               properties pane;
//            3. a click on an embedded form's widget (M3c) never focused it,
//               because the grid's `preventDefault` ran first and the cell
//               selection moved to the cell UNDER the form.
//
// WHY A DATA ATTRIBUTE AND NOT A REGISTERED PREDICATE
//   A predicate registry is more general and is the wrong trade here:
//     - Its lifetime is manual. A claimant that unregisters late leaves a hole
//       that swallows grid clicks forever; one that unregisters early goes
//       decorative again. An attribute lives ON the element, so removing the
//       element removes the claim — the shape shims are destroyed in Design
//       Mode and the claim goes with them, with no second bookkeeping step that
//       can drift. This codebase has the cautionary tale in-tree: the embedded
//       form layer registered a `hitTest` whose answer Core never asked for,
//       "a claim nothing can honour".
//     - A predicate is asked with COORDINATES, which is how `checkOverlayBody`
//       already gets this wrong — geometry cannot tell "the pointer is over the
//       shape's box" from "the pointer is over the element the script put
//       there". The DOM already answered that question by hit-testing; the
//       ancestor walk reads its answer instead of recomputing a worse one.
//     - It is inspectable. A claim is visible in the DOM and assertable from an
//       E2E spec without reaching into module state.
//
//   Core never reads the attribute's VALUE. It is the claimant's own label,
//   there so a stray claim can be traced back to its owner; Core's rule is
//   presence, and only presence.
//
// THE KEYBOARD IS THE SAME RULE
//   The claim is what finally lets a widget on the grid HOLD FOCUS — and the
//   two key handlers were written when nothing inside `S.GridArea` ever could.
//   Both stood down only for `INPUT` / `TEXTAREA` / `isContentEditable`, so a
//   `<select>` or a `<button>` inside an on-grid form — the first `<select>`
//   and `<button>` ever to live in there — was not exempt from anything:
//   Delete with a form dropdown focused ran the grid's CLEAR CONTENTS over the
//   selected sheet cells, ArrowDown moved the cell cursor instead of changing
//   the dropdown's value, a printable key opened the CELL editor, and Enter
//   moved the active cell instead of pressing the button.
//
//   The answer is the ancestor walk, not a longer tag list. A tag list is a
//   census of the widget types that exist TODAY: `<select>` and `<button>`
//   were missing from it, and the next widget — a `<summary>`, a
//   `role="slider"` div, a custom element with a shadow root — would be missing
//   too, at the cost of another data-loss bug each time. The walk asks the
//   question the claim already answers ("is this inside something that took
//   the gesture") and needs no re-widening, ever. `isKeyClaimed` is that walk.
//
//   The tag list stays where it is, because the two rules answer different
//   questions and neither subsumes the other: an `<input>` in the SIDE PANEL,
//   in a task pane, in a dialog, carries no claim and never will, and it must
//   still keep its keystrokes. The claim covers what is stacked ON the grid.
//
// CORE'S THREE DOORS ARE NOT THE ONLY DOORS — SEE THE CENSUS
//   Core honours the claim at mousedown, double-click and its two key handlers.
//   That was believed to be the whole story twice, and both times a door turned
//   up in a layer nobody had enumerated. The third was `api/keybindings.ts`, a
//   CAPTURE-phase `window` keydown — the outermost position there is. It ran
//   before every door here and called preventDefault()+stopPropagation(), so
//   these predicates were never consulted: Delete with an on-grid form's
//   `<select>` focused executed `core.edit.clearContents` over the user's cells,
//   and Ctrl+V inside a claimed `<input>` pasted into the SHEET while cancelling
//   the native paste into the field.
//
//   `globalInputListeners.ts`, next to this file, is the enumeration: every
//   `window`/`document` key or pointer listener in the app, with a verdict and a
//   reason for each. Its test re-derives the list from the source tree and fails
//   when the two disagree, so a new door cannot be added without a row.
//   A NEW GLOBAL LISTENER ADDS A ROW.
//
//   A claim is not a blanket, either. `keybindings.ts` shows the shape: a claim
//   makes a keystroke NOT-grid-focused and editing-equivalent, which refuses
//   grid-scoped and editing-sensitive shortcuts — but Ctrl+S still saves, because
//   a user typing in an on-grid form still wants Save.
//
// A HIDDEN CLAIMANT HOLDS NOTHING
//   A claim ends when the ELEMENT goes, which is the whole reason it is an
//   attribute. But a surface that is merely HIDDEN keeps its element and
//   therefore keeps its attribute — the embedded form layer's `hideHost` sets
//   `display: none` on a card that scrolled out of the viewport or whose sheet
//   is not the active one, and those cards can outnumber the visible ones.
//   The pointer never noticed, because the browser does not hit-test a hidden
//   element, so a hidden claim was already unreachable there. The keyboard has
//   no such filter, so `findPointerClaim` applies it for both: a claim inside
//   anything hidden is no claim. Making the ONE rule mean one thing is the
//   point — the alternative is a claim that is dead to the mouse and alive to
//   the keyboard, which is exactly the kind of split that produced the two
//   defects above.

/**
 * The attribute an element sets on itself to say "a pointer press that lands on
 * me is mine, not the grid's". The value is the claimant's own label and is
 * never interpreted by Core.
 */
export const POINTER_CLAIM_ATTR = "data-pointer-claim";

const POINTER_CLAIM_SELECTOR = `[${POINTER_CLAIM_ATTR}]`;

/**
 * The secondary (right) button. A press with this button is NEVER claimed —
 * see `isPointerClaimed`.
 */
export const SECONDARY_MOUSE_BUTTON = 2;

/** The shape of a press this rule can be asked about (a React or native event). */
export interface ClaimablePointerEvent {
  target: EventTarget | null;
  button?: number;
}

/** The shape of a keystroke this rule can be asked about. Keys have no button. */
export interface ClaimableKeyEvent {
  target: EventTarget | null;
}

/**
 * Is this element — or anything it sits inside — hidden from the user?
 *
 * Deliberately NOT a geometry question, and deliberately not
 * `getBoundingClientRect`: two cheap reads over the declarations that actually
 * take an element out of the page.
 *
 * The ANCESTOR WALK is the one that carries the live case. `hideHost` writes
 * `style.display = "none"` inline on the card, and `display` does NOT inherit a
 * computed "none" down to descendants — a child of a `display: none` element
 * still computes its own `display` — so nothing but a walk can see that a
 * claimant is inside a hidden layer.
 *
 * `getComputedStyle` on the claimant itself is consulted first, where the
 * environment has a real one, because it is the only thing that sees a hide
 * driven by a CSS CLASS rather than by an inline style (and `visibility` does
 * inherit, so it catches that one from any depth). Neither source alone covers
 * both. A false "hidden" is the safe direction anyway: it hands the gesture back
 * to the grid, which is where every gesture used to go.
 */
function isHiddenFromUser(el: Element): boolean {
  if (typeof globalThis.getComputedStyle === "function") {
    try {
      const computed = globalThis.getComputedStyle(el);
      if (computed.display === "none" || computed.visibility === "hidden") return true;
    } catch {
      // A detached or exotic element: fall through to the inline walk.
    }
  }
  let node: Element | null = el;
  while (node) {
    if (node.hasAttribute("hidden")) return true;
    const style = (node as Partial<HTMLElement>).style;
    if (style) {
      if (style.display === "none") return true;
      if (style.visibility === "hidden" || style.visibility === "collapse") return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * The claiming element for this gesture, or null.
 *
 * Read from the TARGET's ancestors — the element the browser's own hit test
 * chose — never from geometry. That is the whole point: an element with
 * `pointer-events: none` is not a target, so a surface that has suspended its
 * claim (Design Mode) is invisible to this walk without any extra state.
 *
 * A claim that is HIDDEN is not a claim (see the header). Once the nearest
 * claim is hidden the walk stops rather than looking further up: hiding is
 * inherited, so every claim above a hidden one is hidden too.
 */
export function findPointerClaim(target: EventTarget | null): Element | null {
  if (target === null || typeof target !== "object") return null;
  const el = target as Partial<Element>;
  if (typeof el.closest !== "function") return null;
  const claim = (el as Element).closest(POINTER_CLAIM_SELECTOR);
  if (claim === null) return null;
  return isHiddenFromUser(claim) ? null : claim;
}

/**
 * True when this press belongs to a claimant rather than to the grid.
 *
 * RIGHT-CLICK IS NEVER CLAIMED, and that is load-bearing rather than tidy. An
 * object's own context menu is opened by its extension from a capture-phase
 * `contextmenu` listener that hit-tests by client point, and the orphaned
 * embedded form's documented remedy is "right-click the anchor cell and pick a
 * grid menu item" — both of which need the right-press to keep reaching the
 * paths that select the object and place the cell cursor. A claimant that could
 * take the secondary button could trap the user inside its own rectangle with
 * no way out; the LEFT button is the one it needs.
 */
export function isPointerClaimed(event: ClaimablePointerEvent): boolean {
  if (event.button === SECONDARY_MOUSE_BUTTON) return false;
  return findPointerClaim(event.target) !== null;
}

/**
 * True when this KEYSTROKE belongs to a claimant rather than to the grid.
 *
 * The same ancestor walk `isPointerClaimed` uses, and no button exemption:
 * there is no secondary key. The exemption exists for the pointer so a
 * claimant cannot trap the user inside its own rectangle with no way to open a
 * menu; the keyboard's escape hatch is Tab and Escape, which move focus OUT of
 * the claimant and so leave the claim by the front door rather than needing a
 * hole in it.
 *
 * EVERY key is withheld, not a chosen subset. That is what the tag-list guard
 * this sits beside already does for an `<input>`, and picking a subset would be
 * a second, differently-shaped rule about the same question: the grid cannot
 * know that Escape means "close the dropdown" here and "clear the clipboard"
 * there, and guessing wrong is either a stolen key or, as measured, a cleared
 * range of the user's cells.
 */
export function isKeyClaimed(event: ClaimableKeyEvent): boolean {
  return findPointerClaim(event.target) !== null;
}

/**
 * Claim every pointer press that lands on `el` (or on anything inside it).
 *
 * `owner` is a free-form label for the claimant — an instance id, a placement
 * id — recorded so a stray claim can be traced. Core never reads it.
 */
export function claimPointer(el: Element, owner: string): void {
  el.setAttribute(POINTER_CLAIM_ATTR, owner);
}

/** Give the pointer back to the grid. Idempotent. */
export function releasePointerClaim(el: Element): void {
  el.removeAttribute(POINTER_CLAIM_ATTR);
}

/** Whether this element itself carries a claim (not its ancestors). */
export function hasPointerClaim(el: Element): boolean {
  return el.hasAttribute(POINTER_CLAIM_ATTR);
}
