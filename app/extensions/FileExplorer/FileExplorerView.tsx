//! FILENAME: app/extensions/FileExplorer/FileExplorerView.tsx
// PURPOSE: Tree view showing workbook structure and workspace files
// CONTEXT: Activity Bar view - displays sheets, tables, named ranges, and virtual files inside .cala

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityViewProps } from "../../src/api/uiTypes";
import {
  getSheets,
  getAllNamedRanges,
  setActiveSheet as setActiveSheetApi,
  openTaskPane,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  useTaskPaneOpenPaneIds,
  type SheetInfo,
  type NamedRange,
  onAppEvent,
  AppEvents,
} from "../../src/api";
import {
  getAllTables,
  listVirtualFiles,
  readVirtualFile,
  createVirtualFile,
  createVirtualFolder,
  deleteVirtualFile,
  renameVirtualFile,
  type Table,
  type VirtualFileEntry,
} from "../../src/api/backend";
import { FILE_VIEWER_PANE_ID } from "./constants";
import { getSettings } from "../Settings/SettingsView";
import { MarkdownView, getViewMode } from "./FileRenderer";

// ============================================================================
// SVG Icons (minimalistic, 14x14)
// ============================================================================

const h = React.createElement;

function Icon({ children, color = "#666" }: { children: React.ReactNode; color?: string }) {
  return h("svg", {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: color,
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: { flexShrink: 0 },
  }, children);
}

/** Small grid icon for sheets */
function SheetIcon() {
  return h(Icon, { color: "#4caf50" },
    h("rect", { x: 2, y: 2, width: 12, height: 12, rx: 1 }),
    h("line", { x1: 2, y1: 6, x2: 14, y2: 6 }),
    h("line", { x1: 2, y1: 10, x2: 14, y2: 10 }),
    h("line", { x1: 6, y1: 2, x2: 6, y2: 14 }),
    h("line", { x1: 10, y1: 2, x2: 10, y2: 14 }),
  );
}

/** Hidden sheet (dashed grid) */
function HiddenSheetIcon() {
  return h(Icon, { color: "#999" },
    h("rect", { x: 2, y: 2, width: 12, height: 12, rx: 1, strokeDasharray: "2 2" }),
    h("line", { x1: 2, y1: 6, x2: 14, y2: 6, strokeDasharray: "2 2" }),
    h("line", { x1: 6, y1: 2, x2: 6, y2: 14, strokeDasharray: "2 2" }),
  );
}

/** Table icon (grid with colored header) */
function TableIcon() {
  return h(Icon, { color: "#2196f3" },
    h("rect", { x: 2, y: 2, width: 12, height: 12, rx: 1 }),
    h("rect", { x: 2, y: 2, width: 12, height: 4, rx: 1, fill: "#2196f3", stroke: "#2196f3" }),
    h("line", { x1: 2, y1: 10, x2: 14, y2: 10 }),
    h("line", { x1: 6, y1: 6, x2: 6, y2: 14 }),
    h("line", { x1: 10, y1: 6, x2: 10, y2: 14 }),
  );
}

/** Named range icon (tag) */
function NamedRangeIcon() {
  return h(Icon, { color: "#ff9800" },
    h("path", { d: "M4 2h8l2 3-2 3H4V2z" }),
    h("line", { x1: 4, y1: 11, x2: 4, y2: 14 }),
  );
}

/** Section header icons */
function SheetsGroupIcon() {
  return h(Icon, { color: "#4caf50" },
    h("rect", { x: 1, y: 3, width: 10, height: 10, rx: 1 }),
    h("rect", { x: 5, y: 1, width: 10, height: 10, rx: 1, fill: "#f8f9fa" }),
    h("line", { x1: 5, y1: 5, x2: 15, y2: 5 }),
    h("line", { x1: 5, y1: 8, x2: 15, y2: 8 }),
    h("line", { x1: 9, y1: 1, x2: 9, y2: 11 }),
  );
}

function TablesGroupIcon() {
  return h(Icon, { color: "#2196f3" },
    h("rect", { x: 2, y: 2, width: 12, height: 12, rx: 1 }),
    h("rect", { x: 2, y: 2, width: 12, height: 3, rx: 1, fill: "#2196f3", stroke: "#2196f3" }),
    h("line", { x1: 2, y1: 9, x2: 14, y2: 9 }),
    h("line", { x1: 8, y1: 5, x2: 8, y2: 14 }),
  );
}

function RangesGroupIcon() {
  return h(Icon, { color: "#ff9800" },
    h("path", { d: "M3 2h10l3 4-3 4H3V2z" }),
  );
}

function FilesGroupIcon() {
  return h(Icon, { color: "#78909c" },
    h("path", { d: "M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5l-3-3H3z" }),
    h("path", { d: "M10 2v3h3" }),
  );
}

