//! FILENAME: app/extensions/ScriptableObjects/components/ObjectScriptManagerPane.tsx
// PURPOSE: Task pane component for browsing and managing all object scripts.
// CONTEXT: Lists all registered object scripts grouped by type, with controls to
//          create, edit, delete, and toggle mount state.

import React, { useState, useEffect, useCallback } from "react";
import type { TaskPaneViewProps } from "@api";
import {
  ObjectScriptManager,
  deleteObjectScript,
  getScaffoldTemplate,
  saveObjectScript,
  showToast,
} from "@api";
import { emitAppEvent } from "@api/events";
import type { ObjectScriptDefinition, ScriptableObjectType } from "@api/scriptableObjects";
import { ScriptableObjectEvents } from "../index";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "#FAFAFA",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 10px",
  borderBottom: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
  flexShrink: 0,
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "4px 0",
};

const groupHeaderStyle: React.CSSProperties = {
  padding: "6px 12px 4px",
  fontSize: 10,
  fontWeight: 600,
  color: "#666",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 12px",
  cursor: "pointer",
  borderBottom: "1px solid #F0F0F0",
};

const itemHoverStyle: React.CSSProperties = {
  ...itemStyle,
  backgroundColor: "#F0F7FF",
};

const nameStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  color: "#333",
};

const tagStyle: React.CSSProperties = {
  fontSize: 9,
  padding: "1px 5px",
  borderRadius: 3,
  backgroundColor: "#E8E8E8",
  color: "#666",
};

const mountedTagStyle: React.CSSProperties = {
  ...tagStyle,
  backgroundColor: "#DFF6DD",
  color: "#107C10",
};

const btnSmallStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  border: "1px solid #CCC",
  borderRadius: 2,
  backgroundColor: "#FFF",
  cursor: "pointer",
};

const selectStyle: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  backgroundColor: "#FFF",
};

const emptyStyle: React.CSSProperties = {
  padding: "20px 12px",
  textAlign: "center",
  color: "#999",
  fontSize: 12,
};

// ============================================================================
// Component
// ============================================================================

export default function ObjectScriptManagerPane(_props: TaskPaneViewProps): React.ReactElement {
  const [scripts, setScripts] = useState<ObjectScriptDefinition[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Refresh script list
  const refresh = useCallback(() => {
    setScripts(ObjectScriptManager.getAllScripts());
  }, []);

  useEffect(() => {
    refresh();
    const unsub = ObjectScriptManager.onScriptChange(refresh);
    return unsub;
  }, [refresh]);

  // Group scripts by category
  const primitives = scripts.filter((s) => !s.instanceId);
  const components = scripts.filter((s) => !!s.instanceId);

  // Add a new primitive script
  const handleAdd = useCallback((objectType: ScriptableObjectType) => {
    const existing = ObjectScriptManager.getScript(objectType, null);
    if (existing) {
      emitAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, {
        objectType,
        instanceId: null,
      });
      return;
    }

    const id = crypto.randomUUID();
    const name = objectType.charAt(0).toUpperCase() + objectType.slice(1) + " Script";
    const script: ObjectScriptDefinition = {
      id,
      name,
      objectType,
      instanceId: null,
      source: getScaffoldTemplate(objectType),
      accessLevel: "restricted",
    };
    ObjectScriptManager.registerScript(script);
    saveObjectScript(script).catch(console.error);

    emitAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, {
      objectType,
      instanceId: null,
    });
  }, []);

  // Edit script
  const handleEdit = useCallback((script: ObjectScriptDefinition) => {
    emitAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, {
      objectType: script.objectType,
      instanceId: script.instanceId,
      objectName: script.name,
      scriptId: script.id,
    });
  }, []);

  // Delete script
  const handleDelete = useCallback(async (script: ObjectScriptDefinition) => {
    ObjectScriptManager.removeScript(script.id);
    try {
      await deleteObjectScript(script.id);
      showToast(`Deleted "${script.name}"`, { type: "info" });
    } catch (e) {
      console.error("[ScriptableObjects] Delete failed:", e);
    }
  }, []);

  // Toggle mount
  const handleToggleMount = useCallback(async (script: ObjectScriptDefinition) => {
    if (ObjectScriptManager.isScriptMounted(script.id)) {
      ObjectScriptManager.unmountScript(script.id);
      showToast(`Unmounted "${script.name}"`, { type: "info" });
    } else {
      await ObjectScriptManager.mountScript(script.id);
      showToast(`Mounted "${script.name}"`, { type: "success" });
    }
    refresh();
  }, [refresh]);

  const renderItem = (script: ObjectScriptDefinition) => {
    const isMounted = ObjectScriptManager.isScriptMounted(script.id);
    const isHovered = hoveredId === script.id;

    return (
      <div
        key={script.id}
        style={isHovered ? itemHoverStyle : itemStyle}
        onMouseEnter={() => setHoveredId(script.id)}
        onMouseLeave={() => setHoveredId(null)}
        onClick={() => handleEdit(script)}
      >
        <span style={nameStyle}>{script.name}</span>
        <span style={isMounted ? mountedTagStyle : tagStyle}>
          {isMounted ? "Active" : "Inactive"}
        </span>
        <span style={tagStyle}>{script.accessLevel}</span>
        {isHovered && (
          <>
            <button
              style={btnSmallStyle}
              onClick={(e) => {
                e.stopPropagation();
                handleToggleMount(script);
              }}
            >
              {isMounted ? "Stop" : "Start"}
            </button>
            <button
              style={{ ...btnSmallStyle, color: "#D13438" }}
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(script);
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
    );
  };

  const primitiveTypes: ScriptableObjectType[] = ["workbook", "sheet", "cell", "row", "column"];

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600 }}>Object Scripts</span>
        <select
          style={selectStyle}
          value=""
          onChange={(e) => {
            if (e.target.value) {
              handleAdd(e.target.value as ScriptableObjectType);
              e.target.value = "";
            }
          }}
        >
          <option value="">+ New...</option>
          {primitiveTypes.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div style={listStyle}>
        {scripts.length === 0 && (
          <div style={emptyStyle}>
            No object scripts yet. Use the dropdown above to add one,
            or right-click a slicer/chart to add a component script.
          </div>
        )}

        {primitives.length > 0 && (
          <>
            <div style={groupHeaderStyle}>Primitive Objects</div>
            {primitives.map(renderItem)}
          </>
        )}

        {components.length > 0 && (
          <>
            <div style={groupHeaderStyle}>Component Instances</div>
            {components.map(renderItem)}
          </>
        )}
      </div>
    </div>
  );
}
