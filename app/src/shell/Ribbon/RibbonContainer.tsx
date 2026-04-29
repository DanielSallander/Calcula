//! FILENAME: app/src/shell/Ribbon/RibbonContainer.tsx
// PURPOSE: The ribbon container - renders tabs registered by add-ins
// CONTEXT: This is an empty ribbon shell that add-ins populate via ExtensionRegistry
// REFACTOR: Imports from api layer instead of core internals

import React, { useState, useEffect, useRef, useCallback } from "react";
import { ExtensionRegistry } from "../../api/extensions";
import type { RibbonTabDefinition, RibbonContext } from "../../api/extensions";
import { useGridState } from "../../api/state";
import { onAppEvent, AppEvents } from "../../api/events";

export function RibbonContainer(): React.ReactElement {
  const state = useGridState();
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<RibbonTabDefinition[]>([]);
  const [isMinimized, setIsMinimized] = useState(false);
  const prevTabIdsRef = useRef<Set<string>>(new Set());

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
      if (isMinimized) {
        if (activeTabId === tabId && tempExpanded) {
          // Clicking the same tab while expanded: collapse again
          setTempExpanded(false);
        } else {
          setActiveTabId(tabId);
          setTempExpanded(true);
        }
      } else {
        setActiveTabId(tabId);
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
      const prevIds = prevTabIdsRef.current;
      const newIds = new Set(registeredTabs.map((t) => t.id));

      // Detect newly added contextual tabs (e.g. Design tab when pivot selected)
      let newlyAddedTab: RibbonTabDefinition | undefined;
      if (prevIds.size > 0) {
        newlyAddedTab = registeredTabs.find((t) => !prevIds.has(t.id));
      }

      prevTabIdsRef.current = newIds;
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

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const groups = activeTabId
    ? ExtensionRegistry.getRibbonGroupsForTab(activeTabId)
    : [];

  return (
    <div
      style={{
        backgroundColor: "#f5f5f5",
        borderBottom: "1px solid #d0d0d0",
        position: "relative",
        zIndex: 10,
      }}
    >
      {/* Tab Headers - fixed height to prevent layout shift when contextual tabs appear */}
      <div
        style={{
          display: "flex",
          gap: "4px",
          padding: "0 8px",
          borderBottom: "1px solid #d0d0d0",
          height: "30px",
          alignItems: "flex-end",
          overflow: "hidden",
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTabId === tab.id;
          const accentColor = tab.color;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id)}
              style={{
                padding: "6px 16px",
                border: "none",
                backgroundColor: isActive ? "#fff" : "transparent",
                borderTopLeftRadius: "4px",
                borderTopRightRadius: "4px",
                cursor: "pointer",
                fontWeight: isActive ? 600 : 400,
                fontSize: "12px",
                color: accentColor
                  ? isActive ? accentColor : accentColor + "cc"
                  : "#333",
                fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
                borderBottom: isActive ? "1px solid #fff" : "none",
                borderTop: accentColor ? `3px solid ${accentColor}` : "none",
                marginBottom: "-1px",
              }}
            >
              {tab.label}
            </button>
          );
        })}

        {tabs.length === 0 && (
          <div
            style={{
              padding: "6px 16px",
              color: "#999",
              fontStyle: "italic",
              fontSize: "12px",
            }}
          >
            No tabs registered - add-ins disabled
          </div>
        )}
      </div>

      {/* Tab Content Area - fixed height to prevent grid jumping when tabs change */}
      {/* When minimized, only show if temporarily expanded (tab clicked) */}
      <div
        data-ribbon-content
        style={{
          height: isMinimized && !tempExpanded ? "0px" : "92px",
          padding: isMinimized && !tempExpanded ? "0 8px" : "6px 8px",
          backgroundColor: "#fff",
          display: isMinimized && !tempExpanded ? "none" : "flex",
          gap: "0",
          position: isMinimized && tempExpanded ? "absolute" : "relative",
          left: isMinimized && tempExpanded ? 0 : undefined,
          right: isMinimized && tempExpanded ? 0 : undefined,
          zIndex: isMinimized && tempExpanded ? 100 : undefined,
          boxShadow: isMinimized && tempExpanded ? "0 4px 12px rgba(0,0,0,0.15)" : undefined,
          borderBottom: isMinimized && tempExpanded ? "1px solid #d0d0d0" : undefined,
        }}
      >
        {groups.length > 0 ? (
          groups.map((group, idx) => (
            <div
              key={group.id}
              style={{
                display: "flex",
                flexDirection: "column",
                borderRight: idx < groups.length - 1 ? "1px solid #e5e5e5" : "none",
                paddingLeft: idx === 0 ? "4px" : "10px",
                paddingRight: "10px",
              }}
            >
              <div style={{ flex: 1 }}>
                <group.component context={context} />
              </div>
              <div
                style={{
                  fontSize: "10px",
                  color: "#999",
                  textAlign: "center",
                  marginTop: "2px",
                  textTransform: "uppercase" as const,
                  letterSpacing: "0.5px",
                  fontWeight: 400,
                }}
              >
                {group.label}
              </div>
            </div>
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
              color: "#999",
              fontStyle: "italic",
              fontSize: "12px",
            }}
          >
            Core mode - ribbon add-ins will appear here when enabled
          </div>
        )}
      </div>
    </div>
  );
}