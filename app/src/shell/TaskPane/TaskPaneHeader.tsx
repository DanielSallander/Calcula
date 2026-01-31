//! FILENAME: app/src/shell/task-pane/TaskPaneHeader.tsx
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
                  x
                </S.TabCloseButton>
              )}
            </S.Tab>
          );
        })}
      </S.TabStrip>

      <S.HeaderActions>
        <S.HeaderButton onClick={handleCloseAll} title="Close Task Pane">
          x
        </S.HeaderButton>
      </S.HeaderActions>
    </S.Header>
  );
}