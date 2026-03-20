//! FILENAME: app/src/shell/ActivityBar/ActivityBar.tsx
// PURPOSE: Thin vertical icon strip on the left edge (VS Code-style Activity Bar)
// CONTEXT: Shell component that renders registered activity view icons

import React, { useCallback, useEffect, useState } from "react";
import { useActivityBarStore } from "./useActivityBarStore";
import { ActivityBarExtensions } from "../registries/activityBarExtensions";
import type { ActivityViewDefinition } from "../../api/uiTypes";

const ACTIVITY_BAR_WIDTH = 48;

/**
 * Activity Bar - the thin vertical icon strip on the left.
 * Icons are split into top (main) and bottom sections.
 * Clicking an icon toggles the side panel.
 */
export function ActivityBar(): React.ReactElement {
  const { isOpen, activeViewId, toggle } = useActivityBarStore();
  const [views, setViews] = useState<{
    top: ActivityViewDefinition[];
    bottom: ActivityViewDefinition[];
  }>({ top: [], bottom: [] });

  // Subscribe to registry changes
  useEffect(() => {
    const update = () => {
      setViews({
        top: ActivityBarExtensions.getTopViews(),
        bottom: ActivityBarExtensions.getBottomViews(),
      });
    };
    update();
    return ActivityBarExtensions.onRegistryChange(update);
  }, []);

  const handleIconClick = useCallback(
    (viewId: string) => {
      toggle(viewId);
    },
    [toggle]
  );

  return (
    <div style={styles.container}>
      {/* Top section */}
      <div style={styles.topSection}>
        {views.top.map((view) => (
          <ActivityBarIcon
            key={view.id}
            view={view}
            isActive={isOpen && activeViewId === view.id}
            onClick={handleIconClick}
          />
        ))}
      </div>

      {/* Bottom section */}
      <div style={styles.bottomSection}>
        {views.bottom.map((view) => (
          <ActivityBarIcon
            key={view.id}
            view={view}
            isActive={isOpen && activeViewId === view.id}
            onClick={handleIconClick}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Single icon button in the Activity Bar.
 */
function ActivityBarIcon({
  view,
  isActive,
  onClick,
}: {
  view: ActivityViewDefinition;
  isActive: boolean;
  onClick: (viewId: string) => void;
}): React.ReactElement {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <button
      style={{
        ...styles.iconButton,
        ...(isActive ? styles.iconButtonActive : {}),
        ...(isHovered && !isActive ? styles.iconButtonHover : {}),
      }}
      onClick={() => onClick(view.id)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={view.title}
      aria-label={view.title}
    >
      {/* Active indicator bar */}
      {isActive && <div style={styles.activeIndicator} />}

      {/* Icon */}
      <div style={{
        ...styles.iconWrapper,
        opacity: isActive ? 1 : isHovered ? 0.8 : 0.6,
      }}>
        {view.icon}
      </div>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: ACTIVITY_BAR_WIDTH,
    minWidth: ACTIVITY_BAR_WIDTH,
    height: "100%",
    backgroundColor: "#333333",
    flexShrink: 0,
  },
  topSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingTop: 4,
    flex: 1,
  },
  bottomSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingBottom: 4,
  },
  iconButton: {
    position: "relative" as const,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: ACTIVITY_BAR_WIDTH,
    height: ACTIVITY_BAR_WIDTH,
    padding: 0,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    color: "#ffffff",
  },
  iconButtonActive: {
    // Active state is indicated by the left bar, not background
  },
  iconButtonHover: {
    // Hover opacity is handled inline
  },
  activeIndicator: {
    position: "absolute" as const,
    left: 0,
    top: 8,
    bottom: 8,
    width: 2,
    backgroundColor: "#ffffff",
    borderRadius: "0 1px 1px 0",
  },
  iconWrapper: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    transition: "opacity 0.1s",
  },
};

export { ACTIVITY_BAR_WIDTH };
