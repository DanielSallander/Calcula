//! FILENAME: app/extensions/CanvasSheet/components/CanvasElementsSection.tsx
// PURPOSE: The Canvas tab's ELEMENTS group (Power BI's Insert > Elements):
//          Text Box, Buttons v, Shapes v, Image, and Calcula's Floating Grid --
//          five heroes in one tall row.
// CONTEXT: BUTTONS and SHAPES are Excel's large SPLIT buttons: the picture
//          inserts the everyday one (a blank button, a rectangle), the label
//          and chevron open Power BI's menu. The face keeps the old Insert id
//          (`canvas-insert-button`, `canvas-insert-shape`: live E2E specs press
//          them and expect exactly that object); the chevron is the contract's
//          `canvas-buttons` / `canvas-shapes`.
//
//          BUTTONS v -- Blank (a script button, today's), Run Macro... (the
//          existing macroRef flow: Developer > Macros links a macro to a new
//          button), then Power BI's action buttons: Page Navigator, Back, Clear
//          All Slicers. The actions are DECLARATIVE properties
//          (@api/buttonControlService), never code, so they work with Script
//          Security off and on a subscribed page, and survive a pull.
//
//          SHAPES v -- "Basic shapes" and "Arrows" in Power BI's order and
//          words, each row pictured from the shape catalog's OWN geometry, then
//          More Shapes > every catalog shape by category. A pick inserts that
//          shape at the catalog's size (lib/insertOnCanvas.ts).
//
//          The menus' contents are read when a menu OPENS (small components
//          rendered inside it): the catalog and the macro library belong to
//          other extensions, which may activate after this tab first renders.
//
//          A SUBSCRIBED canvas is the publisher's layout: every insert here is
//          disabled with the one note every Canvas group shows.

import React from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  ActionRow,
  CommandButton,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  MENU_ICON_BLANK,
  MenuHeading,
  MenuItem,
  MenuSeparator,
  MenuSub,
  SplitMenuButton,
  useSurfaceLayout,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { getControlsProvider, type ShapeCatalogEntry } from "@api/controlsService";
import { insertOnCanvas } from "../lib/insertOnCanvas";
import { insertPageNavigator } from "../lib/pageNavigator";
import {
  ARROW_SHAPE_ROWS,
  BASIC_SHAPE_ROWS,
  canOpenMacroLibrary,
  openMacroLibrary,
  type ShapeMenuRow,
} from "../lib/canvasElements";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import { ShapeThumbnail } from "./tabParts";
import { useCanvasSheet } from "./canvasHooks";

/** A menu row's picture size (the Home tab's MENU_ROW_ICON_SIZE). */
const ROW_ICON = 20;

/** The shape catalog as the Controls extension lists it now ([] without one). */
function currentShapeCatalog(): ShapeCatalogEntry[] {
  try {
    return getControlsProvider()?.listShapeCatalog() ?? [];
  } catch (err) {
    console.error("[CanvasSheet] the shape catalog could not be read:", err);
    return [];
  }
}

// ============================================================================
// Buttons v
// ============================================================================

/** Run Macro...: live only while a macro library is there to open. */
function RunMacroRow(): React.ReactElement {
  const available = canOpenMacroLibrary();
  return (
    <MenuItem
      icon={<RibbonIcon.Play size={ROW_ICON} />}
      disabled={!available}
      hint={available ? undefined : "needs the Macro Recorder"}
      testId="canvas-buttons-macro"
      onSelect={() => {
        openMacroLibrary().catch((err: unknown) => console.error("[CanvasSheet] Run Macro... failed:", err));
      }}
    >
      Run Macro...
    </MenuItem>
  );
}

function ButtonsMenuRows(): React.ReactElement {
  return (
    <>
      <MenuItem
        icon={<RibbonIcon.ButtonControl size={ROW_ICON} />}
        testId="canvas-buttons-blank"
        onSelect={() => void insertOnCanvas("button", { button: "blank" })}
      >
        Blank
      </MenuItem>
      <RunMacroRow />
      <MenuSeparator />
      <MenuItem
        icon={<RibbonIcon.PageNavigator size={ROW_ICON} />}
        testId="canvas-buttons-pageNavigator"
        onSelect={() => void insertPageNavigator()}
      >
        Page Navigator
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.NavigateBack size={ROW_ICON} />}
        testId="canvas-buttons-back"
        onSelect={() => void insertOnCanvas("button", { button: "back" })}
      >
        Back
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.ClearSlicers size={ROW_ICON} />}
        testId="canvas-buttons-clearSlicers"
        onSelect={() => void insertOnCanvas("button", { button: "clearSlicers" })}
      >
        Clear All Slicers
      </MenuItem>
    </>
  );
}

// ============================================================================
// Shapes v
// ============================================================================

const insertShape = (id: string): void => void insertOnCanvas("shape", { shapeId: id });

