//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/DesignerCanvas.tsx
// PURPOSE: The form as it will look, with every widget in the open container
//          selectable, draggable and reorderable — and reorderable from the
//          keyboard too.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          IT PAINTS THROUGH THE SHARED TREE. Each card renders its widget with
//          `FormWidgetTree` (components/scriptForm/FormWidgetTree.tsx) — the
//          same module the modal dialog, the task pane and the on-grid form
//          paint with, and the one `scriptPaneSharedTree.test.ts` pins to a
//          single definition. A designer with a "preview renderer" of its own
//          would be a fourth painter of nineteen widget types, and the first
//          one to disagree with the other three about what the user's form
//          looks like would be the one nobody was testing.
//
//          ONE CONTAINER AT A TIME. A card shows its container's children
//          fully, but only the OPEN container's children are selectable —
//          entering a group is a deliberate step (Enter, or the card's "Open"),
//          and a breadcrumb walks back out. That is what makes selection
//          unambiguous without hit-testing the painted tree: the alternative,
//          overlaying invisible shims on top of real controls, guesses at
//          geometry the layout owns and gets it wrong the first time a widget
//          wraps.
//
//          THE PAINTED CONTROLS ARE INERT — `locked: true` on the render
//          context, and `pointerEvents: "none"` over the preview. A canvas the
//          user can type into is a canvas whose text goes nowhere.
//
//          TWO KINDS OF DROP TARGET, and the difference is the whole reason a
//          widget can change parents. The LIST takes a drop between two cards
//          and puts the widget in the open container; a container card's BODY
//          takes a drop and puts the widget inside THAT container. The shared
//          gesture already prefers the innermost registered target under the
//          pointer (`getDropTargetAtPoint`), so nesting them needs nothing from
//          this file but a second registration. With only the list registered —
//          which is how this shipped — every drop resolved to the open
//          container, so a drag could only ever start and end in the same list:
//          the designer reordered, and a widget aimed at a group landed beside
//          it with no refusal and no sign that a different edit had happened.

import React, { useCallback, useEffect, useMemo, useRef } from "react";

import { useDragPayload, useDropTarget, useDragPayloadState } from "../../../_shared/components/useDragDrop";
import type { FormSpec, FormWidget } from "@api/scriptHost/scriptFormSpec";

import { FormWidgetTree, type FormRenderContext } from "../scriptForm/FormWidgetTree";
import { DESIGNER_DRAG_CHANNEL, type DesignerDrag } from "./designerDrag";
import {
  childListAt,
  childrenOf,
  containerAddressOf,
  describeWidget,
  indexOfPath,
  pageCountOf,
  pathKey,
  samePath,
  widgetAt,
  type FormPath,
} from "./designerModel";
import * as S from "./designerStyles";

/** The width the canvas lays widgets out against, matching the real dialog. */
const DEFAULT_FORM_WIDTH = 460;

/**
 * The render context every card shares.
 *
 * Empty values, empty seeds, `locked` — the canvas shows STRUCTURE, and a
 * canvas that invented sample values would be showing a form nobody declared.
 * The three callbacks are required by the shared tree and deliberately do
 * nothing: `locked` already disables every control, and this is the second
 * fence around the same gap.
 */
function designerRenderContext(): FormRenderContext {
  return {
    showId: "form-designer",
    values: {},
    controls: {},
    seeds: {},
    errors: {},
    dirty: new Set<string>(),
    stale: new Set<string>(),
    autoFocusName: null,
    focusRequest: null,
    locked: true,
    onValueChange: () => {},
    onButton: () => {},
    onInteraction: () => {},
  };
}

/**
 * A container card's body as a place to drop INTO that container.
 *
 * The drop lands at the END of the container's children: only the open
 * container's children are painted as cards, so there is no inner geometry to
 * measure here and an invented index would be a guess. Landing last is the one
 * position the user can predict without seeing it.
 *
 * The destination is read through a ref at drop time rather than captured in
 * the callback, so a container whose address moved since the drag began (a code
 * tab edit, an earlier drop) is not written to at its old index — the same
 * reason `useDragPayload` reads its payload that way.
 */
