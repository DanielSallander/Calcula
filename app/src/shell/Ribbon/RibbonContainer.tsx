//! FILENAME: app/src/shell/Ribbon/RibbonContainer.tsx
// PURPOSE: The ribbon frame — the tab strip and the fixed-height content band
//          that hosts the active tab's clusters.
// CONTEXT: An empty shell that panels populate: every tab is a PanelDefinition
//          projected by the panel registry into ExtensionRegistry as a tab
//          whose component is the measured SectionRibbonRenderer. Legacy
//          ribbon groups are adopted into their panel as measured sections by
//          bootstrap.ts, so nothing renders in the band unmeasured.
//          The DOM contracts E2E tooling relies on are listed in
//          RibbonContainer.styles.ts.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { ExtensionRegistry } from "../../api/extensions";
import type { RibbonTabDefinition, RibbonContext } from "../../api/extensions";
import { useGridState } from "../../api/state";
import { onAppEvent, emitAppEvent, AppEvents } from "../../api/events";
import { panelRegistry } from "../registries/panelRegistry";
import { PanelContextMenu } from "./PanelContextMenu";
import type { PanelPlacement } from "../../api/uiTypes";
import {
  Badge,
  IconButton,
  LT,
  RIBBON_BAND_HEIGHT,
  RIBBON_BAND_PADDING_Y,
} from "../../api/layout";
import { RibbonIcon } from "../../api/ribbonIcons";
import * as S from "./RibbonContainer.styles";

/** Horizontal padding of the band. */
const BAND_PADDING_X = 8;
/** How long a docked band animates its height before it becomes display:none.
 *  Matches --motion-panel (180ms) with a little slack; the global
 *  reduced-motion rule collapses the transition itself, and the band is at
 *  height 0 for the remainder either way. */
const COLLAPSE_MS = 200;
/** Icon inside the strip's collapse control (the strip is 35px tall). */
const STRIP_ICON_SIZE = 16;

