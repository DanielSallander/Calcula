// FILENAME: app/extensions/ModelEditor/components/sections/MeasuresSection.tsx
// PURPOSE: Measures section of the Model Editor window: list the model's
//          measures — organised into nested folders (Studio-style measure
//          groups, "\"-delimited display-folder paths) — with lineage for the
//          selection, and add/edit/delete/move them through the Monaco measure
//          modal, drag-and-drop, and a context menu.

import React, { useEffect, useMemo, useState, useRef } from "react";
import {
  biModelDeleteMeasure,
  biModelMeasureLineage,
  biModelUpsertMeasure,
} from "@api";
import type { MeasureLineage, ModelMeasureInfo } from "@api";
import { testMeasureInNotebook } from "../../lib/notebookBridge";
import { SELECTION_BG, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import {
  buildFolderTree,
  folderDepth,
  folderPathsWithAncestors,
  normalizeFolderPath,
  splitFolderPath,
  type FolderNode,
} from "../../lib/measureFolders";
import { Chevron, FolderIcon, TREE_INDENT, treeStyles } from "../treeKit";
import { buildSetCommand } from "../../lib/bulkEdit";
import { MeasureEditorModal } from "./MeasureEditorModal";
import { MeasureInspector } from "./MeasureInspector";
import { confirmAsync, promptAsync } from "@api/dialogs";
import { ME } from "../theme";

/** dragOver sentinel for the "Ungrouped" drop zone (a NUL can't be in a path). */
const UNGROUPED = "\u0000ungrouped";
/** MIME type carried while dragging a measure row. */
const DRAG_TYPE = "application/x-measure-name";

export function MeasuresSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyMeasures, reportError } = ctx;
  const measures = overview.measures;

  const [selected, setSelected] = useState<string | null>(null);
  // Honour a route selection on ARRIVAL (Ctrl+K, an Xref, a restored hash),
  // once per requested name — a route that re-asserted itself on every render
  // would snap the tree back every time the user clicked something else.
  const honouredSelection = useRef<string | null>(null);
  if (ctx.selection && ctx.selection !== honouredSelection.current) {
    honouredSelection.current = ctx.selection;
    if (measures.some((m) => m.name === ctx.selection)) setSelected(ctx.selection);
  }
  const [lineage, setLineage] = useState<MeasureLineage | null>(null);
  const [editing, setEditing] = useState<{ measure: ModelMeasureInfo | null } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Folders the user created this session that hold no measure yet — view-only
  // until a measure is dropped in (empty folders can't persist in the model).
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    measure: ModelMeasureInfo;
  } | null>(null);

  // Reset per-connection UI when the connection changes, and clear the lineage
  // when the selection changes — done during render (React's "adjust state on
  // prop change" pattern) rather than in an effect.
  const [prevConn, setPrevConn] = useState(connectionId);
  if (prevConn !== connectionId) {
    setPrevConn(connectionId);
    setSelected(null);
    setEditing(null);
    setExtraFolders([]);
    setMenu(null);
    setLineage(null);
  }
  const [prevSelected, setPrevSelected] = useState<string | null>(selected);
  if (prevSelected !== selected) {
    setPrevSelected(selected);
    setLineage(null);
  }

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const selectedMeasure = measures.find((m) => m.name === selected);

  useEffect(() => {
    // The clear-on-change is handled above during render; here we only fetch.
    if (!selected || !connectionId || !measures.some((m) => m.name === selected)) {
      return;
    }
    let cancelled = false;
    void biModelMeasureLineage(connectionId, selected)
      .then((l) => {
        if (!cancelled) setLineage(l);
      })
      .catch(() => {
        if (!cancelled) setLineage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, connectionId, measures]);

  // Nested folder tree + the flat list of every folder path (incl. ancestors).
  const { roots, ungrouped } = useMemo(
    () => buildFolderTree(measures, extraFolders),
    [measures, extraFolders],
  );
  const allFolderPaths = useMemo(
    () => folderPathsWithAncestors([...measures.map((m) => m.group), ...extraFolders]),
    [measures, extraFolders],
  );
  const hasFolders = allFolderPaths.length > 0;

  const handleDelete = async (m: ModelMeasureInfo): Promise<void> => {
    if (!(await confirmAsync(`Delete measure '${m.name}' from the model?`))) return;
    try {
      applyMeasures(await biModelDeleteMeasure(connectionId, m.name));
      if (selected === m.name) setSelected(null);
    } catch (err: unknown) {
      reportError(err);
    }
  };

  // Move a measure into `folder` (null = ungrouped) by re-saving it with the new
  // group. Passing the measure's own formula re-installs it unchanged: a source
  // measure re-parses identically; a sourceless one keeps its stored expression.
  // EVERY other attribute must ride along — anything omitted here is erased by
  // the re-save.
  const setMeasureGroup = async (
    m: ModelMeasureInfo,
    folder: string | null,
  ): Promise<void> => {
    const current = m.group ? normalizeFolderPath(m.group) : null;
    const next = folder ? normalizeFolderPath(folder) || null : null;
    if (current === next) return;
    try {
      applyMeasures(
        await biModelUpsertMeasure({
          connectionId,
          originalName: m.name,
          name: m.name,
          formula: m.formula,
          description: m.description,
          formatString: m.formatString,
          formatStringExpression: m.formatStringExpression,
          detailRows: m.detailRows,
          group: next,
        }),
      );
    } catch (err: unknown) {
      reportError(err);
    }
  };

  const createFolder = async (): Promise<void> => {
    const raw = (
      await promptAsync("New folder name (use \\ for nested folders):", {
        title: "New display folder",
      })
    )?.trim();
    if (!raw) return;
    const path = normalizeFolderPath(raw);
    if (!path) return;
    // Case-insensitive so "Sales" and "sales" don't fragment into two folders.
    if (allFolderPaths.some((f) => f.toLowerCase() === path.toLowerCase())) {
      reportError(`A folder named '${path}' already exists.`);
      return;
    }
    setExtraFolders((prev) => [...prev, path]);
    setCollapsed((prev) => {
      const next = new Set(prev);
      // Reveal the new folder and all of its ancestors.
      const segs = splitFolderPath(path);
      for (let i = 0; i < segs.length; i++) next.delete(segs.slice(0, i + 1).join("\\"));
      return next;
    });
  };

  const moveToNewFolder = async (m: ModelMeasureInfo): Promise<void> => {
    const raw = (
      await promptAsync("Move to new folder (use \\ for nested folders):", {
        title: "Move measure",
      })
    )?.trim();
    if (!raw) return;
    const path = normalizeFolderPath(raw);
    if (path) void setMeasureGroup(m, path);
  };

  const toggleCollapse = (folder: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  // Idempotent (unlike toggle) — dragOver fires repeatedly, and two events in
  // one React batch would otherwise toggle twice and re-collapse the folder.
  const expandFolder = (folder: string): void =>
    setCollapsed((prev) => {
      if (!prev.has(folder)) return prev;
      const next = new Set(prev);
      next.delete(folder);
      return next;
    });

  const onRowDragStart = (e: React.DragEvent, m: ModelMeasureInfo): void => {
    e.dataTransfer.setData(DRAG_TYPE, m.name);
    e.dataTransfer.effectAllowed = "move";
  };

  const onZoneDragOver = (e: React.DragEvent, key: string): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOver !== key) setDragOver(key);
  };

  // Only clear the highlight when the pointer truly leaves the zone — a leave
  // event that just crosses into a child row (relatedTarget still inside) is
  // ignored, so the drop target stays lit while hovering the folder's rows.
  const onZoneDragLeave = (e: React.DragEvent, key: string): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver((k) => (k === key ? null : k));
  };

  const onZoneDrop = (e: React.DragEvent, folder: string | null): void => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const name = e.dataTransfer.getData(DRAG_TYPE);
    const m = measures.find((x) => x.name === name);
    if (m) void setMeasureGroup(m, folder);
  };

  // Compact single-line row: kind glyph + name + muted home table. The formula
  // lives in the tooltip (title) instead of a second line.
  const renderRow = (m: ModelMeasureInfo, indentPx: number): React.ReactElement => (
    <div
      key={m.name}
      draggable={!readOnly}
      onDragStart={(e) => onRowDragStart(e, m)}
      style={{
        ...treeStyles.leafRow,
        paddingLeft: indentPx,
        cursor: readOnly ? "pointer" : "grab",
        background: m.name === selected ? SELECTION_BG : undefined,
      }}
      onClick={() => setSelected(m.name)}
      onDoubleClick={() => {
        if (!readOnly) setEditing({ measure: m });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // No mutating actions on a read-only (package-subscribed) model.
        if (readOnly) return;
        setSelected(m.name);
        setMenu({ x: e.clientX, y: e.clientY, measure: m });
      }}
      title={m.formula}
    >
      <span style={{ color: ME.calculatedHue, flexShrink: 0, fontSize: 11 }}>∑</span>
      <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
        {m.name}
      </span>
      {/* No home-table suffix: a measure's inferred table is an engine detail
          (validation/rendering context), not something a measure "belongs" to
          — the inspector's lineage shows what it actually touches. */}
      {m.isHidden && (
        <span style={{ ...styles.muted, fontSize: 12, flexShrink: 0 }}>(hidden)</span>
      )}
    </div>
  );

  // Recursive folder block. The drop zone wraps the header + this folder's own
  // measures; sub-folders are rendered as siblings (their own drop zones), so a
  // drop resolves to the deepest folder under the pointer.
  const renderFolderNode = (node: FolderNode, depth: number): React.ReactElement => {
    const isOpen = !collapsed.has(node.path);
    const isTarget = dragOver === node.path;
    const headerPad = 6 + depth * TREE_INDENT;
    const isEmpty = node.measures.length === 0 && node.children.length === 0;
    return (
      <div key={node.path}>
        <div
          onDragOver={(e) => {
            onZoneDragOver(e, node.path);
            // Reveal a collapsed folder mid-drag so its rows and subfolders
            // become drop targets without interrupting the drag.
            expandFolder(node.path);
          }}
          onDragLeave={(e) => onZoneDragLeave(e, node.path)}
          onDrop={(e) => onZoneDrop(e, node.path)}
          style={{
            borderRadius: 3,
            border: isTarget ? `1px dashed ${ME.accent}` : "1px solid transparent",
            background: isTarget ? ME.accentSoft : undefined,
          }}
        >
          <div
            onClick={() => toggleCollapse(node.path)}
            title="Drag measures here to file them in this folder"
            style={{ ...treeStyles.folderRow, paddingLeft: headerPad }}
          >
            <Chevron open={isOpen} />
            <span style={{ color: ME.text2, display: "flex", alignItems: "center" }}>
              <FolderIcon />
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {node.name}
            </span>
            <span style={{ ...styles.muted, marginLeft: "auto", fontSize: 11 }}>
              {node.measures.length}
            </span>
          </div>
          {isOpen && node.measures.map((m) => renderRow(m, headerPad + 18))}
          {isOpen && isEmpty && (
            <div
              style={{ ...styles.muted, padding: "2px 6px", paddingLeft: headerPad + 18, fontSize: 12 }}
            >
              (empty — drag measures here)
            </div>
          )}
        </div>
        {isOpen && node.children.map((c) => renderFolderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Measures ({measures.length})</span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ measure: null })}>
          New
        </button>
        <button style={styles.btn} disabled={readOnly} onClick={() => void createFolder()}>
          New Folder
        </button>
        <button
          style={styles.btn}
          disabled={readOnly || !selectedMeasure}
          onClick={() => selectedMeasure && setEditing({ measure: selectedMeasure })}
        >
          Edit
        </button>
        <button
          style={styles.btn}
          disabled={readOnly || !selectedMeasure}
          onClick={() => selectedMeasure && void handleDelete(selectedMeasure)}
        >
          Delete
        </button>
        {/* Read-only, so it stays enabled on package-subscribed models too:
            it validates and QUERIES, it never writes. */}
        <button
          style={styles.btn}
          disabled={!selectedMeasure}
          title="Open this measure in the notebook — read-only, nothing is applied to the model"
          onClick={() =>
            selectedMeasure &&
            void testMeasureInNotebook({
              connectionId,
              name: selectedMeasure.name,
              formula: selectedMeasure.formula,
              existing: selectedMeasure,
              knownMeasures: measures,
            }).catch(reportError)
          }
        >
          Test in notebook
        </button>
      </div>

      {/* Tree + quick-inspect pane. A single click selects a measure and its
          full property set appears (and is editable) in the side pane. */}
      <div style={{ display: "flex", gap: 10, flex: 1, minHeight: 0 }}>
        <div style={{ ...styles.card, flex: 1, minWidth: 0, overflowY: "auto", padding: 4 }}>
          {measures.length === 0 && !hasFolders && (
            <div style={{ ...styles.muted, padding: 8 }}>
              This model has no measures yet — create one with New.
            </div>
          )}

          {roots.map((node) => renderFolderNode(node, 0))}

          {hasFolders && (
            <div
              onDragOver={(e) => onZoneDragOver(e, UNGROUPED)}
              onDragLeave={(e) => onZoneDragLeave(e, UNGROUPED)}
              onDrop={(e) => onZoneDrop(e, null)}
              style={{
                marginTop: 4,
                borderRadius: 3,
                border: dragOver === UNGROUPED ? `1px dashed ${ME.accent}` : "1px solid transparent",
                background: dragOver === UNGROUPED ? ME.accentSoft : undefined,
              }}
            >
              <div
                title="Drag measures here to remove them from their folder"
                style={{ padding: "3px 6px", fontWeight: 600, fontSize: 12, color: ME.text2 }}
              >
                Ungrouped
              </div>
              {ungrouped.length > 0 ? (
                ungrouped.map((m) => renderRow(m, 24))
              ) : (
                <div style={{ ...styles.muted, padding: "2px 6px 2px 24px", fontSize: 12 }}>
                  (none — drag measures here)
                </div>
              )}
            </div>
          )}
          {!hasFolders && ungrouped.map((m) => renderRow(m, 6))}
        </div>

        {selectedMeasure && (
          <MeasureInspector
            key={selectedMeasure.name}
            connectionId={connectionId}
            measure={selectedMeasure}
            lineage={lineage}
            folders={allFolderPaths}
            readOnly={readOnly}
            onApply={(list, newName) => {
              applyMeasures(list);
              if (newName) setSelected(newName);
            }}
            onEditFormula={() => setEditing({ measure: selectedMeasure })}
            onEvaluate={() => ctx.navigate("testing", selectedMeasure.name)}
            onCopyAsCommand={() => {
              // The GUI already knows the grammar; a user should not have to
              // read a 31-topic reference to learn it.
              const cmd = buildSetCommand("measure", selectedMeasure.name, {
                format: selectedMeasure.formatString ?? "",
                folder: selectedMeasure.group ?? "",
                hidden: selectedMeasure.isHidden,
              });
              if (cmd) void navigator.clipboard?.writeText(cmd).catch(() => {});
            }}
            reportError={reportError}
          />
        )}
      </div>

      {menu && (
        <MeasureContextMenu
          menu={menu}
          folders={allFolderPaths}
          onEdit={() => {
            setEditing({ measure: menu.measure });
            setMenu(null);
          }}
          onDelete={() => {
            void handleDelete(menu.measure);
            setMenu(null);
          }}
          onMoveTo={(folder) => {
            void setMeasureGroup(menu.measure, folder);
            setMenu(null);
          }}
          onNewFolder={() => {
            void moveToNewFolder(menu.measure);
            setMenu(null);
          }}
        />
      )}

      {editing && (
        <MeasureEditorModal
          connectionId={connectionId}
          existing={editing.measure}
          overview={overview}
          onClose={() => setEditing(null)}
          onSaved={(list) => {
            applyMeasures(list);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** Right-click menu for a measure: edit, delete, or move to a (nested) folder. */
function MeasureContextMenu({
  menu,
  folders,
  onEdit,
  onDelete,
  onMoveTo,
  onNewFolder,
}: {
  menu: { x: number; y: number; measure: ModelMeasureInfo };
  folders: string[];
  onEdit: () => void;
  onDelete: () => void;
  onMoveTo: (folder: string | null) => void;
  onNewFolder: () => void;
}): React.ReactElement {
  const current = menu.measure.group ? normalizeFolderPath(menu.measure.group) : null;
  const item: React.CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "5px 12px",
    border: "none",
    background: "transparent",
    color: ME.text,
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
  };
  const heading: React.CSSProperties = {
    padding: "5px 12px 2px",
    fontSize: 11,
    fontWeight: 600,
    color: ME.text3,
  };
  const hr: React.CSSProperties = { height: 1, background: ME.borderSubtle, margin: "3px 0" };
  return (
    <div
      // The measure list's own overflow would clip a menu near the bottom, so
      // this is fixed-positioned at the pointer. Clicks close it (window listener).
      style={{
        position: "fixed",
        top: menu.y,
        left: menu.x,
        zIndex: 1000,
        minWidth: 200,
        maxHeight: 360,
        overflowY: "auto",
        background: ME.surface,
        border: `1px solid ${ME.ctlBorder}`,
        borderRadius: 4,
        boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
        padding: "4px 0",
      }}
    >
      <button style={item} onClick={onEdit}>
        Edit…
      </button>
      <button style={{ ...item, color: ME.dangerFg }} onClick={onDelete}>
        Delete
      </button>
      <div style={hr} />
      <div style={heading}>Move to folder</div>
      <button
        style={{ ...item, opacity: current === null ? 0.5 : 1 }}
        disabled={current === null}
        onClick={() => onMoveTo(null)}
      >
        (No folder)
      </button>
      {folders.map((f) => {
        const name = splitFolderPath(f).slice(-1)[0];
        return (
          <button
            key={f}
            style={{ ...item, paddingLeft: 12 + folderDepth(f) * 14, opacity: current === f ? 0.5 : 1 }}
            disabled={current === f}
            title={f}
            onClick={() => onMoveTo(f)}
          >
            {current === f ? `✓ ${name}` : name}
          </button>
        );
      })}
      <button style={{ ...item, fontStyle: "italic" }} onClick={onNewFolder}>
        New folder…
      </button>
    </div>
  );
}