/** Folder icon for virtual directories */
function FolderIcon() {
  return h(Icon, { color: "#90a4ae" },
    h("path", { d: "M2 5v7a1 1 0 001 1h10a1 1 0 001-1V7a1 1 0 00-1-1H8L6.5 4.5H3A1 1 0 002 5z" }),
  );
}

/** File type icons by extension */
function FileIcon({ ext }: { ext: string }) {
  const e = ext.toLowerCase();
  if (e === "md" || e === "markdown" || e === "mdx") {
    // Markdown icon: file with "M" mark and down arrow
    return h(Icon, { color: "#519aba" },
      h("path", { d: "M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5l-3-3H3z" }),
      h("path", { d: "M10 2v3h3" }),
      h("path", { d: "M4.5 10.5V6.5l1.5 2 1.5-2v4", fill: "none" }),
      h("path", { d: "M10 7.5v3M8.5 9l1.5 1.5L11.5 9", fill: "none" }),
    );
  }
  if (e === "txt" || e === "readme" || e === "log") {
    return h(Icon, { color: "#5c6bc0" },
      h("path", { d: "M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5l-3-3H3z" }),
      h("path", { d: "M10 2v3h3" }),
      h("line", { x1: 5, y1: 7, x2: 11, y2: 7 }),
      h("line", { x1: 5, y1: 9.5, x2: 9, y2: 9.5 }),
    );
  }
  if (e === "cala" || e === "xlsx" || e === "xls" || e === "csv") {
    return h(Icon, { color: "#217346" },
      h("path", { d: "M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5l-3-3H3z" }),
      h("path", { d: "M10 2v3h3" }),
      h("line", { x1: 5, y1: 7, x2: 11, y2: 7 }),
      h("line", { x1: 5, y1: 10, x2: 11, y2: 10 }),
      h("line", { x1: 8, y1: 5, x2: 8, y2: 12 }),
    );
  }
  if (e === "json" || e === "yaml" || e === "yml" || e === "toml") {
    return h(Icon, { color: "#f9a825" },
      h("path", { d: "M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5l-3-3H3z" }),
      h("path", { d: "M10 2v3h3" }),
      h("text", { x: 5.5, y: 11, fill: "#f9a825", stroke: "none", fontSize: 6, fontWeight: "bold" }, "{ }"),
    );
  }
  if (e === "png" || e === "jpg" || e === "jpeg" || e === "gif" || e === "svg") {
    return h(Icon, { color: "#26a69a" },
      h("path", { d: "M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5l-3-3H3z" }),
      h("circle", { cx: 6, cy: 7, r: 1.5 }),
      h("path", { d: "M2 12l3-4 2 2 3-3 4 5" }),
    );
  }
  return h(Icon, { color: "#78909c" },
    h("path", { d: "M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5l-3-3H3z" }),
    h("path", { d: "M10 2v3h3" }),
  );
}

// ============================================================================
// Tree Types
// ============================================================================

interface TreeNode {
  id: string;
  label: string;
  icon?: React.ReactNode;
  children?: TreeNode[];
  action?: () => void;
  doubleClickAction?: () => void;
  detail?: string;
  bold?: boolean;
  /** Virtual file/folder path for context menu operations */
  virtualPath?: string;
  /** Whether this node is a virtual directory */
  isVirtualDir?: boolean;
}

// ============================================================================
// Context Menu
// ============================================================================

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuItem {
  label: string;
  action: () => void;
  separator?: boolean;
}

