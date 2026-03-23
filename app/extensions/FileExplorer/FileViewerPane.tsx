//! FILENAME: app/extensions/FileExplorer/FileViewerPane.tsx
// PURPOSE: Task Pane component for editing virtual files in the right panel
// CONTEXT: Opened via double-click on a virtual file in the File Explorer

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TaskPaneViewProps } from "../../src/api/uiTypes";
import { readVirtualFile, createVirtualFile } from "../../src/api/backend";
import { MarkdownView, getViewMode } from "./FileRenderer";
import { resolveTemplates, hasTemplates } from "./TemplateResolver";

const h = React.createElement;

interface TabState {
  filePath: string;
  content: string;
  dirty: boolean;
  showSource: boolean;
  loading: boolean;
  error: string | null;
  preview: boolean;  // Transient tab (italic) — replaced on next single-click
}

function makeTabId(filePath: string): string {
  return filePath;
}

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function getExt(fileName: string): string {
  return fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() || "" : "";
}

export const FileViewerPane: React.FC<TaskPaneViewProps> = ({ data }) => {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const filePath = (data?.filePath as string) || "";
  const isPreview = data?.preview === true;

  // When filePath changes from outside, open or switch to that tab
  useEffect(() => {
    if (!filePath) return;

    // Use the updater form of setTabs so `prev` is always the latest state,
    // avoiding race conditions when single-click and double-click fire in quick succession.
    setTabs(prev => {
      const existingIdx = prev.findIndex(t => t.filePath === filePath);

      if (existingIdx >= 0) {
        // Tab already open — if double-clicked (not preview), pin it
        if (!isPreview && prev[existingIdx].preview) {
          const next = [...prev];
          next[existingIdx] = { ...next[existingIdx], preview: false };
          return next;
        }
        return prev; // No change needed
      }

      // New tab
      const newTab: TabState = {
        filePath,
        content: "",
        dirty: false,
        showSource: true,
        loading: true,
        error: null,
        preview: isPreview,
      };

      if (isPreview) {
        // Replace existing non-dirty preview tab
        const previewIdx = prev.findIndex(t => t.preview && !t.dirty);
        if (previewIdx >= 0) {
          const next = [...prev];
          next[previewIdx] = newTab;
          return next;
        }
      }
      return [...prev, newTab];
    });

    setActiveTabId(makeTabId(filePath));

    // Always attempt to load — the updater above is idempotent for existing tabs,
    // and the load result uses an updater too, so it safely targets the right tab.
    let cancelled = false;
    readVirtualFile(filePath)
      .then((text) => {
        if (!cancelled) {
          setTabs(prev => prev.map(t =>
            t.filePath === filePath && t.loading ? { ...t, content: text, loading: false } : t
          ));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTabs(prev => prev.map(t =>
            t.filePath === filePath && t.loading ? { ...t, error: String(err), loading: false } : t
          ));
        }
      });

    return () => { cancelled = true; };
  }, [filePath, isPreview]);

  const activeTab = tabs.find(t => makeTabId(t.filePath) === activeTabId) || null;

  const updateActiveTab = useCallback((update: Partial<TabState>) => {
    if (!activeTabId) return;
    setTabs(prev => prev.map(t =>
      makeTabId(t.filePath) === activeTabId ? { ...t, ...update } : t
    ));
  }, [activeTabId]);

  const handleSave = useCallback(async () => {
    if (!activeTab || !activeTab.dirty) return;
    setSaving(true);
    try {
      const tab = tabsRef.current.find(t => makeTabId(t.filePath) === activeTabId);
      if (tab) {
        await createVirtualFile(tab.filePath, tab.content);
        setTabs(prev => prev.map(t =>
          makeTabId(t.filePath) === activeTabId ? { ...t, dirty: false } : t
        ));
      }
    } catch (err) {
      console.error("[FileViewerPane] Save failed:", err);
    } finally {
      setSaving(false);
    }
  }, [activeTab, activeTabId]);

  const handleCloseTab = useCallback((tabFilePath: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    const tab = tabsRef.current.find(t => t.filePath === tabFilePath);
    if (tab?.dirty) {
      const confirmed = window.confirm(`"${getFileName(tabFilePath)}" has unsaved changes. Close anyway?`);
      if (!confirmed) return;
    }

    setTabs(prev => {
      const next = prev.filter(t => t.filePath !== tabFilePath);
      // If we're closing the active tab, switch to an adjacent one
      if (makeTabId(tabFilePath) === activeTabId) {
        const closedIdx = prev.findIndex(t => t.filePath === tabFilePath);
        if (next.length > 0) {
          const newIdx = Math.min(closedIdx, next.length - 1);
          setActiveTabId(makeTabId(next[newIdx].filePath));
        } else {
          setActiveTabId(null);
        }
      }
      return next;
    });
  }, [activeTabId]);

  // Template resolution for preview mode
  const [resolvedContent, setResolvedContent] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!activeTab || activeTab.showSource || activeTab.loading) {
      setResolvedContent(null);
      return;
    }

    // Only resolve if content has {{ }} templates
    if (!hasTemplates(activeTab.content)) {
      setResolvedContent(activeTab.content);
      return;
    }

    let cancelled = false;
    setResolving(true);
    resolveTemplates(activeTab.content)
      .then((resolved) => {
        if (!cancelled) {
          setResolvedContent(resolved);
          setResolving(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedContent(activeTab.content);
          setResolving(false);
        }
      });

    return () => { cancelled = true; };
  }, [activeTab?.filePath, activeTab?.showSource, activeTab?.content, activeTab?.loading]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
      e.stopPropagation();
      handleSave();
    }
    // Ctrl+W closes active tab
    if (e.ctrlKey && e.key === "w") {
      e.preventDefault();
      e.stopPropagation();
      if (activeTab) {
        handleCloseTab(activeTab.filePath);
      }
    }
  }, [handleSave, handleCloseTab, activeTab]);

  // No tabs open
  if (tabs.length === 0) {
    return h("div", { style: styles.container },
      h("div", { style: styles.emptyState },
        h("span", { style: styles.emptyText }, "No files open"),
      ),
    );
  }

  // Tab bar
  const tabBar = h("div", { style: styles.tabBar },
    tabs.map(tab => {
      const id = makeTabId(tab.filePath);
      const isActive = id === activeTabId;
      const name = getFileName(tab.filePath);

      return h("div", {
        key: id,
        style: {
          ...styles.tab,
          ...(isActive ? styles.tabActive : styles.tabInactive),
        },
        onClick: () => setActiveTabId(id),
        onDoubleClick: () => {
          // Double-click pins a preview tab
          if (tab.preview) {
            setTabs(prev => prev.map(t =>
              t.filePath === tab.filePath ? { ...t, preview: false } : t
            ));
          }
        },
        title: tab.filePath,
      },
        h("span", {
          style: {
            ...styles.tabName,
            fontStyle: tab.preview ? "italic" : "normal",
          },
        },
          name, tab.dirty ? " *" : "",
        ),
        h("button", {
          style: styles.tabClose,
          onClick: (e: React.MouseEvent) => handleCloseTab(tab.filePath, e),
          title: "Close",
        }, "\u00D7"),
      );
    }),
  );

  // Active tab content
  if (!activeTab) {
    return h("div", { style: styles.container },
      tabBar,
      h("div", { style: styles.body },
        h("span", { style: styles.emptyText }, "Select a tab"),
      ),
    );
  }

  const fileName = getFileName(activeTab.filePath);
  const ext = getExt(fileName);
  const viewMode = getViewMode(ext);
  const langLabel = ext ? ext.toUpperCase() : "TEXT";
  const contentHasTemplates = hasTemplates(activeTab.content);
  const isRendered = !activeTab.showSource && activeTab.content.trim().length > 0;
  const isMarkdownRendered = viewMode === "markdown" && isRendered;

  if (activeTab.loading) {
    return h("div", { style: styles.container },
      tabBar,
      h("div", { style: styles.toolbar },
        h("span", { style: styles.fileName }, fileName),
      ),
      h("div", { style: styles.body },
        h("span", { style: styles.loadingText }, "Loading..."),
      ),
    );
  }

  if (activeTab.error) {
    return h("div", { style: styles.container },
      tabBar,
      h("div", { style: styles.toolbar },
        h("span", { style: styles.fileName }, fileName),
      ),
      h("div", { style: styles.body },
        h("span", { style: styles.errorText }, activeTab.error),
      ),
    );
  }

  return h("div", { style: styles.container, onKeyDown: handleKeyDown },
    // Tab bar
    tabBar,
    // Toolbar
    h("div", { style: styles.toolbar },
      h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        (viewMode === "markdown" || contentHasTemplates) && h("button", {
          style: styles.toggleButton,
          onClick: () => updateActiveTab({ showSource: !activeTab.showSource }),
          title: activeTab.showSource ? "Preview (resolve templates)" : "Edit source",
        }, activeTab.showSource ? "Preview" : "Edit"),
        activeTab.dirty && h("button", {
          style: styles.saveButton,
          onClick: handleSave,
          disabled: saving,
          title: "Save (Ctrl+S)",
        }, saving ? "Saving..." : "Save"),
        h("span", { style: styles.langBadge }, langLabel),
      ),
    ),
    // Body: rendered preview or editable textarea
    h("div", { style: styles.body },
      isRendered && resolving
        ? h("div", { style: { padding: "10px 12px" } },
            h("span", { style: styles.loadingText }, "Resolving templates..."),
          )
        : isMarkdownRendered
        ? h("div", { style: styles.renderedBody },
            h(MarkdownView, { content: resolvedContent || activeTab.content }),
          )
        : isRendered
        ? h("pre", {
            style: styles.previewText,
          }, resolvedContent || activeTab.content)
        : h("textarea", {
            style: styles.textarea,
            value: activeTab.content,
            onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
              updateActiveTab({ content: e.target.value, dirty: true, preview: false });
            },
            onKeyDown: handleKeyDown,
            spellCheck: false,
          }),
    ),
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  tabBar: {
    display: "flex",
    flexShrink: 0,
    overflow: "hidden",
    backgroundColor: "#f0f0f0",
    borderBottom: "1px solid #d0d0d0",
    minHeight: 30,
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 8px",
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    borderRight: "1px solid #d0d0d0",
    maxWidth: 160,
    minWidth: 0,
    userSelect: "none" as const,
  },
  tabActive: {
    backgroundColor: "#fff",
    borderBottom: "1px solid #fff",
    marginBottom: -1,
    color: "#333",
    fontWeight: 600,
  },
  tabInactive: {
    backgroundColor: "#ececec",
    color: "#666",
    fontWeight: 400,
  },
  tabName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flex: 1,
    minWidth: 0,
  },
  tabClose: {
    border: "none",
    background: "none",
    padding: "0 2px",
    fontSize: 14,
    lineHeight: "1",
    color: "#888",
    cursor: "pointer",
    borderRadius: 3,
    flexShrink: 0,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: "4px 12px",
    borderBottom: "1px solid #e0e0e0",
    backgroundColor: "#f8f9fa",
    flexShrink: 0,
    minHeight: 28,
  },
  fileName: {
    fontSize: 12,
    fontWeight: 600,
    color: "#333",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  langBadge: {
    fontSize: 9,
    fontWeight: 600,
    color: "#666",
    backgroundColor: "#e8e8e8",
    padding: "1px 5px",
    borderRadius: 3,
    flexShrink: 0,
  },
  toggleButton: {
    fontSize: 10,
    fontWeight: 500,
    color: "#555",
    backgroundColor: "#e8e8e8",
    border: "none",
    borderRadius: 3,
    padding: "2px 8px",
    cursor: "pointer",
  },
  saveButton: {
    fontSize: 11,
    fontWeight: 600,
    color: "#fff",
    backgroundColor: "#007acc",
    border: "none",
    borderRadius: 3,
    padding: "3px 10px",
    cursor: "pointer",
  },
  body: {
    flex: 1,
    overflow: "hidden",
    padding: 0,
  },
  renderedBody: {
    width: "100%",
    height: "100%",
    overflow: "auto",
    padding: "10px 12px",
    boxSizing: "border-box" as const,
  },
  textarea: {
    width: "100%",
    height: "100%",
    margin: 0,
    padding: "10px 12px",
    border: "none",
    outline: "none",
    resize: "none" as const,
    fontSize: 12,
    lineHeight: "1.6",
    color: "#333",
    backgroundColor: "#fff",
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    boxSizing: "border-box" as const,
  },
  previewText: {
    width: "100%",
    height: "100%",
    margin: 0,
    padding: "10px 12px",
    overflow: "auto",
    fontSize: 12,
    lineHeight: "1.6",
    color: "#333",
    backgroundColor: "#fff",
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    boxSizing: "border-box" as const,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  },
  emptyState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    height: "100%",
  },
  emptyText: {
    fontSize: 12,
    color: "#999",
    fontStyle: "italic" as const,
  },
  loadingText: {
    fontSize: 12,
    color: "#999",
    fontStyle: "italic" as const,
    padding: "10px 12px",
  },
  errorText: {
    fontSize: 12,
    color: "#d32f2f",
    padding: "10px 12px",
  },
};
