//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/designerModel.ts
// PURPOSE: The visual designer's whole idea of a layout, as pure functions over
//          a `FormSpec`: how a widget is addressed, what a container's child
//          list is, and what insert / move / delete / set-a-key do to the tree.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          NOTHING HERE HOLDS STATE, and that is the point. ONE ARTIFACT
//          (app/src/api/scriptTranspile.ts's header) says the script IS the
//          layout: the designer's own memory between two edits is a SELECTION
//          and nothing else, because everything else is re-read from the source
//          the AST reader just parsed. So every operation is `spec in, spec
//          out` — no ids minted for the designer's convenience, no parallel
//          tree, nothing that could survive a hand edit in the code editor and
//          disagree with it.
//
//          A PATH, NOT AN ID. A widget is addressed by where it sits, because
//          that is the only handle the source gives: two textboxes with no
//          `name` are distinguishable only by position. A step carries the tabs
//          PAGE it descends through, so `[{index:1,page:0},{index:2}]` reads
//          "the third widget on the first page of the second widget". Every
//          operation returns the path the caller should now select, since a
//          move invalidates the one it was given.

import {
  FORM_CONTAINER_TYPE_SET,
  FORM_INPUT_TYPE_SET,
  type FormSpec,
  type FormWidget,
  type FormWidgetType,
} from "@api/scriptHost/scriptFormSpec";

// ============================================================================
// Addressing
// ============================================================================

/** One step down the tree: which entry, and (for a tabs widget) which page of it. */
export interface FormStep {
  index: number;
  /** The page of the widget AT this step whose children the next step indexes. */
  page?: number;
}

/**
 * Where a widget is. The empty path is the form itself; a path's last step
 * names the widget, and the `page` of that last step is only meaningful when
 * the path is being used as a CONTAINER address.
 */
export type FormPath = readonly FormStep[];

/** The form's own child list. */
export const ROOT_PATH: FormPath = [];

/** A stable string for a path — a React key, a `data-` attribute, a test hook. */
export function pathKey(path: FormPath): string {
  if (path.length === 0) return "root";
  return path.map((step) => (step.page === undefined ? `${step.index}` : `${step.index}p${step.page}`)).join(".");
}

export function samePath(a: FormPath, b: FormPath): boolean {
  return a.length === b.length && a.every((step, i) => step.index === b[i].index && step.page === b[i].page);
}

/** `a` addresses `b` or an ancestor of it. */
export function isPrefixPath(a: FormPath, b: FormPath): boolean {
  return a.length <= b.length && a.every((step, i) => step.index === b[i].index);
}

/** The container the widget at `path` sits in. */
export function containerPathOf(path: FormPath): FormPath {
  return path.slice(0, -1);
}

/** The widget's index within its container, or -1 for the form itself. */
export function indexOfPath(path: FormPath): number {
  return path.length === 0 ? -1 : path[path.length - 1].index;
}

/** The path of the `index`th child of the container at `container`. */
export function childPath(container: FormPath, index: number): FormPath {
  return [...container, { index }];
}

/**
 * The widget at `path`, addressed AS A CONTAINER — what `openContainer` holds
 * and what a drop destination is.
 *
 * The last step gains a `page`, because a tabs widget's children live on one of
 * its pages. Every reader here defaults an absent page to 0, so `{index:2}` and
 * `{index:2,page:0}` reach the same list — but `samePath` compares the `page`
 * too, and two spellings of one container would make "is this the container the
 * canvas has open?" answer no for the container the canvas has open. Opening a
 * group, dropping into its card and moving into it from the keyboard therefore
 * all mint the step HERE, in one place.
 */
export function containerAddressOf(path: FormPath, page = 0): FormPath {
  if (path.length === 0) return ROOT_PATH;
  return [...containerPathOf(path), { index: indexOfPath(path), page }];
}

// ============================================================================
// Reading the tree
// ============================================================================

/** True for a widget that can hold other widgets. */
export function isContainerType(type: string): type is FormWidgetType {
  return FORM_CONTAINER_TYPE_SET.has(type);
}

/** True for a widget whose value lands in the submitted result. */
export function isInputType(type: string): boolean {
  return FORM_INPUT_TYPE_SET.has(type);
}

/** The child list a container holds, or null when it holds none. */
export function childrenOf(widget: FormWidget, page = 0): FormWidget[] | null {
  if (widget.type === "tabs") return widget.pages[page]?.children ?? null;
  if (isContainerType(widget.type)) return (widget as unknown as { children: FormWidget[] }).children;
  return null;
}

/** How many pages a tabs widget declares; 0 for anything else. */
export function pageCountOf(widget: FormWidget): number {
  return widget.type === "tabs" ? widget.pages.length : 0;
}

