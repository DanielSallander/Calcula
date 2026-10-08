//! FILENAME: app/extensions/CanvasSheet/components/CanvasPageSection.tsx
// PURPOSE: The Canvas tab's PAGE group (Power BI's Design > Customize page,
//          and the Themes gallery beside it): Page Size v, Page Background and
//          Wallpaper (colour split buttons), and Themes v.
// CONTEXT: A hero, a two-row grid, a hero -- the ribbon grammar's two ways to
//          fill the band's 61px box, side by side.
//
//          PAGE SIZE v lists every page preset (@api/canvasSheet, mirrored
//          from Rust and pinned by its drift test) as a radio row with its
//          size: Power BI's four 16:9 sizes as one group, then 4:3, Letter and
//          Tooltip, then Custom Size... -- which opens the width and height
//          fields in a card under the hero. A named preset carries its own
//          size (the backend says the same), and a typed size makes the page
//          "custom". Each row keeps the id the old dropdown's option had
//          (`canvas-page-size-<preset>`).
//
//          PAGE BACKGROUND / WALLPAPER are Excel's split colour buttons: the
//          face applies the colour on its bar, the chevron opens the palette,
//          whose "Theme default" row writes "" (the skin's own colour). The bar
//          shows the colour picked LAST from that button this session, or the
//          page's own until one is picked -- Excel's Fill Color rule, so a
//          press on the face does what its bar shows. Wallpaper is the colour
//          OUTSIDE the page (lib/pagePainter.ts).
//
//          THEMES v hosts the document theme gallery Document Theme registers
//          on the theme-gallery seam (@api/themeGallery) in a card of its own
//          -- the same rows, test ids and live check as Page Layout > Themes,
//          never an import of Document Theme, and no menu-bar item. It greys
//          out while nothing is registered there.
//
//          A SUBSCRIBED canvas is the publisher's layout: page size and colours
//          are disabled with the one note. Themes stays: the document theme is
//          the reader's whole workbook, not this page.

import React, { useEffect, useRef, useState } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  ColorSwatch,
  CommandButton,
  ControlGrid,
  ControlGridBreak,
  ControlRow,
  Field,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  MenuButton,
  MenuItem,
  MenuSeparator,
  Popover,
  Stack,
  ROW_GAP,
  SurfaceLayoutProvider,
  popoverLayout,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { useThemeGallery } from "@api/themeGallery";
import {
  CANVAS_CUSTOM_PAGE_PRESET,
  CANVAS_MAX_PAGE_EDGE_PX,
  CANVAS_MIN_PAGE_EDGE_PX,
  CANVAS_PAGE_PRESETS,
  canvasWallpaper,
  type CanvasPagePreset,
} from "@api/canvasSheet";
import type { CanvasLayout } from "@api";
import { patchActiveCanvasLayout } from "../lib/canvasActions";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import {
  lastPickedPageColour,
  pageColourFace,
  rememberPageColour,
  type PageColourField,
} from "../lib/pageColours";
import { CommitNumberField } from "./CommitNumberField";
import { useCanvasSheet } from "./canvasHooks";

// ============================================================================
// The colour splits (their memory is lib/pageColours.ts)
// ============================================================================

/** The face colour of `field`'s split, and how a pick is remembered: in state,
 *  so the bar shows the pick at once; in the module, so it outlives a remount
 *  (the band and a launcher flyout are two mounts of one group). */
function usePageColour(field: PageColourField, pageColour: string): [string, (hex: string) => void] {
  const [picked, setPicked] = useState<string | null>(() => lastPickedPageColour(field));
  return [
    pageColourFace(field, picked, pageColour),
    (hex: string) => {
      rememberPageColour(field, hex);
      setPicked(hex);
    },
  ];
}

