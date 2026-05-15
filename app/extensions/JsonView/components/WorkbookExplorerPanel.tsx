//! FILENAME: app/extensions/JsonView/components/WorkbookExplorerPanel.tsx
// PURPOSE: ActivityBar side panel showing a tree view of all workbook objects.
// CONTEXT: Phase B — clicking a leaf node opens the JSON editor for that object.

import React, { useState, useEffect, useCallback } from "react";
import { getWorkbookTree, getObjectJson } from "@api/jsonView";
import type { TreeNode as TreeNodeData } from "@api/jsonView";
import { MonacoJsonEditor } from "./MonacoJsonEditor";

// ============================================================================
// Styles
// ============================================================================

const s = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    backgroundColor: "#1e1e1e",
    color: "#cccccc",
    fontSize: "13px",
    fontFamily: "'Segoe UI', sans-serif",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    borderBottom: "1px solid #333",
    flexShrink: 0,
  },
  title: {
    fontWeight: 600,
    fontSize: "12px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    color: "#999",
  },
  refreshBtn: {
    background: "none",
    border: "none",
    color: "#cccccc",
    cursor: "pointer",
    fontSize: "13px",
    padding: "2px 6px",
    borderRadius: "3px",
  },
  treeContainer: {
    flex: 1,
    overflow: "auto",
    minHeight: 0,
  },
  // Tree node styles
  nodeRow: {
    display: "flex",
    alignItems: "center",
    padding: "2px 0",
    cursor: "pointer",
    userSelect: "none" as const,
  },
  nodeRowHover: {
    backgroundColor: "#2a2d2e",
  },
  nodeRowSelected: {
    backgroundColor: "#094771",
  },
  expandIcon: {
    width: "16px",
    textAlign: "center" as const,
    fontSize: "10px",
    color: "#888",
    flexShrink: 0,
  },
  nodeLabel: {
    fontSize: "13px",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  leafIcon: {
    color: "#569cd6",
    marginRight: "4px",
    fontSize: "11px",
  },
  branchIcon: {
    color: "#dcdcaa",
    marginRight: "4px",
    fontSize: "11px",
  },
  // Inline editor
  editorHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 10px",
    borderTop: "1px solid #333",
    borderBottom: "1px solid #333",
    backgroundColor: "#252526",
    flexShrink: 0,
  },
  editorTitle: {
    fontSize: "12px",
    fontWeight: 600,
    color: "#cccccc",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#cccccc",
    cursor: "pointer",
    fontSize: "14px",
    padding: "0 4px",
  },
  editorContainer: {
    height: "50%",
    minHeight: "150px",
    borderTop: "1px solid #333",
    flexShrink: 0,
  },
  emptyState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 20px",
    color: "#666",
    textAlign: "center" as const,
  },
};

// ============================================================================
// TreeNodeRow — a single row in the tree
// ============================================================================

interface TreeNodeRowProps {
  node: TreeNodeData;
  depth: number;
  selectedKey: string | null;
  onSelect: (objectType: string, objectId: string, label: string) => void;
  expandedKeys: Set<string>;
  onToggleExpand: (key: string) => void;
}

function getNodeKey(node: TreeNodeData): string {
  if (node.objectType && node.objectId) {
    return `${node.objectType}:${node.objectId}`;
  }
  return `cat:${node.label}`;
}

