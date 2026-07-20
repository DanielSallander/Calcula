//! FILENAME: app/src/shell/Ribbon/RibbonContainer.tsx
// PURPOSE: The ribbon container - renders tabs registered by add-ins
// CONTEXT: This is an empty ribbon shell that add-ins populate via ExtensionRegistry
// REFACTOR: Imports from api layer instead of core internals

import React, { useState, useEffect, useCallback } from "react";
import { ExtensionRegistry } from "../../api/extensions";
import type { RibbonTabDefinition, RibbonContext } from "../../api/extensions";
import { useGridState } from "../../api/state";
import { onAppEvent, emitAppEvent, AppEvents } from "../../api/events";
import { panelRegistry } from "../registries/panelRegistry";
import { PanelContextMenu } from "./PanelContextMenu";
import { SectionChrome } from "../components/SectionChrome";
import type { PanelPlacement } from "../../api/uiTypes";
import * as S from "./RibbonContainer.styles";

export function RibbonContainer(): React.ReactElement {
  const state = useGridState();
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<RibbonTabDefinition[]>([]);
  const [isMinimized, setIsMinimized] = useState(false);

  // Re-render when panel registry changes (badge updates, placement moves)
  const [, setPanelRegistryVersion] = useState(0);
  useEffect(() => {
    return panelRegistry.onRegistryChange(() => {
      setPanelRegistryVersion((v) => v + 1);
    });
  }, []);

  // Listen for Ctrl+F1 toggle ribbon minimize
  useEffect(() => {
    return onAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE, () => {
      setIsMinimized((prev) => !prev);
    });
  }, []);

  // When minimized, clicking a tab temporarily shows the content, then re-hides on blur
  const [tempExpanded, setTempExpanded] = useState(false);

  const handleTabClick = useCallback(
    (tabId: string) => {
      const prevTabId = activeTabId;

      if (isMinimized) {
        if (activeTabId === tabId && tempExpanded) {
          setTempExpanded(false);
        } else {
          setActiveTabId(tabId);
          setTempExpanded(true);
        }
      } else {
        setActiveTabId(tabId);
      }

      // Emit panel events for scriptable objects
      emitAppEvent("panel:clicked", { panelId: tabId, placement: "ribbon" });
      if (prevTabId !== tabId) {
        if (prevTabId) {
          emitAppEvent("panel:deactivated", { panelId: prevTabId, placement: "ribbon" });
        }
        emitAppEvent("panel:activated", { panelId: tabId, placement: "ribbon" });
      }
    },
    [isMinimized, activeTabId, tempExpanded]
  );

  // Close temp-expanded ribbon when clicking outside
  useEffect(() => {
    if (!tempExpanded) return;

    const handleClickOutside = (e: MouseEvent) => {
      // If clicking inside the ribbon content area, don't close (let buttons work)
      const target = e.target as HTMLElement;
      if (target.closest("[data-ribbon-content]")) return;
      setTempExpanded(false);
    };

    // Use a short delay so the current click doesn't immediately close it
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [tempExpanded]);

  // Subscribe to registry changes
  useEffect(() => {
    const updateTabs = () => {
      const registeredTabs = ExtensionRegistry.getRibbonTabs();
      setTabs(registeredTabs);

      setActiveTabId((current) => {
        // If no tabs, clear active
        if (registeredTabs.length === 0) return null;
        // If current tab still exists, keep it (don't auto-switch on new contextual tabs)
        if (current && registeredTabs.some((t) => t.id === current)) return current;
        // Current tab was removed (e.g. contextual tab hidden) — fall back to
        // the first non-contextual tab, or the first tab if all are contextual
        const fallback = registeredTabs.find((t) => !t.color) ?? registeredTabs[0];
        return fallback.id;
      });
    };

    updateTabs();
    return ExtensionRegistry.onRegistryChange(updateTabs);
  }, []);

  // Build context for ribbon components
  const context: RibbonContext = {
    selection: state.selection,
    // Fix: Derive disabled state from editing (isEditing property does not exist on GridState)
    isDisabled: state.editing !== null,
    executeCommand: async (commandId: string) => {
      const command = ExtensionRegistry.getCommand(commandId);
      if (command) {
        console.log(`[Ribbon] Executing command: ${commandId}`);
      }
    },
    refreshCells: async () => {
      console.log("[Ribbon] Refresh cells requested");
    },
  };

  // Panel context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    panelId: string;
    panelTitle: string;
  } | null>(null);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    const panel = panelRegistry.getPanelByDownstreamId(tabId);
    if (!panel || panel.movable === false) return;
    e.preventDefault();
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, panelId: panel.id, panelTitle: panel.title });
  }, []);

  const handlePanelMove = useCallback((placement: PanelPlacement) => {
    if (contextMenu) {
      panelRegistry.setPlacement(contextMenu.panelId, placement);
    }
  }, [contextMenu]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const groups = activeTabId
    ? ExtensionRegistry.getRibbonGroupsForTab(activeTabId)
    : [];

  return (
    <S.RibbonFrame>
      {/* Tab Headers - fixed height to prevent layout shift when contextual tabs appear */}
      <S.TabStrip>
        {tabs.map((tab) => {
          const isActive = activeTabId === tab.id;
          const badge = panelRegistry.getBadge(tab.id);
          return (
            <S.TabButton
              key={tab.id}
              type="button"
              $isActive={isActive}
              $accent={tab.color}
              onClick={() => handleTabClick(tab.id)}
              onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
            >
              {tab.label}
              {badge && <S.TabBadge>{badge}</S.TabBadge>}
            </S.TabButton>
          );
        })}

        {tabs.length === 0 && (
          <S.EmptyStripNote>No tabs registered - add-ins disabled</S.EmptyStripNote>
        )}
      </S.TabStrip>

      {/* Tab Content Area - fixed height to prevent grid jumping when tabs change */}
      {/* When minimized, only show if temporarily expanded (tab clicked) */}
      <div
        data-ribbon-content
        style={{
          height: isMinimized && !tempExpanded ? "0px" : "92px",
          padding: isMinimized && !tempExpanded ? "0 8px" : "6px 8px",
          backgroundColor: "var(--bg-surface)",
          display: isMinimized && !tempExpanded ? "none" : "flex",
          // Bound any tab content to the fixed-height band. A panel authored
          // for the sidebar (tall, vertical) that ends up projected here can
          // never fit 92px — clip it rather than let it spill over the grid.
          // (The primary defense is refusing such moves via supportedPlacements;
          // this is defense-in-depth for mis-declared / 3rd-party panels.)
          overflow: "hidden",
          gap: "0",
          position: isMinimized && tempExpanded ? "absolute" : "relative",
          left: isMinimized && tempExpanded ? 0 : undefined,
          right: isMinimized && tempExpanded ? 0 : undefined,
          zIndex: isMinimized && tempExpanded ? 100 : undefined,
          boxShadow: isMinimized && tempExpanded ? "0 6px 16px rgba(0,0,0,0.18)" : undefined,
          borderBottom: isMinimized && tempExpanded ? "1px solid var(--border-default)" : undefined,
        }}
      >
        {groups.length > 0 ? (
          groups.map((group, idx) => (
            <SectionChrome
              key={group.id}
              label={group.label}
              isFirst={idx === 0}
              isLast={idx === groups.length - 1}
            >
              <group.component context={context} />
            </SectionChrome>
          ))
        ) : activeTab ? (
          <activeTab.component context={context} />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              color: "var(--text-tertiary)",
              fontStyle: "italic",
              fontSize: "12px",
            }}
          >
            Core mode - ribbon add-ins will appear here when enabled
          </div>
        )}
      </div>

      {/* Panel context menu */}
      {contextMenu && (
        <PanelContextMenu
          position={contextMenu.position}
          currentPlacement="ribbon"
          panelId={contextMenu.panelId}
          panelTitle={contextMenu.panelTitle}
          canMoveToTarget={panelRegistry.canMoveTo(contextMenu.panelId, "sidebar")}
          moveHint={panelRegistry.getMoveHint(contextMenu.panelId, "sidebar")}
          onMove={handlePanelMove}
          onClose={() => setContextMenu(null)}
        />
      )}
    </S.RibbonFrame>
  );
}