function PageColourSplit({
  field,
  label,
  icon,
  tooltip,
  pageColour,
  subscribed,
}: {
  field: PageColourField;
  label: string;
  icon: React.ReactNode;
  tooltip: string;
  pageColour: string;
  subscribed: boolean;
}): React.ReactElement {
  const [face, remember] = usePageColour(field, pageColour);
  const testId = field === "background" ? "canvas-page-background" : "canvas-page-wallpaper";
  return (
    <ColorSwatch
      label={label}
      variant="bar"
      split
      icon={icon}
      color={face}
      onApply={() => void patchActiveCanvasLayout({ [field]: face })}
      onChange={(hex) => {
        remember(hex);
        void patchActiveCanvasLayout({ [field]: hex });
      }}
      allowAutomatic
      automaticLabel="Theme default"
      onAutomatic={() => void patchActiveCanvasLayout({ [field]: "" })}
      disabled={subscribed}
      tooltip={subscribed ? SUBSCRIBED_NOTE : tooltip}
      testId={testId}
      chevronTestId={`${testId}-options`}
      chevronLabel={`${label} colours`}
    />
  );
}

// ============================================================================
// Page Size v
// ============================================================================

/** The 16:9 sizes are one group, every other type the next (a rule between). */
function presetGroup(p: CanvasPagePreset): string {
  return p.type === "16:9" ? "16:9" : "other";
}

