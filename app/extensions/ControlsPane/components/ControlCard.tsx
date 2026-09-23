//! FILENAME: app/extensions/ControlsPane/components/ControlCard.tsx
// PURPOSE: Shared card chrome for pane controls in the Controls pane, visually
//          matching RibbonFilterCard (fixed 56px chip-card in the ribbon band,
//          full-width card in the sidebar). Shows the control name where the
//          filter card shows its field, hosts the type-specific control body,
//          and offers an options menu with Rename... / Delete (+ "Edit code..."
//          for custom AND button controls — both are script-backed, wired via
//          the onEditCode callback). Rename failures (the backend's name-
//          uniqueness rule across pane controls AND ribbon filters) surface
//          inline in the rename popover, AddControlDialog's inline-error idiom.
// CONTEXT: Dispatches on control.controlType to SliderControl / DropdownControl /
//          CheckboxControl / ButtonControl; custom controls render through the
//          renderCustom prop (CustomControlHost, wired by the section).
//
//          The options menu is an @api MenuButton (card Popover + Menu) and the
//          rename form its own card Popover anchored to the same button. Both
//          replaced one hand-rolled position:fixed layer that swapped between a
//          menu view and a rename view and carried its own outside-click and
//          Escape listeners; the Popover owns dismissal now.

import React, { useState, useCallback, useEffect, useRef } from "react";
import { RibbonIcon } from "@api";
import {
  Button,
  IconButton,
  Input,
  LT,
  MenuButton,
  MenuItem,
  MenuSeparator,
  Popover,
  SurfaceLayoutProvider,
  popoverLayout,
  useSurfaceLayout,
} from "@api/layout";
import type { PaneControl } from "../lib/controlsPaneTypes";
import {
  updateControlAsync,
  deleteControlAsync,
} from "../lib/controlsPaneStore";
import { SliderControl } from "./SliderControl";
import { DropdownControl } from "./DropdownControl";
import { CheckboxControl } from "./CheckboxControl";
import { ButtonControl } from "./ButtonControl";
import {
  cardTitleStyle,
  focusWhenVisible,
  paneCardStyle,
  primaryButtonClass,
} from "./paneChrome";

const MENU_WIDTH = 170;
const RENAME_WIDTH = 220;

interface Props {
  control: PaneControl;
  /** Opens the object-script editor ("Edit code..." — custom AND button
   *  controls; openControlScriptEditor picks the objectType by kind). */
  onEditCode?: (control: PaneControl) => void;
  /** Renders the body of a custom scripted control (CustomControlHost). */
  renderCustom?: (control: PaneControl) => React.ReactNode;
}