function ContainerDropZone({
  address,
  childCount,
  onDropInto,
  children,
}: {
  address: FormPath;
  childCount: number;
  onDropInto: (drag: DesignerDrag, container: FormPath, index: number) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const latest = useRef({ address, childCount });
  useEffect(() => {
    latest.current = { address, childCount };
  });
  const handleDrop = useCallback(
    (drag: DesignerDrag) => {
      onDropInto(drag, latest.current.address, latest.current.childCount);
    },
    [onDropInto],
  );
  const { isDragOver, dropTargetProps } = useDropTarget<DesignerDrag>(
    `${DESIGNER_DRAG_CHANNEL}:${pathKey(address)}`,
    DESIGNER_DRAG_CHANNEL,
    handleDrop,
  );
  return (
    <div
      {...dropTargetProps}
      data-designer-container-drop={pathKey(address)}
      data-testid={`designer-container-drop-${pathKey(address)}`}
      data-drag-over={isDragOver ? "true" : "false"}
      style={S.containerDropZone(isDragOver)}
    >
      {children}
    </div>
  );
}

interface NodeCardProps {
  widget: FormWidget;
  path: FormPath;
  selected: boolean;
  width: number;
  ctx: FormRenderContext;
  onSelect: (path: FormPath) => void;
  onOpen: (path: FormPath) => void;
  onDropInto: (drag: DesignerDrag, container: FormPath, index: number) => void;
}

function NodeCard({
  widget,
  path,
  selected,
  width,
  ctx,
  onSelect,
  onOpen,
  onDropInto,
}: NodeCardProps): React.ReactElement {
  const drag: DesignerDrag = { kind: "move", path };
  const { isDragging, dragHandleProps } = useDragPayload(
    DESIGNER_DRAG_CHANNEL,
    drag,
    describeWidget(widget),
  );
  // Page 0, matching what "Open" descends into: a tabs widget's card shows its
  // first page, so that is the page a drop onto the card belongs to.
  const inner = childrenOf(widget);
  const container = inner !== null;
  const preview = (
    <div style={S.nodePreview} data-testid={`designer-preview-${pathKey(path)}`}>
      <FormWidgetTree widgets={[widget]} ctx={ctx} width={width} />
    </div>
  );
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      // The id is what `aria-activedescendant` on the listbox points at, so a
      // screen reader is told which option the selection moved to even in the
      // frame before DOM focus lands on it.
      id={`designer-node-${pathKey(path)}`}
      data-designer-node={pathKey(path)}
      data-testid={`designer-node-${pathKey(path)}`}
      data-widget-type={widget.type}
      // The drag handle calls `preventDefault` on mousedown (that is what stops
      // the browser selecting text mid-drag), which also cancels the focus the
      // press would otherwise have moved. Without this line the card is
      // selected but not focused, and the very next arrow key goes nowhere.
      onMouseDown={(e) => {
        onSelect(path);
        e.currentTarget.focus();
      }}
      onDoubleClick={container ? () => onOpen(path) : undefined}
      style={{ ...S.nodeCard(selected), opacity: isDragging ? 0.4 : 1 }}
    >
      <div
        {...dragHandleProps}
        data-testid={`designer-node-header-${pathKey(path)}`}
        style={S.nodeHeader}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {describeWidget(widget)}
        </span>
        {widget.hidden ? <span title="hidden: true — not painted when the form runs">hidden</span> : null}
        {container ? (
          <button
            type="button"
            className="ose-btn"
            data-testid={`designer-open-${pathKey(path)}`}
            // The header is the drag handle; a press on this button must open
            // the container, never begin dragging its card.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onOpen(path)}
            style={{ padding: "0 5px", fontSize: 10 }}
            title="Edit what is inside this container"
          >
            Open
          </button>
        ) : null}
      </div>
      {container ? (
        <ContainerDropZone
          address={containerAddressOf(path)}
          childCount={inner.length}
          onDropInto={onDropInto}
        >
          {preview}
        </ContainerDropZone>
      ) : (
        preview
      )}
    </div>
  );
}

export interface DesignerCanvasProps {
  spec: FormSpec;
  /** The container whose children are being edited; `[]` is the form itself. */
  openContainer: FormPath;
  selected: FormPath | null;
  onSelect: (path: FormPath) => void;
  onOpen: (path: FormPath) => void;
  /** Walk out one level, or switch the open tabs page. */
  onNavigate: (container: FormPath) => void;
  /** Put the dragged widget into `container` at `index`. */
  onDrop: (drag: DesignerDrag, container: FormPath, index: number) => void;
  onKeyCommand: (command: DesignerKeyCommand) => void;
}