function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div ref={ref} style={{ ...ctxStyles.menu, left: menu.x, top: menu.y }}>
      {menu.items.map((item, i) => (
        <div
          key={i}
          style={ctxStyles.menuItem}
          onClick={() => { item.action(); onClose(); }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.backgroundColor = "#e8e8e8"; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.backgroundColor = "transparent"; }}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}

const ctxStyles: Record<string, React.CSSProperties> = {
  menu: {
    position: "fixed",
    zIndex: 9999,
    backgroundColor: "#fff",
    border: "1px solid #d0d0d0",
    borderRadius: 4,
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    padding: "4px 0",
    minWidth: 140,
  },
  menuItem: {
    padding: "5px 16px",
    fontSize: 12,
    cursor: "pointer",
    color: "#333",
    userSelect: "none" as const,
  },
};

// ============================================================================
// Previewable file extensions
// ============================================================================

const PREVIEWABLE_EXTENSIONS = new Set([
  "md", "txt", "readme", "json", "yaml", "yml", "toml",
  "csv", "log", "xml", "html", "css", "js", "ts", "py",
  "rs", "ini", "cfg", "conf", "env",
]);

function isPreviewable(ext: string): boolean {
  if (!ext) return true; // Virtual files with no extension are likely text
  return PREVIEWABLE_EXTENSIONS.has(ext.toLowerCase());
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ============================================================================
// Main Component
// ============================================================================

export function FileExplorerView(_props: ActivityViewProps): React.ReactElement {
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [tables, setTables] = useState<Table[]>([]);
  const [namedRanges, setNamedRanges] = useState<NamedRange[]>([]);
  const [virtualFiles, setVirtualFiles] = useState<VirtualFileEntry[]>([]);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    new Set(["sheets", "files"])
  );

  // File preview state
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  // previewDirty and previewShowSource removed — side panel is now read-only preview

  // Inline creation state
  const [creatingType, setCreatingType] = useState<"file" | "folder" | null>(null);
  const [creatingParent, setCreatingParent] = useState<string>(""); // "" = root of files
  const [creatingName, setCreatingName] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  // Inline rename state
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string>("");
  const [renamingIsDir, setRenamingIsDir] = useState(false);
  const [renamingName, setRenamingName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Drag-and-drop state — mouse-based (HTML5 DnD doesn't work in Tauri WebView2)
  const [dragState, setDragState] = useState<{
    sourcePath: string;
    sourceNodeId: string;
    startX: number;
    startY: number;
    dragging: boolean; // true once moved past threshold
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const openPaneIds = useTaskPaneOpenPaneIds();
  const isFileViewerOpen = openPaneIds.includes(FILE_VIEWER_PANE_ID);

  const refresh = useCallback(async () => {
    try {
      const [sheetsResult, tablesResult, rangesResult, filesResult] = await Promise.all([
        getSheets(),
        getAllTables().catch(() => [] as Table[]),
        getAllNamedRanges().catch(() => [] as NamedRange[]),
        listVirtualFiles().catch(() => [] as VirtualFileEntry[]),
      ]);
      setSheets(sheetsResult.sheets);
      setActiveSheet(sheetsResult.activeIndex);
      setTables(tablesResult);
      setNamedRanges(rangesResult);
      setVirtualFiles(filesResult);
    } catch (err) {
      console.error("[FileExplorer] Failed to load data:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
    const handleSheetChange = () => refresh();
    const unsub = onAppEvent(AppEvents.SHEET_CHANGED, handleSheetChange);
    return unsub;
  }, [refresh]);

  const handleNavigateSheet = useCallback(async (index: number) => {
    try {
      await setActiveSheetApi(index);
      setActiveSheet(index);
    } catch (err) {
      console.error("[FileExplorer] Failed to switch sheet:", err);
    }
  }, []);

  /** Open a file in the right-side Task Pane */
  const openInTaskPane = useCallback((filePath: string) => {
    addTaskPaneContextKey("file-viewer");
    openTaskPane(FILE_VIEWER_PANE_ID, { filePath });
  }, []);

  /** Single-click handler: preview below tree OR open in task pane based on settings */
  const handleFileClick = useCallback(async (filePath: string) => {
    const settings = getSettings();
    if (settings.fileClickAction === "taskpane" || isFileViewerOpen) {
      // If task pane is already open or settings override: open as preview tab
      addTaskPaneContextKey("file-viewer");
      openTaskPane(FILE_VIEWER_PANE_ID, { filePath, preview: true });
      return;
    }
    // Default: preview below tree
    if (previewFile === filePath) {
      setPreviewFile(null);
      setPreviewContent("");
      return;
    }
    setPreviewFile(filePath);
    setPreviewLoading(true);
    try {
      const content = await readVirtualFile(filePath);
      setPreviewContent(content);
    } catch (err) {
      setPreviewContent(`Error: ${err}`);
    } finally {
      setPreviewLoading(false);
    }
  }, [previewFile, openInTaskPane, isFileViewerOpen]);

  /** Double-click handler: always opens in the right-side Task Pane */
  const handleFileDoubleClick = useCallback((filePath: string) => {
    openInTaskPane(filePath);
  }, [openInTaskPane]);

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  // ---------- Create ----------
  const startCreate = useCallback((type: "file" | "folder", parentPath: string = "") => {
    setContextMenu(null);
    // Expand the parent folder node + files section
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      next.add("files");
      if (parentPath) next.add(`vdir-${parentPath}`);
      return next;
    });
    setCreatingType(type);
    setCreatingParent(parentPath);
    setCreatingName("");
    setTimeout(() => createInputRef.current?.focus(), 0);
  }, []);

  const confirmCreate = useCallback(async () => {
    const name = creatingName.trim();
    if (!name || !creatingType) {
      setCreatingType(null);
      setCreatingName("");
      return;
    }
    const fullPath = creatingParent ? `${creatingParent}/${name}` : name;
    try {
      if (creatingType === "file") {
        await createVirtualFile(fullPath);
      } else {
        await createVirtualFolder(fullPath);
      }
      setCreatingType(null);
      setCreatingName("");
      refresh();
    } catch (err) {
      console.error(`[FileExplorer] Failed to create ${creatingType}:`, err);
    }
  }, [creatingName, creatingType, creatingParent, refresh]);

  const cancelCreate = useCallback(() => {
    setCreatingType(null);
    setCreatingName("");
  }, []);

  // ---------- Rename ----------
  const startRename = useCallback((nodeId: string, path: string, isDir: boolean) => {
    setContextMenu(null);
    setRenamingNodeId(nodeId);
    setRenamingPath(path);
    setRenamingIsDir(isDir);
    // Show the last part of the path as the editable name
    const parts = path.split("/");
    setRenamingName(parts[parts.length - 1]);
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  }, []);

  const confirmRename = useCallback(async () => {
    const newName = renamingName.trim();
    if (!newName || !renamingPath) {
      setRenamingNodeId(null);
      return;
    }
    const parts = renamingPath.split("/");
    parts[parts.length - 1] = newName;
    const newPath = parts.join("/");
    if (newPath === renamingPath) {
      setRenamingNodeId(null);
      return;
    }
    try {
      await renameVirtualFile(renamingPath, newPath);
      setRenamingNodeId(null);
      // Update preview if the renamed file was being previewed
      if (previewFile === renamingPath) {
        setPreviewFile(newPath);
      }
      refresh();
    } catch (err) {
      console.error("[FileExplorer] Rename failed:", err);
    }
  }, [renamingName, renamingPath, previewFile, refresh]);

  const cancelRename = useCallback(() => {
    setRenamingNodeId(null);
  }, []);

  // ---------- Delete ----------
  const handleDelete = useCallback(async (path: string) => {
    setContextMenu(null);
    try {
      await deleteVirtualFile(path);
      if (previewFile && (previewFile === path || previewFile.startsWith(path + "/"))) {
        setPreviewFile(null);
        setPreviewContent("");
      }
      refresh();
    } catch (err) {
      console.error("[FileExplorer] Delete failed:", err);
    }
  }, [previewFile, refresh]);

  // ---------- Drag and Drop (mouse-based, Tauri-compatible) ----------
  const handleDragMouseDown = useCallback((e: React.MouseEvent, virtualPath: string, nodeId: string) => {
    if (e.button !== 0) return; // left-click only
    setDragState({
      sourcePath: virtualPath,
      sourceNodeId: nodeId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    });
  }, []);

  // Find drop target node from mouse position using data attributes
  const findDropTarget = useCallback((clientX: number, clientY: number): { nodeId: string; targetPath: string | null } | null => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!el) return null;
    // Walk up to find an element with data-drop-node-id
    let current: HTMLElement | null = el;
    while (current && !current.dataset.dropNodeId) {
      current = current.parentElement;
    }
    if (!current) return null;
    const nodeId = current.dataset.dropNodeId!;
    const targetPath = current.dataset.dropTargetPath || null;
    return { nodeId, targetPath };
  }, []);

  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      setDragState(prev => {
        if (!prev) return null;
        const dragging = prev.dragging || Math.abs(e.clientX - prev.startX) > 5 || Math.abs(e.clientY - prev.startY) > 5;
        return { ...prev, dragging };
      });

      // Update drop target based on what's under cursor
      const target = findDropTarget(e.clientX, e.clientY);
      if (target) {
        setDropTarget(prev => prev === target.nodeId ? prev : target.nodeId);
      } else {
        setDropTarget(null);
      }
    };

    const handleMouseUp = async (e: MouseEvent) => {
      const state = dragState;
      setDragState(null);
      setDropTarget(null);

      if (!state.dragging) return;

      const target = findDropTarget(e.clientX, e.clientY);
      if (!target) return;

      const sourcePath = state.sourcePath;
      const targetPath = target.targetPath;
      const name = sourcePath.split("/").pop() || sourcePath;
      const newPath = targetPath ? `${targetPath}/${name}` : name;

      if (newPath === sourcePath) return;
      // Prevent dropping into itself
      if (targetPath && (targetPath === sourcePath || targetPath.startsWith(sourcePath + "/"))) return;

      try {
        await renameVirtualFile(sourcePath, newPath);
        if (previewFile && (previewFile === sourcePath || previewFile.startsWith(sourcePath + "/"))) {
          setPreviewFile(previewFile.replace(sourcePath, newPath));
        }
        refresh();
      } catch (err) {
        console.error("[FileExplorer] Move failed:", err);
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState, findDropTarget, previewFile, refresh]);

  // ---------- Context Menu ----------
  const showContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();

    const items: ContextMenuItem[] = [];

    if (node.id === "files") {
      // Right-click on "Files" section header
      items.push({ label: "New File...", action: () => startCreate("file") });
      items.push({ label: "New Folder...", action: () => startCreate("folder") });
    } else if (node.isVirtualDir && node.virtualPath) {
      const dirPath = node.virtualPath;
      items.push({ label: "New File...", action: () => startCreate("file", dirPath) });
      items.push({ label: "New Folder...", action: () => startCreate("folder", dirPath) });
      items.push({ label: "Rename...", action: () => startRename(node.id, dirPath, true) });
      items.push({ label: "Delete", action: () => handleDelete(dirPath) });
    } else if (node.virtualPath) {
      // File
      items.push({ label: "Open in Task Pane", action: () => openInTaskPane(node.virtualPath!) });
      items.push({ label: "Rename...", action: () => startRename(node.id, node.virtualPath!, false) });
      items.push({ label: "Delete", action: () => handleDelete(node.virtualPath!) });
    }

    if (items.length > 0) {
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    }
  }, [startCreate, startRename, handleDelete, openInTaskPane]);

  // ---------- Build file tree ----------
  function buildFileTree(files: VirtualFileEntry[]): TreeNode[] {
    const rootFiles = files.filter(
      (f) => !f.isDir && !f.path.includes("/") && !f.path.startsWith(".") && !f.path.endsWith("/.folder")
    );
    const rootDirs = files.filter(
      (f) => f.isDir && !f.path.includes("/")
    );

    const nodes: TreeNode[] = [];

    for (const dir of rootDirs) {
      const dirPrefix = dir.path + "/";
      const childFiles = files.filter(
        (f) => !f.isDir && f.path.startsWith(dirPrefix) && !f.path.slice(dirPrefix.length).includes("/")
          && !f.path.endsWith("/.folder")
      );
      const childDirs = files.filter(
        (f) => f.isDir && f.path.startsWith(dirPrefix) && f.path !== dir.path
      );
      nodes.push({
        id: `vdir-${dir.path}`,
        label: dir.path,
        icon: h(FolderIcon, null),
        virtualPath: dir.path,
        isVirtualDir: true,
        children: [
          ...childDirs.map((d) => ({
            id: `vdir-${d.path}`,
            label: d.path.split("/").pop() || d.path,
            icon: h(FolderIcon, null),
            virtualPath: d.path,
            isVirtualDir: true,
            children: files.filter(
              (f) => !f.isDir && f.path.startsWith(d.path + "/") && !f.path.endsWith("/.folder")
            ).map((f) => ({
              id: `vfile-${f.path}`,
              label: f.path.split("/").pop() || f.path,
              icon: h(FileIcon, { ext: f.extension }),
              detail: formatFileSize(f.size),
              virtualPath: f.path,
              action: () => handleFileClick(f.path),
            doubleClickAction: () => handleFileDoubleClick(f.path),
            })),
          })),
          ...childFiles.map((f) => ({
            id: `vfile-${f.path}`,
            label: f.path.split("/").pop() || f.path,
            icon: h(FileIcon, { ext: f.extension }),
            detail: formatFileSize(f.size),
            virtualPath: f.path,
            action: () => handleFileClick(f.path),
            doubleClickAction: () => handleFileDoubleClick(f.path),
          })),
        ],
      });
    }

    for (const f of rootFiles) {
      nodes.push({
        id: `vfile-${f.path}`,
        label: f.path,
        icon: h(FileIcon, { ext: f.extension }),
        detail: formatFileSize(f.size),
        virtualPath: f.path,
        action: () => handleFileClick(f.path),
            doubleClickAction: () => handleFileDoubleClick(f.path),
      });
    }

    return nodes;
  }

  // ---------- Build tree ----------
  const tree: TreeNode[] = [
    {
      id: "sheets",
      label: `Sheets (${sheets.length})`,
      icon: h(SheetsGroupIcon, null),
      bold: true,
      children: sheets.map((s) => ({
        id: `sheet-${s.index}`,
        label: s.name,
        icon: s.hidden ? h(HiddenSheetIcon, null) : h(SheetIcon, null),
        detail: s.hidden ? "hidden" : s.index === activeSheet ? "active" : undefined,
        action: () => handleNavigateSheet(s.index),
      })),
    },
  ];

  if (tables.length > 0) {
    tree.push({
      id: "tables",
      label: `Tables (${tables.length})`,
      icon: h(TablesGroupIcon, null),
      bold: true,
      children: tables.map((t) => ({
        id: `table-${t.id}`,
        label: t.name,
        icon: h(TableIcon, null),
        detail: `${t.columns.length} cols`,
      })),
    });
  }

  if (namedRanges.length > 0) {
    tree.push({
      id: "ranges",
      label: `Named Ranges (${namedRanges.length})`,
      icon: h(RangesGroupIcon, null),
      bold: true,
      children: namedRanges.map((r) => ({
        id: `range-${r.name}`,
        label: r.name,
        icon: h(NamedRangeIcon, null),
        detail: r.refersTo,
      })),
    });
  }

  const userFileNodes = buildFileTree(virtualFiles);
  const userFileCount = virtualFiles.filter((f) => !f.isDir && !f.path.endsWith("/.folder")).length;
  tree.push({
    id: "files",
    label: `Files${userFileCount > 0 ? ` (${userFileCount})` : ""}`,
    icon: h(FilesGroupIcon, null),
    bold: true,
    children: userFileNodes,
  });

  // Determine where inline creation input should appear
  const creatingInNodeId = creatingParent ? `vdir-${creatingParent}` : "files";

  return (
    <div style={styles.container} ref={containerRef}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <button style={styles.toolbarButton} onClick={() => startCreate("file")} title="New File">
          {h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "#555", strokeWidth: 1.5 },
            h("path", { d: "M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5l-3-3H3z" }),
            h("path", { d: "M10 2v3h3" }),
            h("line", { x1: 8, y1: 7.5, x2: 8, y2: 12.5 }),
            h("line", { x1: 5.5, y1: 10, x2: 10.5, y2: 10 }),
          )}
        </button>
        <button style={styles.toolbarButton} onClick={() => startCreate("folder")} title="New Folder">
          {h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "#555", strokeWidth: 1.5 },
            h("path", { d: "M2 5v7a1 1 0 001 1h10a1 1 0 001-1V7a1 1 0 00-1-1H8L6.5 4.5H3A1 1 0 002 5z" }),
            h("line", { x1: 8, y1: 8, x2: 8, y2: 12 }),
            h("line", { x1: 6, y1: 10, x2: 10, y2: 10 }),
          )}
        </button>
        <button style={styles.toolbarButton} onClick={refresh} title="Refresh">
          {h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "#555", strokeWidth: 1.5 },
            h("path", { d: "M14 2v5h-5" }),
            h("path", { d: "M13.5 10a6 6 0 11-1.5-6.5L14 7" }),
          )}
        </button>
        <button style={styles.toolbarButton} onClick={collapseAll} title="Collapse All">
          {h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "#555", strokeWidth: 1.5 },
            h("polyline", { points: "12,10 8,6 4,10" }),
            h("polyline", { points: "12,14 8,10 4,14" }),
          )}
        </button>
      </div>

      {/* Tree */}
      <div style={styles.treeContainer}>
        {tree.map((node) => (
          <TreeNodeItem
            key={node.id}
            node={node}
            depth={0}
            expandedNodes={expandedNodes}
            onToggle={toggleNode}
            selectedFile={previewFile}
            onContextMenu={showContextMenu}
            renamingNodeId={renamingNodeId}
            renamingName={renamingName}
            renameInputRef={renameInputRef}
            onRenamingNameChange={setRenamingName}
            onConfirmRename={confirmRename}
            onCancelRename={cancelRename}
            creatingType={creatingType}
            creatingInNodeId={creatingInNodeId}
            creatingName={creatingName}
            createInputRef={createInputRef}
            onCreatingNameChange={setCreatingName}
            onConfirmCreate={confirmCreate}
            onCancelCreate={cancelCreate}
            dragActive={!!dragState?.dragging}
            dragSourcePath={dragState?.sourcePath || null}
            dropTarget={dropTarget}
            onDragMouseDown={handleDragMouseDown}
          />
        ))}
      </div>

      {/* File Preview / Editor */}
      {previewFile && (() => {
        const previewExt = previewFile.includes(".")
          ? previewFile.split(".").pop()?.toLowerCase() || ""
          : "";
        const viewMode = getViewMode(previewExt);
        return (
          <div style={styles.previewContainer}>
            <div style={styles.previewHeader}>
              <span style={styles.previewTitle}>
                {previewFile}
              </span>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button
                  style={styles.previewToggle}
                  onClick={() => openInTaskPane(previewFile)}
                  title="Open in editor (double-click)"
                >
                  Edit
                </button>
                <button
                  style={styles.previewClose}
                  onClick={() => {
                    setPreviewFile(null);
                    setPreviewContent("");
                  }}
                  title="Close"
                >
                  x
                </button>
              </div>
            </div>
            <div style={styles.previewContent}>
              {previewLoading ? (
                <span style={styles.previewLoading}>Loading...</span>
              ) : viewMode === "markdown" && previewContent.trim().length > 0 ? (
                <div style={styles.previewRendered}>
                  <MarkdownView content={previewContent} />
                </div>
              ) : (
                <pre style={styles.previewPre}>{previewContent || <span style={styles.previewLoading}>Empty file</span>}</pre>
              )}
            </div>
          </div>
        );
      })()}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}

