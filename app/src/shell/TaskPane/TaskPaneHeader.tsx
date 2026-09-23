//! FILENAME: app/src/shell/TaskPane/TaskPaneHeader.tsx
// PURPOSE: Task Pane header: the open views and the close controls
// CONTEXT: Calcula Clusters redesign. One open view reads like the side panel —
//          its 16px icon and 12px/600 title in a 40px row. Several open views
//          switch through the @api SegmentedTabs pill (role="tablist", arrow
//          keys), with a small "Close <view>" button for the active one (the
//          per-view close the old hand-rolled tabs carried as an x inside each
//          tab). "Close Task Pane" is always the last control and keeps its
//          exact `title` — e2e/journeys/insight-overlays.spec.ts selects it by
//          `button[title="Close Task Pane"]`.

import React, { useCallback } from "react";
import { useTaskPaneStore } from "./useTaskPaneStore";
import { TaskPaneExtensions } from "../../api/ui";
import type { TaskPaneViewDefinition } from "../../api/uiTypes";
import { IconButton, SegmentedTabs } from "../../api/layout";
import { RibbonIcon } from "../../api/ribbonIcons";
import * as S from "./TaskPane.styles";

interface TaskPaneHeaderProps {
  onClose: () => void;
}

/** Glyph size in the 28px "Close Task Pane" button (the side panel's 18). */
const CLOSE_PANE_ICON_SIZE = 18;
/** Glyph size in the 24px per-view close button. */
const CLOSE_VIEW_ICON_SIZE = 14;

/**
 * The view's icon in the 16px slot, or null. Only a React element is an icon:
 * a few views still pass a bracketed text placeholder ("[BI]", "[F]") that
 * would overflow the slot and only repeat the title beside it.
 */
function viewIcon(def: TaskPaneViewDefinition): React.ReactElement | null {
  if (!React.isValidElement(def.icon)) return null;
  return <S.TabIcon aria-hidden>{def.icon}</S.TabIcon>;
}

export function TaskPaneHeader({
  onClose,
}: TaskPaneHeaderProps): React.ReactElement {
  const { openPanes, activeViewId, setActiveView, closePane, markManuallyClosed } =
    useTaskPaneStore();

  const handleTabChange = useCallback(
    (viewId: string) => {
      setActiveView(viewId);
    },
    [setActiveView]
  );

  const handleViewClose = useCallback(
    (viewId: string) => {
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

  // Only views that still resolve to a registered definition get a tab.
  const views = openPanes
    .map((pane) => ({ viewId: pane.viewId, def: TaskPaneExtensions.getView(pane.viewId) }))
    .filter((v): v is { viewId: string; def: TaskPaneViewDefinition } => v.def !== undefined);

  const selected = views.find((v) => v.viewId === activeViewId) ?? views[0];
  const single = views.length === 1 ? views[0] : null;

  return (
    <S.Header>
      {single ? (
        <>
          {viewIcon(single.def)}
          <S.HeaderTitle title={single.def.title}>{single.def.title}</S.HeaderTitle>
        </>
      ) : views.length > 1 ? (
        <S.TabsSlot>
          <SegmentedTabs
            ariaLabel="Open panes"
            value={selected ? selected.viewId : ""}
            onChange={handleTabChange}
            tabs={views.map((v) => ({
              id: v.viewId,
              label: v.def.title,
              icon: viewIcon(v.def) ?? undefined,
            }))}
          />
        </S.TabsSlot>
      ) : (
        <S.HeaderTitle />
      )}

      <S.HeaderActions>
        {views.length > 1 && selected && selected.def.closable !== false && (
          <>
            <IconButton
              size="sm"
              label={`Close ${selected.def.title}`}
              icon={<RibbonIcon.Close size={CLOSE_VIEW_ICON_SIZE} />}
              onClick={() => handleViewClose(selected.viewId)}
            />
            <S.HeaderDivider aria-hidden />
          </>
        )}
        <IconButton
          size="md"
          label="Close Task Pane"
          title="Close Task Pane"
          tooltip={false}
          icon={<RibbonIcon.Close size={CLOSE_PANE_ICON_SIZE} />}
          onClick={handleCloseAll}
        />
      </S.HeaderActions>
    </S.Header>
  );
}