export type DesignerKeyCommand =
  | { kind: "select"; delta: number }
  | { kind: "reorder"; delta: number }
  /** Move the selection into the container just above it. */
  | { kind: "indent" }
  /** Move the selection out of the open container, just after it. */
  | { kind: "outdent" }
  | { kind: "descend" }
  | { kind: "ascend" }
  | { kind: "delete" };

/**
 * The keyboard equivalent of every mouse gesture the canvas offers.
 *
 * Ctrl+Left / Ctrl+Right are the outliner pair, and they are here because the
 * mouse gained a gesture — dropping onto a container's body — that a keyboard
 * user would otherwise have no route to at all. A designer where one of the two
 * ways of moving a widget can change its parent and the other cannot is a
 * designer that is only finished for people who can drag.
 */
function keyCommandFor(e: React.KeyboardEvent): DesignerKeyCommand | null {
  if (e.key === "ArrowDown") return e.ctrlKey ? { kind: "reorder", delta: 1 } : { kind: "select", delta: 1 };
  if (e.key === "ArrowUp") return e.ctrlKey ? { kind: "reorder", delta: -1 } : { kind: "select", delta: -1 };
  if (e.key === "ArrowRight" && e.ctrlKey) return { kind: "indent" };
  if (e.key === "ArrowLeft" && e.ctrlKey) return { kind: "outdent" };
  if (e.key === "Enter") return { kind: "descend" };
  if (e.key === "Escape") return { kind: "ascend" };
  if (e.key === "Delete") return { kind: "delete" };
  return null;
}

