//! FILENAME: app/extensions/ScriptableObjects/components/CodeEditorDialog.tsx
// PURPOSE: Monaco-based code editor dialog for editing object scripts.
// CONTEXT: Opened when a user clicks "Edit Script" on any object or from the
//          Developer > Object Scripts menu. Provides IntelliSense, scaffold templates,
//          and a documentation sidebar.

import React, { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import {
  ObjectScriptManager,
  saveObjectScript,
  getScaffoldTemplate,
  getContextDocumentation,
  showToast,
} from "@api";
import type { ObjectScriptDefinition, ScriptableObjectType, ScriptAccessLevel } from "@api/scriptableObjects";

// ============================================================================
// Monaco Worker Setup
// ============================================================================

const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    if (prevGetWorker) {
      return prevGetWorker(_, label);
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

// Register object context type definitions for IntelliSense
(function registerObjectScriptTypes() {
  // We provide a simplified .d.ts for object script contexts
  const contextDts = `
declare interface BaseObjectContext {
  readonly objectType: string;
  readonly accessLevel: string;
  expose(name: string, handler: (...args: any[]) => any): () => void;
  log(...args: any[]): void;
  notify(message: string, type?: "info" | "success" | "warning" | "error"): void;
}

declare interface WorkbookContext extends BaseObjectContext {
  onOpen(handler: () => void): () => void;
  onBeforeSave(handler: () => void): () => void;
  onAfterSave(handler: () => void): () => void;
  onBeforeClose(handler: () => void): () => void;
  onSheetChange(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  onThemeChange(handler: () => void): () => void;
  readonly properties: {
    readonly title: string;
    readonly author: string;
    readonly sheetCount: number;
    getSheetNames(): string[];
  };
}

declare interface SheetContext extends BaseObjectContext {
  onActivate(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  onDeactivate(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  onSelectionChange(handler: (detail: { sheetIndex: number; row: number; col: number; endRow: number; endCol: number }) => void): () => void;
  onDataChange(handler: (detail: { sheetIndex: number; changes: Array<{ row: number; col: number; oldValue?: string; newValue: string }> }) => void): () => void;
  getCellValue(row: number, col: number, sheetIndex?: number): string;
  setCellValue(row: number, col: number, value: string, sheetIndex?: number): void;
}

declare interface CellContext extends BaseObjectContext {
  onEdit(handler: (detail: { row: number; col: number; sheetIndex: number; oldValue?: string; newValue: string; formula?: string | null }) => void): () => void;
  onSelect(handler: (detail: { row: number; col: number; sheetIndex: number }) => void): () => void;
  onEditStart(handler: (detail: { row: number; col: number; sheetIndex: number }) => void): () => void;
  onEditEnd(handler: (detail: { row: number; col: number; sheetIndex: number; committed: boolean }) => void): () => void;
  onRender(handler: (cell: { row: number; col: number; sheetIndex: number; value: string; formula?: string | null }) => { textColor?: string; backgroundColor?: string; bold?: boolean; italic?: boolean } | null): () => void;
}

declare interface RowContext extends BaseObjectContext {
  onInsert(handler: (detail: { sheetIndex: number; startRow: number; count: number }) => void): () => void;
  onDelete(handler: (detail: { sheetIndex: number; startRow: number; count: number }) => void): () => void;
  onResize(handler: (detail: { sheetIndex: number; row: number; height: number }) => void): () => void;
}

declare interface ColumnContext extends BaseObjectContext {
  onInsert(handler: (detail: { sheetIndex: number; startCol: number; count: number }) => void): () => void;
  onDelete(handler: (detail: { sheetIndex: number; startCol: number; count: number }) => void): () => void;
  onResize(handler: (detail: { sheetIndex: number; col: number; width: number }) => void): () => void;
}

declare interface SlicerContext extends BaseObjectContext {
  readonly instanceId: string;
  readonly name: string;
  onSelectionChange(handler: (detail: { selectedItems: string[] }) => void): () => void;
  onDataRefresh(handler: (detail: { items: string[] }) => void): () => void;
  onResize(handler: (detail: { x: number; y: number; width: number; height: number }) => void): () => void;
  getSelectedItems(): string[];
  setSelectedItems(items: string[]): void;
  clearSelection(): void;
  selectAll(): void;
  style: {
    itemRenderer(renderer: (item: { text: string; selected: boolean; hasData: boolean; index: number }, ctx: CanvasRenderingContext2D, bounds: { x: number; y: number; width: number; height: number }) => void): () => void;
    setProperty(name: string, value: string): void;
  };
  readonly properties: { readonly fieldName: string; readonly sourceType: string; readonly columns: number; };
}

declare interface ChartContext extends BaseObjectContext {
  readonly instanceId: string;
  onDataChange(handler: () => void): () => void;
  onClick(handler: (detail: { x: number; y: number }) => void): () => void;
  onResize(handler: (detail: { x: number; y: number; width: number; height: number }) => void): () => void;
  getSpec(): Record<string, unknown>;
  updateSpec(patch: Record<string, unknown>): void;
  style: { setProperty(name: string, value: string): void; };
}

declare interface PivotContext extends BaseObjectContext {
  readonly instanceId: string;
  onRefresh(handler: () => void): () => void;
  onLayoutChange(handler: (detail: { rows: string[]; columns: string[]; values: string[]; filters: string[] }) => void): () => void;
  onResize(handler: (detail: { x: number; y: number; width: number; height: number }) => void): () => void;
  getFields(): { rows: string[]; columns: string[]; values: string[]; filters: string[] };
  refresh(): void;
}
`;

  monaco.languages.typescript.javascriptDefaults.addExtraLib(
    contextDts,
    "objectContexts.d.ts",
  );

  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });

  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: true,
  });
})();

