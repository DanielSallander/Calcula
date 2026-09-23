//! FILENAME: app/src/api/layout/primitives/roving.ts
// PURPOSE: The keyboard-navigation arithmetic shared by the composite controls
//          of the Clusters grammar: SegmentedChoice, SegmentedTabs, Menu and
//          Dropdown.
// CONTEXT: Four controls move focus through a list of items with arrow keys,
//          Home/End and first-letter typeahead. Written four times, the four
//          copies would disagree on the details that users notice — whether a
//          disabled item is skipped, whether the end wraps to the start,
//          whether typeahead cycles through every "S" item or sticks on the
//          first. So the arithmetic lives here once, as pure functions over
//          index arrays, and each control only decides which keys it listens
//          to and whether its list wraps:
//
//            SegmentedChoice  all four arrows, wraps   (WAI-ARIA radio group)
//            SegmentedTabs    Left/Right, wraps        (WAI-ARIA tabs)
//            Menu             Up/Down, wraps           (WAI-ARIA menu)
//            Dropdown         Up/Down, stops at ends   (WAI-ARIA listbox)
//
//          Nothing here touches React or the DOM except focusWhenVisible, which
//          exists because of one specific timing problem described on it.

/** Where a navigation key moves focus. */
export type RovingMove = "next" | "prev" | "first" | "last";

/** Which arrow keys a control responds to. */
export type RovingAxis = "horizontal" | "vertical" | "both";

/**
 * The move a key makes on `axis`, or null when the key does not navigate.
 * Home/End work on every axis; the arrows only on the axis the control is
 * laid out along, so a vertical menu leaves Left/Right to the page.
 */
export function moveForKey(key: string, axis: RovingAxis): RovingMove | null {
  switch (key) {
    case "Home":
      return "first";
    case "End":
      return "last";
    case "ArrowRight":
      return axis === "vertical" ? null : "next";
    case "ArrowLeft":
      return axis === "vertical" ? null : "prev";
    case "ArrowDown":
      return axis === "horizontal" ? null : "next";
    case "ArrowUp":
      return axis === "horizontal" ? null : "prev";
    default:
      return null;
  }
}

/**
 * The index focus moves to from `current` (-1 = nothing focused yet),
 * skipping disabled items. With `wrap` the list is a ring; without it a move
 * past either end stays put. Returns -1 only when every item is disabled.
 */
export function stepIndex(
  move: RovingMove,
  current: number,
  disabled: readonly boolean[],
  wrap: boolean,
): number {
  const count = disabled.length;
  const first = disabled.findIndex((d) => !d);
  if (first < 0) return -1;
  let last = count - 1;
  while (last >= 0 && disabled[last]) last--;

  if (move === "first") return first;
  if (move === "last") return last;
  if (current < 0 || current >= count) return move === "next" ? first : last;

  const direction = move === "next" ? 1 : -1;
  let index = current;
  for (let step = 0; step < count; step++) {
    index += direction;
    if (index < 0 || index >= count) {
      if (!wrap) return current;
      index = (index + count) % count;
    }
    if (!disabled[index]) return index;
  }
  return current;
}

/** Whether a keydown is a printable character that should drive typeahead
 *  (Space is excluded: it activates the focused item). */
export function isTypeaheadKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    event.key.length === 1 &&
    event.key !== " " &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

/**
 * First-letter typeahead: the next enabled item AFTER `current` whose label
 * starts with `char` (case-insensitive), wrapping round. Pressing the same
 * letter again therefore cycles through every item that starts with it, the
 * way native menus and selects behave. Returns -1 when nothing matches.
 */
export function typeaheadIndex(
  char: string,
  current: number,
  labels: readonly string[],
  disabled: readonly boolean[],
): number {
  const needle = char.toLocaleLowerCase();
  const count = labels.length;
  for (let step = 1; step <= count; step++) {
    const index = (((current + step) % count) + count) % count;
    if (disabled[index]) continue;
    if (labels[index].trim().toLocaleLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/**
 * Focus an element inside a freshly opened Popover.
 *
 * WHY NOT A PLAIN focus(): Popover renders its content with
 * `visibility: hidden` for one pass, measures it, then re-renders it visible.
 * When the popover opens from a click, React flushes the new content's
 * effects synchronously at the end of that commit — BEFORE the re-render that
 * makes it visible — and Chromium refuses to focus a `visibility: hidden`
 * element, silently. jsdom does not model visibility, so a unit test cannot
 * see the failure; the symptom in the app is a menu that opens with focus
 * left on its trigger. The retry runs on the next animation frame, by which
 * point the synchronous re-render has made the content visible.
 */
export function focusWhenVisible(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus();
  if (document.activeElement === el) return;
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    if (el.isConnected) el.focus();
  });
}
