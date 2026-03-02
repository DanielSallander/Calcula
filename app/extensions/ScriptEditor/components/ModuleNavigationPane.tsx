//! FILENAME: app/extensions/ScriptEditor/components/ModuleNavigationPane.tsx
// PURPOSE: Left sidebar navigation pane for the Advanced Script Editor.
// CONTEXT: Displays a list of script modules with create/rename/delete support.
//          Uses the module Zustand store for state and Tauri commands for persistence.

import React, { useState, useRef, useCallback, useEffect } from "react";
import { useModuleStore } from "../lib/useModuleStore";
import { ModuleContextMenu } from "./ModuleContextMenu";

// ============================================================================
// Types
// ============================================================================

export interface ModuleNavigationPaneProps {
  /** Called when the user selects a different module. */
  onModuleSelect: (moduleId: string) => void;
  /** Called before switching away from a module (to auto-save). */
  onBeforeSwitch: () => Promise<void>;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  moduleId: string;
}

// ============================================================================
// Styles
// ============================================================================

const paneContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  backgroundColor: "#252526",
  borderRight: "1px solid #3C3C3C",
  userSelect: "none",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 10px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #3C3C3C",
  flexShrink: 0,
};

const headerTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#BBBBBB",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const addButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  border: "none",
  borderRadius: 3,
  backgroundColor: "transparent",
  color: "#BBBBBB",
  fontSize: 16,
  cursor: "pointer",
  lineHeight: 1,
};

const addButtonHoverStyle: React.CSSProperties = {
  ...addButtonStyle,
  backgroundColor: "#3C3C3C",
  color: "#FFFFFF",
};

const moduleListStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "4px 0",
};

const moduleItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "5px 10px",
  fontSize: 13,
  color: "#CCCCCC",
  cursor: "pointer",
  gap: 6,
};

const moduleItemActiveStyle: React.CSSProperties = {
  ...moduleItemStyle,
  backgroundColor: "#094771",
  color: "#FFFFFF",
};

const moduleItemHoverStyle: React.CSSProperties = {
  ...moduleItemStyle,
  backgroundColor: "#2A2D2E",
};

const moduleNameStyle: React.CSSProperties = {
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const dirtyDotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  backgroundColor: "#E8AB6E",
  flexShrink: 0,
};

const renameInputStyle: React.CSSProperties = {
  flex: 1,
  border: "1px solid #007ACC",
  borderRadius: 2,
  backgroundColor: "#1E1E1E",
  color: "#CCCCCC",
  fontSize: 13,
  padding: "1px 4px",
  outline: "none",
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
};

const moduleIconStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#6997D5",
  flexShrink: 0,
  width: 16,
  textAlign: "center",
};

const resizeHandleStyle: React.CSSProperties = {
  position: "absolute",
  right: 0,
  top: 0,
  bottom: 0,
  width: 4,
  cursor: "ew-resize",
  zIndex: 10,
};

const resizeHandleHoverStyle: React.CSSProperties = {
  ...resizeHandleStyle,
  backgroundColor: "#007ACC",
};

// ============================================================================
// ModuleItem Sub-Component
// ============================================================================

function ModuleItem({
  id,
  name,
  isActive,
  isDirty,
  isRenaming,
  renamingValue,
  onSelect,
  onContextMenu,
  onRenameChange,
  onRenameConfirm,
  onRenameCancel,
}: {
  id: string;
  name: string;
  isActive: boolean;
  isDirty: boolean;
  isRenaming: boolean;
  renamingValue: string;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRenameChange: (value: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
}): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const style = isActive
    ? moduleItemActiveStyle
    : hovered
      ? moduleItemHoverStyle
      : moduleItemStyle;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      onRenameConfirm();
    } else if (e.key === "Escape") {
      onRenameCancel();
    }
  };

  return React.createElement(
    "div",
    {
      style,
      onClick: isRenaming ? undefined : onSelect,
      onContextMenu,
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onDoubleClick: (e: React.MouseEvent) => {
        e.preventDefault();
        // Trigger rename mode — handled by parent
      },
      title: name,
    },
    // Module icon (JS file icon)
    React.createElement("span", { style: moduleIconStyle }, "JS"),

    // Module name or rename input
    isRenaming
      ? React.createElement("input", {
          ref: inputRef,
          style: renameInputStyle,
          value: renamingValue,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
            onRenameChange(e.target.value),
          onKeyDown: handleKeyDown,
          onBlur: onRenameConfirm,
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
        })
      : React.createElement("span", { style: moduleNameStyle }, name),

    // Dirty indicator
    isDirty ? React.createElement("span", { style: dirtyDotStyle }) : null,
  );
}

// ============================================================================
// ModuleNavigationPane Component
// ============================================================================

