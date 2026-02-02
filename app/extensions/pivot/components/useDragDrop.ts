//! FILENAME: app/extensions/pivot/components/useDragDrop.ts
// PURPOSE: Custom mouse-based drag and drop for Tauri WebView compatibility
// CONTEXT: HTML5 DnD doesn't work reliably in Tauri's WebView2

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

let dragPreview: HTMLElement | null = null;
const dropZoneRefs: Map<DropZoneType, DropZoneRef> = new Map();
const subscribers: Set<() => void> = new Set();

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

function getDropZoneAtPoint(x: number, y: number): DropZoneRef | null {
  for (const [, ref] of dropZoneRefs) {
    const rect = ref.element.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return ref;
    }
  }
  return null;
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

  notifySubscribers();
}

function handleGlobalMouseUp(e: MouseEvent) {
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
  }

  // Clean up
  dropZoneRefs.forEach((ref) => {
    ref.element.classList.remove('drag-over');
  });

  removeDragPreview();

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