// ============================================================================
// Styles
// ============================================================================

const dialogStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "#FAFAFA",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderBottom: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
  flexShrink: 0,
};

const mainStyle: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const editorPaneStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const sidebarStyle: React.CSSProperties = {
  width: 220,
  borderLeft: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
  overflowY: "auto",
  padding: "8px 10px",
  fontSize: 11,
};

const sidebarHeaderStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  color: "#333",
  marginBottom: 6,
  marginTop: 10,
};

const sidebarItemStyle: React.CSSProperties = {
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 10,
  color: "#0066CC",
  marginBottom: 2,
  cursor: "pointer",
};

const sidebarDescStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#777",
  marginBottom: 6,
  marginLeft: 8,
};

const statusBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 12px",
  borderTop: "1px solid #E0E0E0",
  backgroundColor: "#F5F5F5",
  fontSize: 11,
  color: "#666",
  flexShrink: 0,
};

const btnStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  backgroundColor: "#FFF",
  cursor: "pointer",
};

const btnPrimaryStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: "#0078D4",
  color: "#FFF",
  borderColor: "#0078D4",
};

const selectStyle: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  backgroundColor: "#FFF",
};

// ============================================================================
// Component
// ============================================================================

interface CodeEditorDialogProps {
  data?: {
    scriptId?: string;
    objectType?: ScriptableObjectType;
    instanceId?: string | null;
  };
}