function PageSizeMenu({ layout, subscribed }: { layout: CanvasLayout; subscribed: boolean }): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Custom Size... closes the menu, and the menu gives focus back to the Page
  // Size button; the fields are in a card portalled to the end of <body>,
  // which Tab would reach only after every later control. So the card takes
  // focus itself once it is visible (it renders hidden for its measuring
  // pass, and a hidden field cannot take focus -- the All Visuals card's
  // rule): the width field, its text selected so typing replaces it.
  // Escape gives focus back to the button (Popover).
  useEffect(() => {
    if (!customOpen || subscribed) return;
    let frame = 0;
    const focusWidth = (): boolean => {
      const box = cardRef.current;
      if (!box) return false;
      if (box.contains(document.activeElement)) return true;
      const field = box.querySelector<HTMLInputElement>("input");
      if (!field) return false;
      field.focus();
      if (document.activeElement !== field) return false;
      field.select();
      return true;
    };
    const timer = setTimeout(() => {
      if (!focusWidth() && typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(() => void focusWidth());
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    };
  }, [customOpen, subscribed]);

  const choose = (p: CanvasPagePreset): void => {
    if (p.id === layout.pagePreset) return;
    void patchActiveCanvasLayout({ pagePreset: p.id, pageWidth: p.width, pageHeight: p.height });
  };

  return (
    <>
      <MenuButton
        ariaLabel="Page size"
        trigger={
          <CommandButton
            ref={setAnchor}
            icon={<RibbonIcon.PageSize size={HERO_ICON_SIZE} />}
            label="Page Size"
            labelLines={2}
            chevron
            disabled={subscribed}
            tooltip={subscribed ? SUBSCRIBED_NOTE : `The size of the page (now ${layout.pageWidth} x ${layout.pageHeight} px)`}
            data-testid="canvas-page-size"
          />
        }
      >
        {CANVAS_PAGE_PRESETS.map((p, i) => (
          <React.Fragment key={p.id}>
            {i > 0 && presetGroup(p) !== presetGroup(CANVAS_PAGE_PRESETS[i - 1]) && <MenuSeparator />}
            <MenuItem
              role="menuitemradio"
              checked={layout.pagePreset === p.id}
              hint={p.sizeLabel}
              testId={`canvas-page-size-${p.id}`}
              onSelect={() => choose(p)}
            >
              {p.label}
            </MenuItem>
          </React.Fragment>
        ))}
        <MenuSeparator />
        <MenuItem
          role="menuitemradio"
          checked={layout.pagePreset === CANVAS_CUSTOM_PAGE_PRESET}
          hint={layout.pagePreset === CANVAS_CUSTOM_PAGE_PRESET ? `${layout.pageWidth} x ${layout.pageHeight}` : undefined}
          testId={`canvas-page-size-${CANVAS_CUSTOM_PAGE_PRESET}`}
          onSelect={() => setCustomOpen(true)}
        >
          Custom Size...
        </MenuItem>
      </MenuButton>
      <Popover
        card
        anchorEl={anchor}
        open={customOpen && !subscribed}
        onClose={() => setCustomOpen(false)}
        heading="Custom page size"
      >
        <SurfaceLayoutProvider value={popoverLayout()}>
          <div ref={cardRef}>
            <Stack gap={ROW_GAP}>
              <CommitNumberField
                label="Width"
                ariaLabel="Page width in pixels"
                value={layout.pageWidth}
                min={CANVAS_MIN_PAGE_EDGE_PX}
                max={CANVAS_MAX_PAGE_EDGE_PX}
                step={1}
                width={72}
                suffix="px"
                testId="canvas-page-width"
                // An explicit size is a custom page (the backend says the same).
                onCommit={(pageWidth) => void patchActiveCanvasLayout({ pagePreset: CANVAS_CUSTOM_PAGE_PRESET, pageWidth })}
              />
              <CommitNumberField
                label="Height"
                ariaLabel="Page height in pixels"
                value={layout.pageHeight}
                min={CANVAS_MIN_PAGE_EDGE_PX}
                max={CANVAS_MAX_PAGE_EDGE_PX}
                step={1}
                width={72}
                suffix="px"
                testId="canvas-page-height"
                onCommit={(pageHeight) => void patchActiveCanvasLayout({ pagePreset: CANVAS_CUSTOM_PAGE_PRESET, pageHeight })}
              />
            </Stack>
          </div>
        </SurfaceLayoutProvider>
      </Popover>
    </>
  );
}

// ============================================================================
// Themes v
// ============================================================================

function ThemesButton(): React.ReactElement {
  const gallery = useThemeGallery();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown = open && gallery !== null;

  // The card takes focus once it is visible (it renders hidden for its
  // measuring pass): the gallery's first row, so the keyboard can pick a
  // theme at once -- the All Visuals card's rule.
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => {
      const box = bodyRef.current;
      if (!box || box.contains(document.activeElement)) return;
      box
        .querySelector<HTMLElement>('[role^="menuitem"], [role="option"], button, input, [tabindex="0"]')
        ?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [shown]);

  /** A pick (the gallery's onClose) closes the card and gives focus back. */
  const closeAfterPick = (): void => {
    setOpen(false);
    anchor?.focus();
  };

  return (
    <>
      <CommandButton
        ref={setAnchor}
        icon={<RibbonIcon.Theme size={HERO_ICON_SIZE} />}
        label="Themes"
        chevron
        disabled={gallery === null}
        tooltip={
          gallery
            ? "The document theme: the colours and fonts every page and sheet uses"
            : "No theme gallery is available (the Document Theme extension is not loaded)"
        }
        aria-haspopup="dialog"
        aria-expanded={shown}
        data-testid="canvas-themes"
        onClick={() => setOpen((o) => !o)}
      />
      <Popover
        card
        anchorEl={anchor}
        open={shown}
        onClose={() => setOpen(false)}
        heading={gallery?.heading}
        width={gallery?.width}
      >
        <SurfaceLayoutProvider value={popoverLayout(gallery?.width ?? 0)}>
          <div ref={bodyRef}>{shown ? gallery.render(closeAfterPick) : null}</div>
        </SurfaceLayoutProvider>
      </Popover>
    </>
  );
}

// ============================================================================
// The group
// ============================================================================

export function CanvasPageSection(_props: PanelSectionProps): React.ReactElement | null {
  const { active, activeSubscribed } = useCanvasSheet();
  if (!active) return null;
  const { layout } = active;
  const subscribed = activeSubscribed;
  return (
    <ControlRow gap={GAP_XS} align="stretch">
      <PageSizeMenu layout={layout} subscribed={subscribed} />
      <ControlGrid bandRows={2}>
        <Field label="Background">
          <PageColourSplit
            field="background"
            label="Page Background"
            icon={<RibbonIcon.Background size={ICON_SIZE_SM} />}
            tooltip="The colour of the page"
            pageColour={layout.background}
            subscribed={subscribed}
          />
        </Field>
        <ControlGridBreak />
        <Field label="Wallpaper">
          <PageColourSplit
            field="wallpaper"
            label="Wallpaper"
            icon={<RibbonIcon.Wallpaper size={ICON_SIZE_SM} />}
            tooltip="The colour around the page"
            pageColour={canvasWallpaper(layout)}
            subscribed={subscribed}
          />
        </Field>
      </ControlGrid>
      <ThemesButton />
    </ControlRow>
  );
}
