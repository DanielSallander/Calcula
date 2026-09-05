//! FILENAME: app/extensions/_shared/components/useDragDrop.ts
// PURPOSE: Custom mouse-based drag and drop for Tauri WebView compatibility
// CONTEXT: HTML5 DnD doesn't work reliably in Tauri's WebView2
//
//          TWO CHANNELS, ONE GESTURE. The original channel carries a pivot
//          FIELD between the four named zones (`DropZoneType`), and its payload
//          and its zone ids are pivot vocabulary. The second channel
//          (`useDragPayload` / `useDropTarget`) carries anything, addressed by a
//          string id the caller invents — the form designer moves widgets with
//          it. They share the drag state, the floating preview and the two
//          document listeners on purpose: a second implementation of the
//          gesture would be a second place for "did the mouse leave the zone"
//          and "when is the preview removed" to be answered, and the listener
//          census (core/lib/globalInputListeners.ts) would grow a row for a
//          drag that behaves almost, but not quite, like this one.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragField, DropZoneType } from './types';

interface DragState {
  isDragging: boolean;
  dragData: DragField | null;
  dragElement: HTMLElement | null;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface DropZoneRef {
  zone: DropZoneType;
  element: HTMLElement;
  onDrop: (field: DragField, insertIndex?: number) => void;
  getInsertIndex?: (y: number) => number;
}

// Global drag state - shared across all components
let globalDragState: DragState = {
  isDragging: false,
  dragData: null,
  dragElement: null,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
};

/**
 * The second channel's payload: whatever the caller is dragging, tagged with
 * the id of the target family it belongs to. A target only ever sees a payload
 * whose `channel` is its own, so two unrelated draggable surfaces open at once
 * cannot drop into each other.
 */
export interface GenericDragPayload<T = unknown> {
  channel: string;
  value: T;
}

interface DropTargetRef {
  id: string;
  channel: string;
  element: HTMLElement;
  onDrop: (value: unknown, insertIndex?: number) => void;
  getInsertIndex?: (x: number, y: number) => number;
}

let dragPreview: HTMLElement | null = null;
const dropZoneRefs: Map<DropZoneType, DropZoneRef> = new Map();
const dropTargetRefs: Map<string, DropTargetRef> = new Map();
/** The generic drag in progress, or null. Never set at the same time as `dragData`. */
let genericDrag: GenericDragPayload | null = null;
const subscribers: Set<() => void> = new Set();

// Callback invoked when a field from a zone is dropped outside all drop zones
let dragOutRemovalCallback: ((field: DragField) => void) | null = null;

/**
 * Register a callback for drag-out removal.
 * When a field pill from a drop zone is dragged and released outside any zone,
 * this callback fires so the host can remove the field from the report.
 * Returns a cleanup function.
 */
export function registerDragOutRemoval(cb: (field: DragField) => void): () => void {
  dragOutRemovalCallback = cb;
  return () => {
    if (dragOutRemovalCallback === cb) {
      dragOutRemovalCallback = null;
    }
  };
}

function notifySubscribers() {
  subscribers.forEach((fn) => fn());
}

function createDragPreview(text: string): HTMLElement {
  const preview = document.createElement('div');
  preview.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 10000;
    padding: 4px 8px;
    background: #0078d4;
    color: white;
    border-radius: 4px;
    font-size: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    opacity: 0.9;
    white-space: nowrap;
  `;
  preview.textContent = text;
  document.body.appendChild(preview);
  return preview;
}

function updateDragPreview(x: number, y: number) {
  if (dragPreview) {
    dragPreview.style.left = `${x + 12}px`;
    dragPreview.style.top = `${y + 12}px`;
  }
}

function removeDragPreview() {
  if (dragPreview) {
    dragPreview.remove();
    dragPreview = null;
  }
}

function hitsElement(element: HTMLElement, x: number, y: number): boolean {
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function getDropZoneAtPoint(x: number, y: number): DropZoneRef | null {
  for (const [, ref] of dropZoneRefs) {
    if (hitsElement(ref.element, x, y)) return ref;
  }
  return null;
}

/** The innermost registered target of `channel` under the pointer, if any. */
function getDropTargetAtPoint(channel: string, x: number, y: number): DropTargetRef | null {
  let best: DropTargetRef | null = null;
  for (const [, ref] of dropTargetRefs) {
    if (ref.channel !== channel) continue;
    if (!hitsElement(ref.element, x, y)) continue;
    // Nested targets are legal (a container inside a canvas), and the one the
    // pointer is deepest inside is the one that should take the drop.
    if (best === null || best.element.contains(ref.element)) best = ref;
  }
  return best;
}

function handleGlobalMouseMove(e: MouseEvent) {
  if (!globalDragState.isDragging) return;

  globalDragState.currentX = e.clientX;
  globalDragState.currentY = e.clientY;

  updateDragPreview(e.clientX, e.clientY);

  // Update drop zone hover states
  const dropZone = getDropZoneAtPoint(e.clientX, e.clientY);
  dropZoneRefs.forEach((ref) => {
    if (ref === dropZone) {
      ref.element.classList.add('drag-over');
    } else {
      ref.element.classList.remove('drag-over');
    }
  });
  const dropTarget = genericDrag
    ? getDropTargetAtPoint(genericDrag.channel, e.clientX, e.clientY)
    : null;
  dropTargetRefs.forEach((ref) => {
    if (ref === dropTarget) {
      ref.element.classList.add('drag-over');
    } else {
      ref.element.classList.remove('drag-over');
    }
  });

  notifySubscribers();
}

function endDrag() {
  dropZoneRefs.forEach((ref) => ref.element.classList.remove('drag-over'));
  dropTargetRefs.forEach((ref) => ref.element.classList.remove('drag-over'));
  removeDragPreview();
  genericDrag = null;
  globalDragState = {
    isDragging: false,
    dragData: null,
    dragElement: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
  };
  notifySubscribers();
}

function handleGlobalMouseUp(e: MouseEvent) {
  // The generic channel first: it and the field channel are never both live,
  // and a generic drag carries no `dragData` for the field branch to read.
  if (globalDragState.isDragging && genericDrag) {
    const target = getDropTargetAtPoint(genericDrag.channel, e.clientX, e.clientY);
    const payload = genericDrag.value;
    // The drop runs AFTER the drag state is cleared, so a handler that
    // re-renders (every one of them does) never paints mid-drag chrome.
    endDrag();
    if (target) {
      const insertIndex = target.getInsertIndex?.(e.clientX, e.clientY);
      target.onDrop(payload, insertIndex);
    }
    return;
  }
  if (!globalDragState.isDragging || !globalDragState.dragData) {
    return;
  }

  const dropZone = getDropZoneAtPoint(e.clientX, e.clientY);

  if (dropZone) {
    // Calculate insert index if the drop zone supports it
    let insertIndex: number | undefined;
    if (dropZone.getInsertIndex) {
      insertIndex = dropZone.getInsertIndex(e.clientY);
    }
    dropZone.onDrop(globalDragState.dragData, insertIndex);
  } else if (
    dragOutRemovalCallback &&
    globalDragState.dragData.fromZone !== undefined &&
    globalDragState.dragData.fromIndex !== undefined
  ) {
    // Field was dragged out of a zone and released in empty space - remove it
    dragOutRemovalCallback(globalDragState.dragData);
  }

  // Clean up
  endDrag();
}

// Initialize global listeners once
let listenersInitialized = false;
function initGlobalListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;

  document.addEventListener('mousemove', handleGlobalMouseMove);
  document.addEventListener('mouseup', handleGlobalMouseUp);
}

/**
 * Hook for draggable items (fields in the list or in zones)
 */
export function useDraggable(dragData: DragField, displayName: string) {
  const [isDragging, setIsDragging] = useState(false);
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initGlobalListeners();

    const unsubscribe = () => {
      setIsDragging(globalDragState.isDragging && globalDragState.dragData === dragData);
    };
    subscribers.add(unsubscribe);
    return () => {
      subscribers.delete(unsubscribe);
    };
  }, [dragData]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Ignore if clicking on interactive elements
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'BUTTON') {
        return;
      }

      e.preventDefault();

      globalDragState = {
        isDragging: true,
        dragData,
        dragElement: elementRef.current,
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
      };

      dragPreview = createDragPreview(displayName);
      updateDragPreview(e.clientX, e.clientY);

      setIsDragging(true);
      notifySubscribers();
    },
    [dragData, displayName]
  );

  return {
    isDragging,
    dragHandleProps: {
      ref: elementRef,
      onMouseDown: handleMouseDown,
      style: { cursor: 'grab' } as React.CSSProperties,
    },
  };
}

/**
 * Hook for drop zones
 */
export function useDropZone(
  zone: DropZoneType,
  onDrop: (field: DragField, insertIndex?: number) => void,
  getInsertIndex?: (y: number) => number
) {
  const [isDragOver, setIsDragOver] = useState(false);
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initGlobalListeners();

    if (elementRef.current) {
      dropZoneRefs.set(zone, {
        zone,
        element: elementRef.current,
        onDrop,
        getInsertIndex,
      });
    }

    const unsubscribe = () => {
      if (!elementRef.current) return;
      const rect = elementRef.current.getBoundingClientRect();
      const isOver =
        globalDragState.isDragging &&
        globalDragState.currentX >= rect.left &&
        globalDragState.currentX <= rect.right &&
        globalDragState.currentY >= rect.top &&
        globalDragState.currentY <= rect.bottom;
      setIsDragOver(isOver);
    };
    subscribers.add(unsubscribe);

    return () => {
      dropZoneRefs.delete(zone);
      subscribers.delete(unsubscribe);
    };
  }, [zone, onDrop, getInsertIndex]);

  return {
    isDragOver,
    isGlobalDragging: globalDragState.isDragging,
    dropZoneProps: {
      ref: elementRef,
    },
  };
}

/**
 * Hook for a draggable that is NOT a pivot field: anything, on a named channel.
 *
 * The same press-and-move gesture, the same floating preview and the same
 * global listeners as `useDraggable` — only the payload differs. `channel`
 * partitions the drags: a target only receives payloads sent on its own.
 */
export function useDragPayload<T, E extends HTMLElement = HTMLDivElement>(
  channel: string,
  value: T,
  displayName: string
) {
  const [isDragging, setIsDragging] = useState(false);
  // The element type is a parameter because a draggable is often not a div —
  // a palette entry is a <button>, and a ref typed to HTMLDivElement is simply
  // not assignable to one.
  const elementRef = useRef<E>(null);
  // Read at mousedown rather than captured in the callback, so a value that
  // changes between renders (a widget's path after a reorder) is never stale.
  // Assigned in an effect, not during render: a ref written while rendering is
  // a value React may have to throw away.
  const latest = useRef<{ channel: string; value: T }>({ channel, value });
  useEffect(() => {
    latest.current = { channel, value };
  });
  // The payload this element actually started dragging, so "am I the one being
  // dragged" survives the caller re-rendering a fresh payload object.
  const started = useRef<unknown>(null);

  useEffect(() => {
    initGlobalListeners();
    const unsubscribe = () => {
      setIsDragging(globalDragState.isDragging && genericDrag?.value === started.current);
    };
    subscribers.add(unsubscribe);
    return () => {
      subscribers.delete(unsubscribe);
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only the controls a press MUST reach are exempt. A generic draggable is
      // often a button (a palette entry is one), so excluding BUTTON the way the
      // field channel does would make the palette undraggable; a caller with an
      // inner control that must not start a drag stops propagation on it.
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        return;
      }
      e.preventDefault();
      started.current = latest.current.value;
      genericDrag = { channel: latest.current.channel, value: latest.current.value };
      globalDragState = {
        isDragging: true,
        dragData: null,
        dragElement: elementRef.current,
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
      };
      dragPreview = createDragPreview(displayName);
      updateDragPreview(e.clientX, e.clientY);
      setIsDragging(true);
      notifySubscribers();
    },
    [displayName]
  );

  return {
    isDragging,
    dragHandleProps: {
      ref: elementRef,
      onMouseDown: handleMouseDown,
      style: { cursor: 'grab' } as React.CSSProperties,
    },
  };
}

/**
 * Hook for a drop target on a named channel.
 *
 * `id` must be unique among live targets (it is the registry key); `channel`
 * decides which drags it can receive. `getInsertIndex` is given the pointer
 * position so a list target can decide WHERE in itself the drop lands.
 */
export function useDropTarget<T>(
  id: string,
  channel: string,
  onDrop: (value: T, insertIndex?: number) => void,
  getInsertIndex?: (x: number, y: number) => number
) {
  const [isDragOver, setIsDragOver] = useState(false);
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initGlobalListeners();
    if (elementRef.current) {
      dropTargetRefs.set(id, {
        id,
        channel,
        element: elementRef.current,
        onDrop: onDrop as (value: unknown, insertIndex?: number) => void,
        getInsertIndex,
      });
    }
    const unsubscribe = () => {
      const element = elementRef.current;
      setIsDragOver(
        !!element &&
          genericDrag?.channel === channel &&
          globalDragState.isDragging &&
          hitsElement(element, globalDragState.currentX, globalDragState.currentY)
      );
    };
    subscribers.add(unsubscribe);
    return () => {
      dropTargetRefs.delete(id);
      subscribers.delete(unsubscribe);
    };
  }, [id, channel, onDrop, getInsertIndex]);

  return {
    isDragOver,
    dropTargetProps: {
      ref: elementRef,
    },
  };
}

/** The generic drag in progress on `channel`, or null. Re-renders on change. */
export function useDragPayloadState<T>(channel: string): T | null {
  const [payload, setPayload] = useState<T | null>(null);
  useEffect(() => {
    initGlobalListeners();
    const unsubscribe = () => {
      setPayload(genericDrag?.channel === channel ? (genericDrag.value as T) : null);
    };
    subscribers.add(unsubscribe);
    return () => {
      subscribers.delete(unsubscribe);
    };
  }, [channel]);
  return payload;
}

/**
 * Hook to check if any drag is in progress
 */
export function useDragState() {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    initGlobalListeners();

    const unsubscribe = () => {
      setIsDragging(globalDragState.isDragging);
    };
    subscribers.add(unsubscribe);
    return () => {
      subscribers.delete(unsubscribe);
    };
  }, []);

  return { isDragging, dragData: globalDragState.dragData };
}
