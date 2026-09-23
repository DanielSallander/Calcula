//! FILENAME: app/src/shell/TaskPane/TaskPaneContainer.tsx
// PURPOSE: Main Task Pane container with resize, tabs, and content rendering
// CONTEXT: Renders the task pane sidebar with dynamic content from registered views.
//          Chrome is tokens only (TaskPane.styles.ts): a --shadow-raised frame,
//          the shared 40px header, a 2px --state-accent resize line, and the
//          RibbonIcon.Panel empty state.

import React, { useCallback, useRef, useEffect, useState } from "react";
import { useTaskPaneStore } from "./useTaskPaneStore";
import { TaskPaneExtensions } from "../../api/ui";
import { RibbonIcon } from "../../api/ribbonIcons";
import { TaskPaneHeader } from "./TaskPaneHeader";
import * as S from "./TaskPane.styles";

/** The empty state's pane glyph. */
const EMPTY_STATE_ICON_SIZE = 40;

export function TaskPaneContainer(): React.ReactElement {
  const {
    isOpen,
    width,
    dockMode,
    openPanes,
    activeViewId,
    setWidth,
    close,
  } = useTaskPaneStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const hasOpenPanes = openPanes.length > 0;
  const shouldBeVisible = isOpen && hasOpenPanes;

  // Handle resize drag
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
    },
    [width]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Resize from left edge: moving left increases width
      const deltaX = startXRef.current - e.clientX;
      const newWidth = startWidthRef.current + deltaX;
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, setWidth]);

  // Prevent text selection during resize
  useEffect(() => {
    if (isResizing) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ew-resize";
    } else {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
  }, [isResizing]);

  // Get the active pane instance and its view definition
  const activePaneInstance = openPanes.find((p) => p.viewId === activeViewId);
  const activeViewDef = activeViewId
    ? TaskPaneExtensions.getView(activeViewId)
    : null;

  // Handle view updates (e.g., pivot fields changed)
  // Dispatch pivot:refresh so the pivot extension re-fetches view data AND repaints.
  // (grid:refresh alone would fetch data with triggerRepaint=false, missing the repaint.)
  const handleViewUpdate = useCallback(() => {
    window.dispatchEvent(new CustomEvent("pivot:refresh"));
  }, []);

  // Handle close from within the view
  const handleViewClose = useCallback(() => {
    if (activeViewId) {
      useTaskPaneStore.getState().closePane(activeViewId);
    }
  }, [activeViewId]);

  return (
    <S.TaskPaneWrapper
      ref={containerRef}
      $width={width}
      $isOpen={shouldBeVisible}
      $dockMode={dockMode}
    >
      <S.TaskPaneContent $isVisible={shouldBeVisible}>
        <S.ResizeHandle
          data-resizing={isResizing ? "true" : undefined}
          onMouseDown={handleResizeStart}
        />

        <TaskPaneHeader onClose={close} />

        <S.Content>
          {activeViewDef && activePaneInstance ? (
            <activeViewDef.component
              onClose={handleViewClose}
              onUpdate={handleViewUpdate}
              data={activePaneInstance.data}
            />
          ) : (
            <S.EmptyState>
              <S.EmptyStateIcon aria-hidden>
                <RibbonIcon.Panel size={EMPTY_STATE_ICON_SIZE} />
              </S.EmptyStateIcon>
              <S.EmptyStateText>No pane selected</S.EmptyStateText>
            </S.EmptyState>
          )}
        </S.Content>
      </S.TaskPaneContent>
    </S.TaskPaneWrapper>
  );
}