export function ModuleNavigationPane({
  onModuleSelect,
  onBeforeSwitch,
}: ModuleNavigationPaneProps): React.ReactElement {
  const {
    modules,
    activeModuleId,
    dirtyModuleIds,
    createModule,
    selectModule,
    removeModule,
    renameModule,
    duplicateModule,
  } = useModuleStore();

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    moduleId: "",
  });

  const [renamingModuleId, setRenamingModuleId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState("");
  const [addButtonHovered, setAddButtonHovered] = useState(false);
  const [resizeHovered, setResizeHovered] = useState(false);
  const [width, setWidth] = useState(200);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // ---- Resize logic ----
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;

      const handleResizeMove = (me: MouseEvent): void => {
        if (!isDragging.current) return;
        const delta = me.clientX - startX.current;
        const newWidth = Math.max(140, Math.min(400, startWidth.current + delta));
        setWidth(newWidth);
      };

      const handleResizeEnd = (): void => {
        isDragging.current = false;
        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
      };

      document.addEventListener("mousemove", handleResizeMove);
      document.addEventListener("mouseup", handleResizeEnd);
    },
    [width],
  );

  // ---- Module selection ----
  const handleSelect = useCallback(
    async (id: string) => {
      if (id === activeModuleId) return;
      await onBeforeSwitch();
      selectModule(id);
      onModuleSelect(id);
    },
    [activeModuleId, onBeforeSwitch, selectModule, onModuleSelect],
  );

  // ---- Create module ----
  const handleCreate = useCallback(async () => {
    await onBeforeSwitch();
    const newId = await createModule();
    onModuleSelect(newId);
  }, [onBeforeSwitch, createModule, onModuleSelect]);

  // ---- Context menu ----
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, moduleId: string) => {
      e.preventDefault();
      setContextMenu({
        visible: true,
        x: e.clientX,
        y: e.clientY,
        moduleId,
      });
    },
    [],
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  // ---- Rename ----
  const handleStartRename = useCallback(
    (moduleId: string) => {
      const mod = modules.find((m) => m.id === moduleId);
      if (mod) {
        setRenamingModuleId(moduleId);
        setRenamingValue(mod.name);
      }
    },
    [modules],
  );

  const handleRenameConfirm = useCallback(async () => {
    if (renamingModuleId && renamingValue.trim()) {
      await renameModule(renamingModuleId, renamingValue.trim());
    }
    setRenamingModuleId(null);
    setRenamingValue("");
  }, [renamingModuleId, renamingValue, renameModule]);

  const handleRenameCancel = useCallback(() => {
    setRenamingModuleId(null);
    setRenamingValue("");
  }, []);

  // ---- Delete ----
  const handleDelete = useCallback(
    async (moduleId: string) => {
      const deleted = await removeModule(moduleId);
      if (deleted) {
        // If the deleted module was active, the store will auto-select another.
        // We need to notify the editor to load the new active module.
        const { activeModuleId: newActive } = useModuleStore.getState();
        if (newActive) {
          onModuleSelect(newActive);
        }
      }
    },
    [removeModule, onModuleSelect],
  );

  // ---- Duplicate ----
  const handleDuplicate = useCallback(
    async (moduleId: string) => {
      const newId = await duplicateModule(moduleId);
      onModuleSelect(newId);
    },
    [duplicateModule, onModuleSelect],
  );

  // ---- Render ----
  return React.createElement(
    "div",
    {
      ref: containerRef,
      style: { ...paneContainerStyle, width, position: "relative", flexShrink: 0 },
    },

    // Header
    React.createElement(
      "div",
      { style: headerStyle },
      React.createElement("span", { style: headerTitleStyle }, "Modules"),
      React.createElement(
        "button",
        {
          style: addButtonHovered ? addButtonHoverStyle : addButtonStyle,
          onClick: handleCreate,
          onMouseEnter: () => setAddButtonHovered(true),
          onMouseLeave: () => setAddButtonHovered(false),
          title: "New Module",
        },
        "+",
      ),
    ),

    // Module list
    React.createElement(
      "div",
      { style: moduleListStyle },
      modules.map((mod) =>
        React.createElement(ModuleItem, {
          key: mod.id,
          id: mod.id,
          name: mod.name,
          isActive: mod.id === activeModuleId,
          isDirty: dirtyModuleIds.includes(mod.id),
          isRenaming: renamingModuleId === mod.id,
          renamingValue: renamingModuleId === mod.id ? renamingValue : "",
          onSelect: () => handleSelect(mod.id),
          onContextMenu: (e: React.MouseEvent) => handleContextMenu(e, mod.id),
          onRenameChange: setRenamingValue,
          onRenameConfirm: handleRenameConfirm,
          onRenameCancel: handleRenameCancel,
        }),
      ),
    ),

    // Resize handle
    React.createElement("div", {
      style: resizeHovered ? resizeHandleHoverStyle : resizeHandleStyle,
      onMouseDown: handleResizeStart,
      onMouseEnter: () => setResizeHovered(true),
      onMouseLeave: () => setResizeHovered(false),
    }),

    // Context menu
    contextMenu.visible
      ? React.createElement(ModuleContextMenu, {
          x: contextMenu.x,
          y: contextMenu.y,
          moduleId: contextMenu.moduleId,
          isLastModule: modules.length <= 1,
          onRename: () => handleStartRename(contextMenu.moduleId),
          onDuplicate: () => handleDuplicate(contextMenu.moduleId),
          onDelete: () => handleDelete(contextMenu.moduleId),
          onClose: handleCloseContextMenu,
        })
      : null,
  );
}