/** The child list the container at `path` holds, or null when the path is dead. */
export function childListAt(spec: FormSpec, path: FormPath): FormWidget[] | null {
  let list: FormWidget[] = spec.children;
  for (const step of path) {
    const widget = list[step.index];
    if (!widget) return null;
    const next = childrenOf(widget, step.page ?? 0);
    if (!next) return null;
    list = next;
  }
  return list;
}

/** The widget at `path`, or null when nothing is there. */
export function widgetAt(spec: FormSpec, path: FormPath): FormWidget | null {
  if (path.length === 0) return null;
  const list = childListAt(spec, containerPathOf(path));
  return list?.[indexOfPath(path)] ?? null;
}

/** The container path a drop or an insert should use for the selection `path`. */
export function insertionContainerFor(spec: FormSpec, path: FormPath): FormPath {
  const widget = path.length === 0 ? null : widgetAt(spec, path);
  // A selected CONTAINER takes the insert itself; anything else inserts beside
  // itself, which is what "add below what I have selected" means.
  if (widget && childrenOf(widget, lastPage(path)) !== null) return path;
  return containerPathOf(path);
}

function lastPage(path: FormPath): number {
  return path.length === 0 ? 0 : path[path.length - 1].page ?? 0;
}

/** Every widget in the tree, outermost first, with its path. */
export function walkWidgets(spec: FormSpec): Array<{ widget: FormWidget; path: FormPath }> {
  const out: Array<{ widget: FormWidget; path: FormPath }> = [];
  const visit = (list: FormWidget[], container: FormPath): void => {
    list.forEach((widget, index) => {
      const path = childPath(container, index);
      out.push({ widget, path });
      if (widget.type === "tabs") {
        widget.pages.forEach((page, p) => {
          visit(page.children, [...container, { index, page: p }]);
        });
        return;
      }
      const children = childrenOf(widget);
      if (children) visit(children, [...container, { index }]);
    });
  };
  visit(spec.children, ROOT_PATH);
  return out;
}

// ============================================================================
// Writing the tree
// ============================================================================

/** A container with a replaced child list. Never mutates the widget given. */
function withChildren(widget: FormWidget, page: number, children: FormWidget[]): FormWidget {
  if (widget.type === "tabs") {
    return {
      ...widget,
      pages: widget.pages.map((entry, i) => (i === page ? { ...entry, children } : entry)),
    };
  }
  return { ...(widget as unknown as Record<string, unknown>), children } as unknown as FormWidget;
}

/**
 * Rebuild the spec with `fn` applied to the child list at `container`.
 *
 * Returns the SAME spec object when nothing changed, so a caller can compare by
 * identity to tell a no-op edit from a real one before it touches the file.
 */
export function updateChildList(
  spec: FormSpec,
  container: FormPath,
  fn: (list: FormWidget[]) => FormWidget[],
): FormSpec {
  const rebuild = (list: FormWidget[], depth: number): FormWidget[] => {
    if (depth === container.length) return fn(list);
    const step = container[depth];
    const target = list[step.index];
    if (!target) return list;
    const inner = childrenOf(target, step.page ?? 0);
    if (!inner) return list;
    const nextInner = rebuild(inner, depth + 1);
    if (nextInner === inner) return list;
    const next = list.slice();
    next[step.index] = withChildren(target, step.page ?? 0, nextInner);
    return next;
  };
  const children = rebuild(spec.children, 0);
  return children === spec.children ? spec : { ...spec, children };
}

/** Rebuild the spec with `fn` applied to the widget at `path`. */
export function updateWidget(
  spec: FormSpec,
  path: FormPath,
  fn: (widget: FormWidget) => FormWidget,
): FormSpec {
  if (path.length === 0) return spec;
  const index = indexOfPath(path);
  return updateChildList(spec, containerPathOf(path), (list) => {
    const target = list[index];
    if (!target) return list;
    const replaced = fn(target);
    if (replaced === target) return list;
    const next = list.slice();
    next[index] = replaced;
    return next;
  });
}

/** Insert `widget` into the container at `container`, at `index`. */
export function insertWidget(
  spec: FormSpec,
  container: FormPath,
  index: number,
  widget: FormWidget,
): { spec: FormSpec; path: FormPath } {
  const list = childListAt(spec, container);
  if (!list) return { spec, path: ROOT_PATH };
  const at = Math.max(0, Math.min(index, list.length));
  const next = updateChildList(spec, container, (current) => [
    ...current.slice(0, at),
    widget,
    ...current.slice(at),
  ]);
  return { spec: next, path: childPath(container, at) };
}

/**
 * Remove the widget at `path`.
 *
 * The path that comes back is what the caller should select instead: the widget
 * that slid into the deleted one's place, the one before it, or the container.
 */