export default function CodeEditorDialog({ data }: CodeEditorDialogProps): React.ReactElement {
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);

  // Script list and current script
  const [scripts, setScripts] = useState<ObjectScriptDefinition[]>([]);
  const [activeScriptId, setActiveScriptId] = useState<string | null>(data?.scriptId ?? null);
  const [source, setSource] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);

  // Load scripts
  useEffect(() => {
    const allScripts = ObjectScriptManager.getAllScripts();
    setScripts(allScripts);

    if (data?.scriptId) {
      const script = allScripts.find((s) => s.id === data.scriptId);
      if (script) {
        setSource(script.source);
        setActiveScriptId(script.id);
      }
    } else if (allScripts.length > 0) {
      setSource(allScripts[0].source);
      setActiveScriptId(allScripts[0].id);
    }

    const unsub = ObjectScriptManager.onScriptChange(() => {
      setScripts(ObjectScriptManager.getAllScripts());
    });
    return unsub;
  }, [data?.scriptId]);

  const activeScript = scripts.find((s) => s.id === activeScriptId) ?? null;
  const docs = activeScript ? getContextDocumentation(activeScript.objectType) : [];

  // Switch active script
  const handleSelectScript = useCallback((scriptId: string) => {
    // Auto-save current
    if (isDirty && activeScript) {
      const updated = { ...activeScript, source };
      ObjectScriptManager.registerScript(updated);
      saveObjectScript(updated).catch(console.error);
    }

    const script = scripts.find((s) => s.id === scriptId);
    if (script) {
      setActiveScriptId(scriptId);
      setSource(script.source);
      setIsDirty(false);
    }
  }, [isDirty, activeScript, source, scripts]);

  // Save
  const handleSave = useCallback(async () => {
    if (!activeScript) return;
    const updated = { ...activeScript, source };
    ObjectScriptManager.registerScript(updated);

    // Remount script to apply changes
    if (ObjectScriptManager.isScriptMounted(updated.id)) {
      ObjectScriptManager.unmountScript(updated.id);
    }
    await ObjectScriptManager.mountScript(updated.id);

    try {
      await saveObjectScript(updated);
      setIsDirty(false);
      showToast("Script saved and applied.", { type: "success" });
    } catch (e) {
      showToast(`Failed to save: ${e}`, { type: "error" });
    }
  }, [activeScript, source]);

  // Toggle access level
  const handleToggleAccess = useCallback(() => {
    if (!activeScript) return;
    const newLevel: ScriptAccessLevel = activeScript.accessLevel === "restricted" ? "unlocked" : "restricted";
    const updated = { ...activeScript, accessLevel: newLevel };
    ObjectScriptManager.registerScript(updated);
    setScripts(ObjectScriptManager.getAllScripts());
    saveObjectScript(updated).catch(console.error);
  }, [activeScript]);

  // Add new primitive script
  const handleAddScript = useCallback((objectType: ScriptableObjectType) => {
    const existing = ObjectScriptManager.getScript(objectType, null);
    if (existing) {
      setActiveScriptId(existing.id);
      setSource(existing.source);
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
    setActiveScriptId(id);
    setSource(script.source);
    setIsDirty(false);
  }, []);

  // Monaco mount
  const handleMount: OnMount = useCallback((ed) => {
    editorRef.current = ed;
    ed.addAction({
      id: "objectScript.save",
      label: "Save Script",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => handleSave(),
    });
  }, [handleSave]);

  // Source change
  const handleChange = useCallback((val: string | undefined) => {
    if (val !== undefined) {
      setSource(val);
      setIsDirty(true);
    }
  }, []);

  // Insert method name into editor
  const handleInsertMethod = useCallback((methodName: string) => {
    if (editorRef.current) {
      const position = editorRef.current.getPosition();
      if (position) {
        editorRef.current.executeEdits("", [
          {
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            text: methodName,
          },
        ]);
        editorRef.current.focus();
      }
    }
  }, []);

  const primitiveTypes: ScriptableObjectType[] = ["workbook", "sheet", "cell", "row", "column"];

  return (
    <div style={dialogStyle}>
      {/* Toolbar */}
      <div style={toolbarStyle}>
        <select
          style={selectStyle}
          value={activeScriptId ?? ""}
          onChange={(e) => handleSelectScript(e.target.value)}
        >
          {scripts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.objectType}{s.instanceId ? ` #${s.instanceId.slice(0, 8)}` : ""})
            </option>
          ))}
        </select>

        {/* Add primitive script dropdown */}
        <select
          style={selectStyle}
          value=""
          onChange={(e) => {
            if (e.target.value) {
              handleAddScript(e.target.value as ScriptableObjectType);
              e.target.value = "";
            }
          }}
        >
          <option value="">+ Add Script...</option>
          {primitiveTypes.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>

        <div style={{ flex: 1 }} />

        {activeScript && (
          <button
            style={btnStyle}
            onClick={handleToggleAccess}
            title={`Access level: ${activeScript.accessLevel}. Click to toggle.`}
          >
            {activeScript.accessLevel === "restricted" ? "Restricted" : "Unlocked"}
          </button>
        )}

        <button
          style={btnStyle}
          onClick={() => setShowSidebar(!showSidebar)}
        >
          {showSidebar ? "Hide Docs" : "Show Docs"}
        </button>

        <button
          style={btnPrimaryStyle}
          onClick={handleSave}
          disabled={!isDirty}
        >
          Save & Apply
        </button>
      </div>

      {/* Main area: editor + sidebar */}
      <div style={mainStyle}>
        {/* Monaco Editor */}
        <div style={editorPaneStyle}>
          <Editor
            height="100%"
            language="javascript"
            theme="vs"
            value={source}
            onChange={handleChange}
            onMount={handleMount}
            options={{
              fontSize: 13,
              fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
              lineNumbers: "on",
              glyphMargin: false,
              folding: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: "on",
              quickSuggestions: true,
              suggestOnTriggerCharacters: true,
              parameterHints: { enabled: true },
              hover: { enabled: true },
              fixedOverflowWidgets: true,
              matchBrackets: "always",
            }}
          />
        </div>

        {/* Documentation sidebar */}
        {showSidebar && (
          <div style={sidebarStyle}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>
              API Reference
            </div>
            {activeScript && (
              <div style={{ fontSize: 10, color: "#999", marginBottom: 10 }}>
                {activeScript.objectType.charAt(0).toUpperCase() + activeScript.objectType.slice(1)}Context
              </div>
            )}
            {docs.map((cat) => (
              <div key={cat.category}>
                <div style={sidebarHeaderStyle}>{cat.category}</div>
                {cat.methods.map((m) => (
                  <div key={m.name}>
                    <div
                      style={sidebarItemStyle}
                      onClick={() => handleInsertMethod(m.name)}
                      title={`Click to insert "${m.name}" at cursor`}
                    >
                      {m.signature}
                    </div>
                    <div style={sidebarDescStyle}>{m.description}</div>
                  </div>
                ))}
              </div>
            ))}
            {docs.length === 0 && (
              <div style={{ color: "#999", fontSize: 11, fontStyle: "italic" }}>
                No script selected
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div style={statusBarStyle}>
        <span>
          {activeScript
            ? `${activeScript.objectType} | ${activeScript.accessLevel} mode`
            : "No script selected"
          }
        </span>
        <span>
          {isDirty ? "Modified" : "Saved"}
        </span>
      </div>
    </div>
  );
}