/** One headed group of Power BI's rows, the ones the catalog holds. */
function shapeRows(rows: readonly ShapeMenuRow[], byId: ReadonlyMap<string, ShapeCatalogEntry>): React.ReactElement[] {
  return rows
    .filter((row) => byId.has(row.id))
    .map((row) => {
      const entry = byId.get(row.id)!;
      return (
        <MenuItem
          key={row.id}
          icon={entry.thumbnail ? <ShapeThumbnail entry={entry} /> : MENU_ICON_BLANK}
          testId={`canvas-shapes-${row.id}`}
          onSelect={() => insertShape(row.id)}
        >
          {row.label}
        </MenuItem>
      );
    });
}

/** The whole catalog by category, in the catalog's own order. */
function moreShapesByCategory(catalog: readonly ShapeCatalogEntry[]): React.ReactElement[] {
  const categories: Array<{ id: string; label: string; entries: ShapeCatalogEntry[] }> = [];
  const byCategory = new Map<string, { id: string; label: string; entries: ShapeCatalogEntry[] }>();
  for (const e of catalog) {
    let c = byCategory.get(e.categoryId);
    if (!c) {
      c = { id: e.categoryId, label: e.categoryLabel, entries: [] };
      byCategory.set(e.categoryId, c);
      categories.push(c);
    }
    c.entries.push(e);
  }
  return categories.map((c) => (
    <MenuSub key={c.id} label={c.label} icon={MENU_ICON_BLANK} testId={`canvas-shapes-more-category-${c.id}`}>
      {c.entries.map((e) => (
        <MenuItem
          key={e.id}
          icon={e.thumbnail ? <ShapeThumbnail entry={e} /> : MENU_ICON_BLANK}
          testId={`canvas-shapes-more-${e.id}`}
          onSelect={() => insertShape(e.id)}
        >
          {e.label}
        </MenuItem>
      ))}
    </MenuSub>
  ));
}

function ShapesMenuRows(): React.ReactElement {
  const catalog = currentShapeCatalog();
  const byId = new Map(catalog.map((e) => [e.id, e]));
  const basic = shapeRows(BASIC_SHAPE_ROWS, byId);
  const arrows = shapeRows(ARROW_SHAPE_ROWS, byId);
  return (
    <>
      {basic.length > 0 && <MenuHeading>Basic shapes</MenuHeading>}
      {basic}
      {arrows.length > 0 && <MenuHeading>Arrows</MenuHeading>}
      {arrows}
      {catalog.length > 0 && <MenuSeparator />}
      {catalog.length > 0 && (
        <MenuSub label="More Shapes" icon={MENU_ICON_BLANK} testId="canvas-shapes-more">
          {moreShapesByCategory(catalog)}
        </MenuSub>
      )}
    </>
  );
}

// ============================================================================
// The group
// ============================================================================

export function CanvasElementsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { active, activeSubscribed } = useCanvasSheet();
  const band = useSurfaceLayout().container === "band";
  if (!active) return null;
  const subscribed = activeSubscribed;
  const tip = (why: string): string => (subscribed ? SUBSCRIBED_NOTE : why);
  const heroIcon = band ? HERO_ICON_SIZE : ICON_SIZE_SM;
  const face = band ? "hero" : "labelled";

  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Text size={HERO_ICON_SIZE} />}
        label="Text Box"
        disabled={subscribed}
        tooltip={tip("Insert a text box")}
        data-testid="canvas-insert-textBox"
        onClick={() => void insertOnCanvas("textBox")}
      />
      <SplitMenuButton
        face={face}
        icon={<RibbonIcon.ButtonControl size={heroIcon} />}
        label="Buttons"
        disabled={subscribed}
        tooltip={tip("Insert a blank button that can run a script")}
        chevronLabel="Buttons: blank, macro, page navigation, back, clear all slicers"
        menuLabel="Buttons"
        data-testid="canvas-insert-button"
        chevronTestId="canvas-buttons"
        onClick={() => void insertOnCanvas("button", { button: "blank" })}
      >
        <ButtonsMenuRows />
      </SplitMenuButton>
      <SplitMenuButton
        face={face}
        icon={<RibbonIcon.Shapes size={heroIcon} />}
        label="Shapes"
        disabled={subscribed}
        tooltip={tip("Insert a rectangle you can restyle")}
        chevronLabel="Shapes: choose a shape"
        menuLabel="Shapes"
        data-testid="canvas-insert-shape"
        chevronTestId="canvas-shapes"
        onClick={() => insertShape("rectangle")}
      >
        <ShapesMenuRows />
      </SplitMenuButton>
      <CommandButton
        icon={<RibbonIcon.Image size={HERO_ICON_SIZE} />}
        label="Image"
        disabled={subscribed}
        tooltip={tip("Insert a picture from a file")}
        data-testid="canvas-insert-picture"
        onClick={() => void insertOnCanvas("picture")}
      />
      <CommandButton
        icon={<RibbonIcon.FloatingGrid size={HERO_ICON_SIZE} />}
        label="Floating Grid"
        labelLines={2}
        disabled={subscribed}
        tooltip={tip("Insert a small grid of cells that floats on the page")}
        data-testid="canvas-insert-floatingGrid"
        onClick={() => void insertOnCanvas("floatingGrid")}
      />
    </ActionRow>
  );
}