// ============================================================================
// Tree Node Component
// ============================================================================

function TreeNodeItem({
  node,
  depth,
  expandedNodes,
  onToggle,
  selectedFile,
  onContextMenu,
  renamingNodeId,
  renamingName,
  renameInputRef,
  onRenamingNameChange,
  onConfirmRename,
  onCancelRename,
  creatingType,
  creatingInNodeId,
  creatingName,
  createInputRef,
  onCreatingNameChange,
  onConfirmCreate,
  onCancelCreate,
  dragActive,
  dragSourcePath,
  dropTarget,
  onDragMouseDown,
}: {
  node: TreeNode;
  depth: number;
  expandedNodes: Set<string>;
  onToggle: (id: string) => void;
  selectedFile: string | null;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  renamingNodeId: string | null;
  renamingName: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onRenamingNameChange: (name: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  creatingType: "file" | "folder" | null;
  creatingInNodeId: string;
  creatingName: string;
  createInputRef: React.RefObject<HTMLInputElement | null>;
  onCreatingNameChange: (name: string) => void;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;
  dragActive: boolean;
  dragSourcePath: string | null;
  dropTarget: string | null;
  onDragMouseDown: (e: React.MouseEvent, virtualPath: string, nodeId: string) => void;
}): React.ReactElement {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedNodes.has(node.id);
  const [isHovered, setIsHovered] = useState(false);
  const isSelected = selectedFile && node.id === `vfile-${selectedFile}`;
  const isRenaming = renamingNodeId === node.id;

  // For inline creation: should the input appear after this node's children?
  const showCreateInput = creatingType && creatingInNodeId === node.id && expandedNodes.has(node.id);

  // Drag-and-drop state for this node
  const isDraggable = !!node.virtualPath;
  const isDropTarget = dropTarget === node.id;
  const isDragging = dragActive && dragSourcePath === node.virtualPath;
  // Any node in the virtual files section can accept drops
  const isInFilesSection = node.id === "files" || !!node.virtualPath;
  const isFolder = node.id === "files" || node.isVirtualDir;

  const handleClick = () => {
    if (hasChildren) {
      onToggle(node.id);
    }
    if (node.action) {
      node.action();
    }
  };

  const handleDoubleClick = () => {
    if (node.doubleClickAction) {
      node.doubleClickAction();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu(e, node);
  };

  // Determine drop target path:
  // - "files" root: null (root level)
  // - folder: its virtualPath (drop INTO the folder)
  // - file: its parent folder path (drop alongside the file)
  const getDropTargetPath = (): string | null => {
    if (node.id === "files") return null;
    if (node.isVirtualDir) return node.virtualPath || null;
    // File: extract parent folder from virtualPath
    if (node.virtualPath) {
      const lastSlash = node.virtualPath.lastIndexOf("/");
      return lastSlash >= 0 ? node.virtualPath.substring(0, lastSlash) : null;
    }
    return null;
  };

  return (
    <>
      <div
        data-drop-node-id={isInFilesSection ? node.id : undefined}
        data-drop-target-path={isInFilesSection ? (getDropTargetPath() || "") : undefined}
        style={{
          ...styles.treeItem,
          paddingLeft: 8 + depth * 16,
          backgroundColor: isDropTarget && isInFilesSection && isFolder
            ? "rgba(25, 118, 210, 0.15)"
            : isDropTarget && isInFilesSection && !isFolder
            ? "#e3f2fd"
            : isSelected ? "#e3f2fd" : isHovered ? "#eaeaea" : "transparent",
          fontWeight: node.bold ? 600 : 400,
          opacity: isDragging ? 0.4 : 1,
          outline: isDropTarget && isInFilesSection && isFolder ? "1px dashed #1976d2" : "none",
          outlineOffset: -1,
          borderTop: isDropTarget && !isFolder ? "2px solid #1976d2" : "2px solid transparent",
          borderBottom: "2px solid transparent",
          cursor: isDragging ? "grabbing" : "pointer",
          userSelect: "none",
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onMouseDown={isDraggable && !isRenaming
          ? (e) => onDragMouseDown(e, node.virtualPath!, node.id)
          : undefined}
      >
        {hasChildren || (node.isVirtualDir && node.children) ? (
          <span style={styles.chevron}>
            {h("svg", {
              width: 10, height: 10, viewBox: "0 0 10 10",
              fill: "#888", stroke: "none",
              style: { transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.1s" },
            },
              h("polygon", { points: "2,1 8,5 2,9" })
            )}
          </span>
        ) : (
          <span style={styles.chevronSpacer} />
        )}

        {node.icon && <span style={styles.iconWrapper}>{node.icon}</span>}

        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={renamingName}
            onChange={(e) => onRenamingNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConfirmRename();
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={onConfirmRename}
            onClick={(e) => e.stopPropagation()}
            style={styles.createInput}
          />
        ) : (
          <>
            <span style={styles.label}>{node.label}</span>
            {node.detail && <span style={styles.detail}>{node.detail}</span>}
          </>
        )}
      </div>

      {/* Children */}
      {(hasChildren || (node.isVirtualDir && node.children)) && isExpanded &&
        node.children!.map((child) => (
          <TreeNodeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            expandedNodes={expandedNodes}
            onToggle={onToggle}
            selectedFile={selectedFile}
            onContextMenu={onContextMenu}
            renamingNodeId={renamingNodeId}
            renamingName={renamingName}
            renameInputRef={renameInputRef}
            onRenamingNameChange={onRenamingNameChange}
            onConfirmRename={onConfirmRename}
            onCancelRename={onCancelRename}
            creatingType={creatingType}
            creatingInNodeId={creatingInNodeId}
            creatingName={creatingName}
            createInputRef={createInputRef}
            onCreatingNameChange={onCreatingNameChange}
            onConfirmCreate={onConfirmCreate}
            onCancelCreate={onCancelCreate}
            dragActive={dragActive}
            dragSourcePath={dragSourcePath}
            dropTarget={dropTarget}
            onDragMouseDown={onDragMouseDown}
          />
        ))}

      {/* Inline creation input */}
      {showCreateInput && (
        <div style={{ ...styles.treeItem, paddingLeft: 8 + (depth + 1) * 16, gap: 4 }}>
          <span style={styles.chevronSpacer} />
          <span style={styles.iconWrapper}>
            {creatingType === "folder"
              ? h(FolderIcon, null)
              : h(FilesGroupIcon, null)
            }
          </span>
          <input
            ref={createInputRef}
            type="text"
            value={creatingName}
            onChange={(e) => onCreatingNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConfirmCreate();
              if (e.key === "Escape") onCancelCreate();
            }}
            onBlur={onConfirmCreate}
            onClick={(e) => e.stopPropagation()}
            placeholder={creatingType === "file" ? "filename.txt" : "folder name"}
            style={styles.createInput}
          />
        </div>
      )}
    </>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
    position: "relative",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: "4px 8px",
    gap: 2,
    borderBottom: "1px solid #e0e0e0",
    flexShrink: 0,
  },
  toolbarButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 22,
    padding: 0,
    border: "1px solid transparent",
    borderRadius: 3,
    background: "transparent",
    cursor: "pointer",
    opacity: 0.7,
    position: "relative" as const,
    zIndex: 1,
    pointerEvents: "auto" as const,
  },
  createInput: {
    flex: 1,
    minWidth: 0,
    height: 18,
    fontSize: 12,
    padding: "0 4px",
    border: "1px solid #007acc",
    borderRadius: 2,
    outline: "none",
    fontFamily: "inherit",
    background: "#1e1e1e",
    color: "#cccccc",
  },
  treeContainer: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "4px 0",
  },
  treeItem: {
    display: "flex",
    alignItems: "center",
    height: 24,
    cursor: "pointer",
    userSelect: "none" as const,
    fontSize: 12,
    color: "#333",
    gap: 4,
    overflow: "hidden",
  },
  chevron: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 14,
    flexShrink: 0,
  },
  chevronSpacer: {
    width: 14,
    flexShrink: 0,
  },
  iconWrapper: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    flexShrink: 0,
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flex: 1,
  },
  detail: {
    color: "#999",
    fontSize: 10,
    marginLeft: 4,
    marginRight: 8,
    flexShrink: 0,
  },
  previewContainer: {
    display: "flex",
    flexDirection: "column",
    borderTop: "1px solid #d0d0d0",
    maxHeight: "50%",
    minHeight: 100,
    flexShrink: 0,
  },
  previewHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 8px",
    backgroundColor: "#eef1f5",
    borderBottom: "1px solid #e0e0e0",
    flexShrink: 0,
  },
  previewTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "#444",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  previewClose: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    height: 18,
    padding: 0,
    border: "none",
    borderRadius: 3,
    background: "transparent",
    color: "#666",
    fontSize: 12,
    cursor: "pointer",
  },
  previewContent: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 10px",
    backgroundColor: "#ffffff",
  },
  previewPre: {
    margin: 0,
    fontSize: 11,
    lineHeight: "1.5",
    color: "#333",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
  },
  previewToggle: {
    fontSize: 10,
    fontWeight: 500,
    color: "#555",
    backgroundColor: "#e8e8e8",
    border: "none",
    borderRadius: 3,
    padding: "2px 8px",
    cursor: "pointer",
  },
  previewRendered: {
    padding: "4px 0",
    overflow: "auto",
    height: "100%",
  },
  previewLoading: {
    fontSize: 11,
    color: "#999",
    fontStyle: "italic" as const,
  },
};
