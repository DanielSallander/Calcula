//! FILENAME: app/src/shell/TaskPane/TaskPaneHeader.tsx
// PURPOSE: Task Pane header with tabs and close button
// CONTEXT: Renders tab strip for switching between open panes

import React, { useCallback } from "react";
import { useTaskPaneStore } from "./useTaskPaneStore";
import { TaskPaneExtensions } from "../../api/ui";
import * as S from "./TaskPane.styles";

interface TaskPaneHeaderProps {
  onClose: () => void;
}

export function TaskPaneHeader({
  onClose,
}: TaskPaneHeaderProps): React.ReactElement {
  const { openPanes, activeViewId, setActiveView, closePane, markManuallyClosed } =
    useTaskPaneStore();

  const handleTabClick = useCallback(
    (viewId: string) => {
      setActiveView(viewId);
    },
    [setActiveView]
  );

  const handleTabClose = useCallback(
    (e: React.MouseEvent, viewId: string) => {
      e.stopPropagation();
      markManuallyClosed(viewId);
      closePane(viewId);
    },
    [closePane, markManuallyClosed]
  );

  const handleCloseAll = useCallback(() => {
    // Mark all open panes as manually closed
    openPanes.forEach((pane) => {
      markManuallyClosed(pane.viewId);
    });
    onClose();
  }, [openPanes, markManuallyClosed, onClose]);

  return (
    <S.Header>
      <S.TabStrip>
        {openPanes.map((pane) => {
          const viewDef = TaskPaneExtensions.getView(pane.viewId);
          if (!viewDef) return null;

          const isActive = pane.viewId === activeViewId;

          return (
            <S.Tab
              key={pane.viewId}
              $active={isActive}
              onClick={() => handleTabClick(pane.viewId)}
              title={viewDef.title}
            >
              {viewDef.icon && <S.TabIcon>{viewDef.icon}</S.TabIcon>}
              <span>{viewDef.title}</span>
              {viewDef.closable !== false && (
                <S.TabCloseButton
                  onClick={(e) => handleTabClose(e, pane.viewId)}
                  title="Close"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </S.TabCloseButton>
              )}
            </S.Tab>
          );
        })}
      </S.TabStrip>

      <S.HeaderActions>
        <S.HeaderButton onClick={handleCloseAll} title="Close Task Pane">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </S.HeaderButton>
      </S.HeaderActions>
    </S.Header>
  );
}