export function DesignerCanvas({
  spec,
  openContainer,
  selected,
  onSelect,
  onOpen,
  onNavigate,
  onDrop,
  onKeyCommand,
}: DesignerCanvasProps): React.ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  const ctx = useMemo(() => designerRenderContext(), []);
  const width = Math.max(240, Math.min(spec.width ?? DEFAULT_FORM_WIDTH, 900));
  const children = childListAt(spec, openContainer) ?? [];
  const dragging = useDragPayloadState<DesignerDrag>(DESIGNER_DRAG_CHANNEL);

  /**
   * Where in the list a drop at this pointer position lands.
   *
   * Measured from the cards themselves rather than from an index the cards
   * report on hover: a hover index goes stale the moment the pointer is between
   * two cards, which is exactly where every drop happens.
   */
  const getInsertIndex = useCallback((_x: number, y: number): number => {
    const list = listRef.current;
    if (!list) return 0;
    const cards = Array.from(list.querySelectorAll<HTMLElement>("[data-designer-node]"));
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return i;
    }
    return cards.length;
  }, []);

  const handleDrop = useCallback(
    (drag: DesignerDrag, insertIndex?: number) => {
      onDrop(drag, openContainer, insertIndex ?? 0);
    },
    [onDrop, openContainer],
  );

  /** A drop onto a container card's body, which names its own destination. */
  const handleDropInto = useCallback(
    (drag: DesignerDrag, container: FormPath, index: number) => {
      onDrop(drag, container, index);
    },
    [onDrop],
  );

  const { isDragOver, dropTargetProps } = useDropTarget<DesignerDrag>(
    `${DESIGNER_DRAG_CHANNEL}:${pathKey(openContainer)}`,
    DESIGNER_DRAG_CHANNEL,
    handleDrop,
    getInsertIndex,
  );

  /**
   * Keep the focus on the selected card — but ONLY while the canvas already has
   * focus. Selection also moves when a property is edited or a widget is
   * dropped, and yanking focus out of the property panel every time a value
   * changed would make the panel impossible to type in.
   *
   * ASKED OF THE LISTBOX, not of the inner wrapper `listRef` points at. The
   * cards are tabbable only once something is selected, so the first Tab into
   * the canvas lands on the listbox itself — the wrapper's PARENT, which
   * `wrapper.contains(...)` reports as outside. Guarding on the wrapper
   * therefore returned early in exactly the case this effect exists for: after
   * ArrowDown the listbox dropped to `tabIndex={-1}` while still holding focus,
   * the selected card got `tabIndex={0}` and no focus, and a screen reader on
   * the listbox was told nothing at all. `Node.contains` is self-or-descendant,
   * so the one question covers both the keyboard entry and the mouse path.
   *
   * Found with `closest` rather than a second ref because the listbox already
   * carries the shared gesture's own `ref` and a hook's ref is not ours to
   * write into (`react-hooks/immutability` says so, and it is right).
   */
  const selectedKey = selected === null ? null : pathKey(selected);
  useEffect(() => {
    const list = listRef.current;
    const listbox = list?.closest<HTMLElement>('[role="listbox"]') ?? null;
    if (!listbox || !list || selectedKey === null) return;
    if (!listbox.contains(window.document.activeElement)) return;
    const card = list.querySelector<HTMLElement>(`[data-designer-node="${selectedKey}"]`);
    if (card && card !== window.document.activeElement) card.focus();
  }, [selectedKey]);

  const openWidget = openContainer.length > 0 ? widgetAt(spec, openContainer) : null;
  const pages = openWidget ? pageCountOf(openWidget) : 0;
  const openPage = openContainer.length > 0 ? openContainer[openContainer.length - 1].page ?? 0 : 0;

  return (
    <div style={S.canvasSurface} data-testid="designer-canvas">
      <Breadcrumb spec={spec} openContainer={openContainer} onNavigate={onNavigate} />
      {pages > 1 && openWidget ? (
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }} data-testid="designer-tab-pages">
          {Array.from({ length: pages }, (_unused, p) => (
            <button
              key={p}
              type="button"
              className="ose-btn"
              aria-pressed={p === openPage}
              data-testid={`designer-page-${p}`}
              onClick={() =>
                onNavigate([
                  ...openContainer.slice(0, -1),
                  { ...openContainer[openContainer.length - 1], page: p },
                ])
              }
              style={p === openPage ? { color: S.COLORS.accentText } : undefined}
            >
              {(openWidget as { pages: Array<{ title: string }> }).pages[p]?.title ?? `Page ${p + 1}`}
            </button>
          ))}
        </div>
      ) : null}
      <div
        {...dropTargetProps}
        role="listbox"
        aria-label="Form layout"
        aria-activedescendant={selectedKey === null ? undefined : `designer-node-${selectedKey}`}
        data-testid="designer-node-list"
        data-drag-over={isDragOver ? "true" : "false"}
        tabIndex={selected === null ? 0 : -1}
        onKeyDown={(e) => {
          const command = keyCommandFor(e);
          if (!command) return;
          e.preventDefault();
          onKeyCommand(command);
        }}
        style={{
          minHeight: 60,
          border: `1px dashed ${isDragOver ? S.COLORS.accentText : S.COLORS.panelBorder}`,
          borderRadius: 3,
          padding: 6,
        }}
      >
        <div ref={listRef}>
          {children.length === 0 ? (
            <div style={{ color: S.COLORS.faint, fontStyle: "italic", padding: 8 }}>
              {dragging
                ? "Drop the widget here"
                : "Nothing here yet — drag a widget in, or press one in the palette."}
            </div>
          ) : null}
          {children.map((widget, index) => {
            const path: FormPath = [...openContainer, { index }];
            return (
              <NodeCard
                key={pathKey(path)}
                widget={widget}
                path={path}
                selected={selected !== null && samePath(selected, path)}
                width={width}
                ctx={ctx}
                onSelect={onSelect}
                onOpen={onOpen}
                onDropInto={handleDropInto}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Breadcrumb({
  spec,
  openContainer,
  onNavigate,
}: {
  spec: FormSpec;
  openContainer: FormPath;
  onNavigate: (container: FormPath) => void;
}): React.ReactElement {
  const crumbs: Array<{ label: string; path: FormPath }> = [
    { label: spec.title ? `Form: ${spec.title}` : "Form", path: [] },
  ];
  for (let i = 0; i < openContainer.length; i++) {
    const path = openContainer.slice(0, i + 1);
    const widget = widgetAt(spec, path);
    crumbs.push({ label: widget ? describeWidget(widget) : `#${indexOfPath(path)}`, path });
  }
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8, flexWrap: "wrap" }}
      data-testid="designer-breadcrumb"
    >
      {crumbs.map((crumb, i) => (
        <React.Fragment key={pathKey(crumb.path)}>
          {i > 0 ? <span style={{ color: S.COLORS.faint }}>{"›"}</span> : null}
          <button
            type="button"
            className="ose-btn"
            data-testid={`designer-crumb-${pathKey(crumb.path)}`}
            onClick={() => onNavigate(crumb.path)}
            disabled={i === crumbs.length - 1}
            style={{ padding: "0 6px", fontSize: 10 }}
          >
            {crumb.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