function TreeNodeRow({
  node,
  depth,
  selectedKey,
  onSelect,
  expandedKeys,
  onToggleExpand,
}: TreeNodeRowProps): React.ReactElement {
  const key = getNodeKey(node);
  const isLeaf = node.children.length === 0 && node.objectType !== null;
  const isCategory = node.children.length > 0;
  const isExpanded = expandedKeys.has(key);
  const isSelected = selectedKey === key;

  const handleClick = () => {
    if (isCategory) {
      onToggleExpand(key);
    }
    if (node.objectType && node.objectId) {
      onSelect(node.objectType, node.objectId, node.label);
    }
  };

  const paddingLeft = 8 + depth * 16;

  return (
    <>
      <div
        style={{
          ...s.nodeRow,
          paddingLeft: `${paddingLeft}px`,
          ...(isSelected ? s.nodeRowSelected : {}),
        }}
        onClick={handleClick}
        onMouseEnter={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLElement).style.backgroundColor = "#2a2d2e";
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLElement).style.backgroundColor = "";
          }
        }}
      >
        {isCategory ? (
          <span style={s.expandIcon}>{isExpanded ? "\u25BE" : "\u25B8"}</span>
        ) : (
          <span style={s.expandIcon} />
        )}
        {isLeaf ? (
          <span style={s.leafIcon}>{"{}"}</span>
        ) : isCategory ? (
          <span style={s.branchIcon}>{isExpanded ? "[-]" : "[+]"}</span>
        ) : null}
        <span style={s.nodeLabel}>{node.label}</span>
      </div>
      {isCategory && isExpanded &&
        node.children.map((child, idx) => (
          <TreeNodeRow
            key={`${getNodeKey(child)}-${idx}`}
            node={child}
            depth={depth + 1}
            selectedKey={selectedKey}
            onSelect={onSelect}
            expandedKeys={expandedKeys}
            onToggleExpand={onToggleExpand}
          />
        ))}
    </>
  );
}

// ============================================================================
// WorkbookExplorerPanel
// ============================================================================

export function WorkbookExplorerPanel(): React.ReactElement {
  const [tree, setTree] = useState<TreeNodeData | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [showEditor, setShowEditor] = useState(false);

  // Load tree
  const loadTree = useCallback(() => {
    getWorkbookTree()
      .then((root) => {
        setTree(root);
        // Auto-expand root children
        const keys = new Set<string>();
        for (const child of root.children) {
          keys.add(getNodeKey(child));
        }
        setExpandedKeys((prev) => new Set([...prev, ...keys]));
      })
      .catch((err) => console.error("[JsonView] Failed to load tree:", err));
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const handleToggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    async (objectType: string, objectId: string, label: string) => {
      const key = `${objectType}:${objectId}`;
      setSelectedKey(key);
      setSelectedLabel(label);
      try {
        const json = await getObjectJson(objectType, objectId);
        setJsonText(json);
        setShowEditor(true);
      } catch (err) {
        setJsonText(`// Error loading: ${err}`);
        setShowEditor(true);
      }
    },
    [],
  );

  const handleCloseEditor = useCallback(() => {
    setShowEditor(false);
    setSelectedKey(null);
  }, []);

  return (
    <div style={s.container}>
      {/* Toolbar */}
      <div style={s.toolbar}>
        <span style={s.title}>Explorer</span>
        <button style={s.refreshBtn} onClick={loadTree} title="Refresh">
          Refresh
        </button>
      </div>

      {/* Tree */}
      <div style={s.treeContainer}>
        {tree ? (
          tree.children.map((child, idx) => (
            <TreeNodeRow
              key={`${getNodeKey(child)}-${idx}`}
              node={child}
              depth={0}
              selectedKey={selectedKey}
              onSelect={handleSelect}
              expandedKeys={expandedKeys}
              onToggleExpand={handleToggleExpand}
            />
          ))
        ) : (
          <div style={s.emptyState}>Loading...</div>
        )}
      </div>

      {/* Inline JSON editor (bottom half) */}
      {showEditor && (
        <>
          <div style={s.editorHeader}>
            <span style={s.editorTitle}>{selectedLabel}</span>
            <button style={s.closeBtn} onClick={handleCloseEditor}>
              X
            </button>
          </div>
          <div style={s.editorContainer}>
            <MonacoJsonEditor
              value={jsonText}
              onChange={setJsonText}
              readOnly
            />
          </div>
        </>
      )}
    </div>
  );
}