export function removeWidget(spec: FormSpec, path: FormPath): { spec: FormSpec; path: FormPath } {
  if (path.length === 0) return { spec, path };
  const container = containerPathOf(path);
  const index = indexOfPath(path);
  const list = childListAt(spec, container);
  if (!list || !list[index]) return { spec, path };
  const next = updateChildList(spec, container, (current) => current.filter((_, i) => i !== index));
  const remaining = list.length - 1;
  if (remaining === 0) return { spec: next, path: container };
  return { spec: next, path: childPath(container, Math.min(index, remaining - 1)) };
}

/**
 * Move the widget at `from` into `container` at `index`.
 *
 * A move INTO the widget's own subtree is refused (the spec would lose the
 * whole branch), and so is a move that changes nothing.
 */
export function moveWidget(
  spec: FormSpec,
  from: FormPath,
  container: FormPath,
  index: number,
): { spec: FormSpec; path: FormPath } {
  const widget = widgetAt(spec, from);
  if (!widget) return { spec, path: from };
  // A container cannot be dropped inside itself, and neither can it be dropped
  // inside one of its own descendants: both would detach the branch entirely.
  if (isPrefixPath(from, container)) return { spec, path: from };

  const fromContainer = containerPathOf(from);
  const fromIndex = indexOfPath(from);
  const sameList = samePath(fromContainer, container);
  if (sameList && (index === fromIndex || index === fromIndex + 1)) return { spec, path: from };

  const removed = updateChildList(spec, fromContainer, (list) => list.filter((_, i) => i !== fromIndex));
  // The removal can shift the target container's own address: dropping the
  // first root widget into a group that sits after it leaves that group one
  // index lower than the path the caller measured before the removal.
  const target = adjustAfterRemoval(container, fromContainer, fromIndex);
  const list = childListAt(removed, target);
  if (!list) return { spec, path: from };
  const at = Math.max(0, Math.min(sameList && index > fromIndex ? index - 1 : index, list.length));
  const next = updateChildList(removed, target, (current) => [
    ...current.slice(0, at),
    widget,
    ...current.slice(at),
  ]);
  return { spec: next, path: childPath(target, at) };
}

/** A path re-measured after `removedIndex` left the list at `container`. */
function adjustAfterRemoval(path: FormPath, container: FormPath, removedIndex: number): FormPath {
  if (path.length <= container.length) return path;
  if (!samePath(path.slice(0, container.length), container)) return path;
  const step = path[container.length];
  if (step.index <= removedIndex) return path;
  const next = path.slice();
  next[container.length] = { ...step, index: step.index - 1 };
  return next;
}

/**
 * Set (or, with `undefined`, remove) one key on the widget at `path`.
 *
 * ONE KEY. Everything else on the widget is carried across by reference, which
 * is what makes "editing a property rewrites only that property" a fact about
 * the code rather than a claim about the emitter.
 */
export function setWidgetKey(
  spec: FormSpec,
  path: FormPath,
  key: string,
  value: unknown,
): FormSpec {
  return updateWidget(spec, path, (widget) => {
    const record = widget as unknown as Record<string, unknown>;
    if (value === undefined) {
      if (!(key in record)) return widget;
      const next = { ...record };
      delete next[key];
      return next as unknown as FormWidget;
    }
    if (record[key] === value) return widget;
    return { ...record, [key]: value } as unknown as FormWidget;
  });
}

/** Set (or remove) one form-level key. */
export function setSpecKey(spec: FormSpec, key: string, value: unknown): FormSpec {
  const record = spec as unknown as Record<string, unknown>;
  if (value === undefined) {
    if (!(key in record)) return spec;
    const next = { ...record };
    delete next[key];
    return next as unknown as FormSpec;
  }
  if (record[key] === value) return spec;
  return { ...record, [key]: value } as unknown as FormSpec;
}

// ============================================================================
// Naming
// ============================================================================

/**
 * A widget name nothing in this form is using yet.
 *
 * Names are unique across the WHOLE tree (`checkFormSpec` refuses a repeat), so
 * this walks every widget rather than the container being inserted into — a
 * "textbox2" free in this group but taken two groups over would make the write
 * refuse with a validator message the user never caused.
 */
export function uniqueWidgetName(spec: FormSpec, base: string): string {
  const taken = new Set<string>();
  for (const { widget } of walkWidgets(spec)) {
    if (widget.name) taken.add(widget.name);
  }
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}${Date.now()}`;
}

/** How a widget is labelled in the outline, the drag preview and the tests. */
export function describeWidget(widget: FormWidget): string {
  const named = widget.name ? ` "${widget.name}"` : "";
  const said =
    widget.type === "label" || widget.type === "button"
      ? (widget as { text: string }).text
      : widget.type === "group"
        ? (widget as { title?: string }).title
        : widget.label;
  return said ? `${widget.type}${named} — ${said}` : `${widget.type}${named}`;
}
