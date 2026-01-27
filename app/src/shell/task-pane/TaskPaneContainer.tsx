//! FILENAME: app/src/shell/task-pane/TaskPaneContainer.tsx
// PURPOSE: Main Task Pane container with resize, tabs, and content rendering
// CONTEXT: Renders the task pane sidebar with dynamic content from registered views

import React, { useCallback, useRef, useEffect, useState } from "react";
import { useTaskPaneStore } from "./useTaskPaneStore";
import { TaskPaneExtensions } from "../../core/extensions/taskPaneExtensions";
import { TaskPaneHeader } from "./TaskPaneHeader";
import * as S from "./TaskPane.styles";

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
  const handleViewUpdate = useCallback(() => {
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  }, []);

  // Handle close from within the view
  const handleViewClose = useCallback(() => {
    if (activeViewId) {
      useTaskPaneStore.getState().closePane(activeViewId);
    }
  }, [activeViewId]);

  const hasOpenPanes = openPanes.length > 0;

  // Debug logging
  console.log("[TaskPaneContainer] render:", {
    isOpen,
    hasOpenPanes,
    openPanes: openPanes.map((p) => p.viewId),
    activeViewId,
    activeViewDef: activeViewDef?.id ?? null,
  });

  return (
    <S.TaskPaneWrapper
      ref={containerRef}
      $width={width}
      $isOpen={isOpen && hasOpenPanes}
      $dockMode={dockMode}
    >
      {isOpen && hasOpenPanes && (
        <>
          <S.ResizeHandle onMouseDown={handleResizeStart} />

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
                <S.EmptyStateIcon>[?]</S.EmptyStateIcon>
                <S.EmptyStateText>No pane selected</S.EmptyStateText>
              </S.EmptyState>
            )}
          </S.Content>
        </>
      )}
    </S.TaskPaneWrapper>
  );
}