export function ControlCard({
  control,
  onEditCode,
  renderCustom,
}: Props): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  const [menuButtonEl, setMenuButtonEl] = useState<HTMLButtonElement | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  const closeRename = useCallback(() => setRenameOpen(false), []);

  /** Commit a rename. Resolves to an error message to show inline in the
   *  rename popover (it stays open), or null on success/no-op (it closes).
   *  The backend enforces case-insensitive name uniqueness across pane
   *  controls AND ribbon filters; updateControlAsync returns its message. */
  const handleRename = useCallback(
    async (newName: string): Promise<string | null> => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === control.name) {
        closeRename();
        return null;
      }
      const result = await updateControlAsync(control.id, { name: trimmed });
      if ("error" in result) {
        return result.error;
      }
      closeRename();
      return null;
    },
    [control.id, control.name, closeRename],
  );

  const handleDelete = useCallback(async () => {
    closeRename();
    await deleteControlAsync(control.id);
  }, [control.id, closeRename]);

  const canEditCode =
    (control.controlType === "custom" || control.controlType === "button") &&
    onEditCode !== undefined;

  const body = renderControlBody(control, renderCustom);

  return (
    <>
      <div
        style={paneCardStyle(band)}
        title={`${control.name} (${control.controlType})`}
        data-pane-card="control"
      >
        {/* Title line (14) + gap (4) + one 28px control row = the card's
            46px content box: 56 less the 1px border and 4px padding. */}
        <div style={styles.cardBody}>
          <div style={cardTitleStyle}>{control.name}</div>
          <div style={styles.controlRow}>{body}</div>
        </div>
        <MenuButton
          width={MENU_WIDTH}
          ariaLabel={`${control.name} options`}
          trigger={
            <IconButton
              ref={setMenuButtonEl}
              size="sm"
              icon={<RibbonIcon.MoreHorizontal size={16} />}
              label="Control options"
              data-testid="controls-pane-card-menu"
              // Band: centred on the 56px card. Sidebar: level with the
              // title, since a scripted body can make the card tall.
              style={band ? undefined : { alignSelf: "flex-start" }}
              // Opening the menu retires a rename that is still showing.
              onClick={closeRename}
            />
          }
        >
          <MenuItem
            icon={<RibbonIcon.Pencil size={16} />}
            onSelect={() => setRenameOpen(true)}
          >
            Rename...
          </MenuItem>
          {canEditCode && (
            <MenuItem
              icon={<RibbonIcon.Code size={16} />}
              onSelect={() => onEditCode?.(control)}
            >
              Edit code...
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            icon={<RibbonIcon.Delete size={16} />}
            style={{ color: LT.dangerFg }}
            onSelect={() => void handleDelete()}
          >
            Delete
          </MenuItem>
        </MenuButton>
      </div>

      {renameOpen && menuButtonEl && (
        <RenamePopover
          anchorEl={menuButtonEl}
          currentName={control.name}
          onRename={handleRename}
          onClose={closeRename}
        />
      )}
    </>
  );
}

/** Dispatch to the type-specific control body. */
function renderControlBody(
  control: PaneControl,
  renderCustom?: (control: PaneControl) => React.ReactNode,
): React.ReactNode {
  switch (control.controlType) {
    case "slider":
      return <SliderControl control={control} />;
    case "dropdown":
      return <DropdownControl control={control} />;
    case "checkbox":
      return <CheckboxControl control={control} />;
    case "button":
      return <ButtonControl control={control} />;
    case "custom":
      return renderCustom ? (
        renderCustom(control)
      ) : (
        <div style={styles.customPlaceholder}>Custom control</div>
      );
    default:
      return (
        <div style={styles.customPlaceholder}>
          Unknown control type
        </div>
      );
  }
}

// ============================================================================
// Rename popover
// ============================================================================

function RenamePopover({
  anchorEl,
  currentName,
  onRename,
  onClose,
}: {
  anchorEl: HTMLElement;
  currentName: string;
  /** Resolves to an inline error message (popover stays open) or null. */
  onRename: (newName: string) => Promise<string | null>;
  onClose: () => void;
}): React.ReactElement {
  const [renameValue, setRenameValue] = useState(currentName);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Run the rename; on failure keep the popover open and show the error
   *  inline (AddControlDialog's inline-error idiom). */
  const commitRename = useCallback(async () => {
    if (renaming) return;
    setRenaming(true);
    try {
      setRenameError(await onRename(renameValue));
    } finally {
      setRenaming(false);
    }
  }, [onRename, renameValue, renaming]);

  // Focus + select the name once the popover is positioned (see
  // focusWhenVisible for why this cannot be autoFocus).
  useEffect(() => focusWhenVisible(() => inputRef.current, true), []);

  return (
    <Popover
      anchorEl={anchorEl}
      open
      onClose={onClose}
      card
      width={RENAME_WIDTH}
      heading="Control name"
    >
      <SurfaceLayoutProvider value={popoverLayout()}>
        <div style={styles.renameBody}>
          <Input
            ref={inputRef}
            type="text"
            aria-label="Control name"
            value={renameValue}
            onChange={(e) => {
              setRenameValue(e.target.value);
              setRenameError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
            }}
          />
          {renameError && (
            <div role="alert" style={styles.renameError}>
              {renameError}
            </div>
          )}
          <div style={styles.renameFooter}>
            <Button
              variant="outlined"
              className={primaryButtonClass}
              onClick={() => void commitRename()}
              disabled={renameValue.trim().length === 0 || renaming}
            >
              OK
            </Button>
            <Button variant="outlined" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </SurfaceLayoutProvider>
    </Popover>
  );
}

// ============================================================================
// Styles — the card chrome itself lives in paneChrome.ts
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  cardBody: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 4,
    flex: 1,
    minWidth: 0,
  },
  controlRow: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
  },
  customPlaceholder: {
    fontSize: 10,
    color: LT.textSecondary,
    fontStyle: "italic",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  renameBody: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "0 2px 2px",
  },
  // Inline backend-rejection text (AddControlDialog's error idiom).
  renameError: {
    fontSize: 11,
    color: LT.dangerFg,
    whiteSpace: "pre-wrap",
  },
  renameFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 6,
  },
};