export function RibbonContainer(): React.ReactElement {
  const state = useGridState();
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<RibbonTabDefinition[]>([]);
  // Mirrors of the selection for the registry listener below. The next tab is
  // decided OUTSIDE the state updater: React StrictMode runs updaters twice, so
  // an updater that consumed "the tab to return to" would consume it on the
  // first run and fall back to Home on the second.
  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;
  // Tab ids present at the previous registry change: an activate-on-register
  // tab is selected only when it FIRST appears, never on every re-registration.
  const knownTabIdsRef = useRef<Set<string>>(new Set());
  // Where to go back to when an activate-on-register tab goes away.
  const returnTabRef = useRef<{ from: string; to: string | null } | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  // When minimized, clicking a tab temporarily shows the content, then re-hides on blur
  const [tempExpanded, setTempExpanded] = useState(false);

  // Re-render when panel registry changes (badge updates, placement moves)
  const [, setPanelRegistryVersion] = useState(0);
  useEffect(() => {
    return panelRegistry.onRegistryChange(() => {
      setPanelRegistryVersion((v) => v + 1);
    });
  }, []);

  // Ctrl+F1 and the strip's collapse control both toggle through the event.
  // A toggle always lands in a docked state: never re-minimize into a stale
  // temporary expansion.
  useEffect(() => {
    return onAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE, () => {
      setIsMinimized((prev) => !prev);
      setTempExpanded(false);
    });
  }, []);

  // ==========================================================================
  // Collapse animation. Minimizing a DOCKED band first animates its height to
  // 0 (so the grid slides up instead of jumping), then ends at display:none —
  // the computed display is the contract E2E checks. Derived during render
  // (not in an effect) so the DOM goes straight from 100px to the animating
  // 0px state; an effect would commit display:none first and kill the
  // transition.
  // ==========================================================================
  const [prevMinimized, setPrevMinimized] = useState(isMinimized);
  const [collapsing, setCollapsing] = useState(false);
  if (prevMinimized !== isMinimized) {
    setPrevMinimized(isMinimized);
    setCollapsing(isMinimized);
  }
  useEffect(() => {
    if (!collapsing) return;
    const id = setTimeout(() => setCollapsing(false), COLLAPSE_MS);
    return () => clearTimeout(id);
  }, [collapsing]);

  const handleTabClick = useCallback(
    (tabId: string) => {
      const prevTabId = activeTabId;

      if (isMinimized) {
        if (activeTabId === tabId && tempExpanded) {
          setTempExpanded(false);
        } else {
          setActiveTabId(tabId);
          setTempExpanded(true);
          setCollapsing(false);
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

      const known = knownTabIdsRef.current;
      knownTabIdsRef.current = new Set(registeredTabs.map((t) => t.id));
      const current = activeTabIdRef.current;
      const has = (id: string | null) => id !== null && registeredTabs.some((t) => t.id === id);

      let next: string | null;
      const appeared = registeredTabs.find((t) => t.activateOnRegister && !known.has(t.id));
      if (registeredTabs.length === 0) {
        // If no tabs, clear active
        next = null;
      } else if (appeared) {
        // A tab that owns a whole surface (the Canvas tab) is selected when it
        // appears; remember where the user was so leaving can go back there.
        if (current !== appeared.id) returnTabRef.current = { from: appeared.id, to: current };
        next = appeared.id;
      } else if (has(current)) {
        // Current tab still exists: keep it (don't auto-switch on new contextual tabs)
        next = current;
      } else {
        const back = returnTabRef.current;
        if (back && back.from === current && has(back.to)) {
          // The activate-on-register tab that took the selection went away:
          // return to the tab the user had before it, not to Home.
          next = back.to;
        } else {
          // Current tab was removed (e.g. contextual tab hidden) — fall back to
          // the first non-contextual tab, or the first tab if all are contextual
          const fallback = registeredTabs.find((t) => !t.color) ?? registeredTabs[0];
          next = fallback.id;
        }
      }
      if (returnTabRef.current && !has(returnTabRef.current.from)) {
        returnTabRef.current = null;
      }
      activeTabIdRef.current = next;
      setActiveTabId(next);
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

  const handleToggleMinimize = useCallback(() => {
    emitAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const overlay = isMinimized && tempExpanded;
  const hidden = isMinimized && !tempExpanded;

  return (
    <S.RibbonFrame data-testid="ribbon">
      {/* Tab Headers - fixed height to prevent layout shift when contextual tabs appear */}
      <S.TabStrip>
        {tabs.map((tab) => {
          const isActive = activeTabId === tab.id;
          const badge = panelRegistry.getBadge(tab.id);
          return (
            <S.TabSlot key={tab.id}>
              <S.TabButton
                type="button"
                $isActive={isActive}
                $accent={tab.color}
                onClick={() => handleTabClick(tab.id)}
                onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
              >
                {tab.label}
              </S.TabButton>
              {badge && (
                <Badge aria-hidden style={S.TAB_BADGE_STYLE} data-tab-badge={tab.id}>
                  {badge}
                </Badge>
              )}
            </S.TabSlot>
          );
        })}

        {/* Trailing non-tab control. No text content (aria-label only), so
            no probe that matches tabs by their text can mistake it for one. */}
        <S.StripSpacer />
        <IconButton
          label={isMinimized ? "Expand ribbon" : "Collapse ribbon"}
          shortcut="Ctrl+F1"
          icon={
            isMinimized ? (
              <RibbonIcon.ChevronDown size={STRIP_ICON_SIZE} />
            ) : (
              <RibbonIcon.ChevronUp size={STRIP_ICON_SIZE} />
            )
          }
          aria-expanded={!isMinimized}
          data-testid="ribbon-collapse-toggle"
          onClick={handleToggleMinimize}
        />
      </S.TabStrip>

      {/* Tab Content Area - fixed height to prevent grid jumping when tabs change */}
      {/* When minimized, only show if temporarily expanded (tab clicked) */}
      <div
        data-ribbon-content
        // A state marker that is true from the first frame of a minimize,
        // while the computed display only reaches "none" once the collapse
        // animation ends. Tooling that asks "is the ribbon minimized?" should
        // read this rather than race the animation.
        data-ribbon-minimized={isMinimized ? "" : undefined}
        style={{
          height: hidden ? 0 : RIBBON_BAND_HEIGHT,
          padding: hidden
            ? `0 ${BAND_PADDING_X}px`
            : `${RIBBON_BAND_PADDING_Y}px ${BAND_PADDING_X}px`,
          backgroundColor: LT.ribbonBand,
          display: hidden && !collapsing ? "none" : "flex",
          // Bound any tab content to the fixed-height band. A panel authored
          // for the sidebar (tall, vertical) that ends up projected here can
          // never fit the band — clip it rather than let it spill over the grid.
          // (The primary defense is the section renderer's launcher demotion;
          // this is defense-in-depth for mis-declared / 3rd-party panels.)
          overflow: "hidden",
          gap: "0",
          transition: `height ${LT.motionPanel}, padding ${LT.motionPanel}`,
          position: overlay ? "absolute" : "relative",
          left: overlay ? 0 : undefined,
          right: overlay ? 0 : undefined,
          zIndex: overlay ? 100 : undefined,
          boxShadow: overlay ? LT.shadowRaised : undefined,
          borderBottom: overlay ? `1px solid ${LT.border}` : undefined,
        }}
      >
        {activeTab ? (
          <S.BandContent key={activeTab.id}>
            <activeTab.component context={context} />
          </S.BandContent>
        ) : (
          <S.EmptyNote>
            No ribbon tabs are registered. Ribbon add-ins appear here when enabled.
          </S.EmptyNote>
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
