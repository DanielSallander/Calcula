//! FILENAME: app/src/api/layout/primitives/Dropdown.tsx
// PURPOSE: The value picker of the Calcula Clusters grammar — a 28px trigger
//          showing the current value, opening a card popover listbox.
// CONTEXT: A native <select> cannot show an icon, a preview or a hint per
//          option, cannot follow the skin once open (the OS draws the list),
//          and its list clips inside the ribbon's overflow-hidden band on some
//          WebView builds. Extensions therefore hand-rolled dropdowns, each
//          with its own list, its own keyboard (usually none) and its own
//          dismissal. This is the one: values use Dropdown, commands use Menu
//          (Menu.tsx), and both draw their rows with the one recipe in
//          listRow.ts.
//
//          ARIA: the trigger is a <button role="combobox" aria-haspopup=
//          "listbox" aria-expanded> named by `ariaLabel`; the popup is a
//          <div role="listbox"> of <div role="option" aria-selected>. Focus
//          MOVES into the list (options are tabIndex -1), landing on the
//          selected option, which is scrolled into view — a 40-font list opens
//          where the current font is.
//
//          Keyboard: ArrowDown/ArrowUp on the trigger open it; in the list the
//          arrows move (stopping at the ends, like a native select), Home/End
//          jump, a letter jumps to the next option starting with it,
//          Enter/Space choose and close, Escape closes, Tab closes; every
//          close by keyboard returns focus to the trigger. Choosing the value
//          that is already selected closes without calling onChange.
//
//          The open list stops mousedown and Escape at its portal for the
//          same reason a Menu does (see NESTING in Menu.tsx): a Dropdown
//          inside a Launcher flyout or a card Popover must not dismiss the
//          overlay it lives in.
//
//          Colours come only from LT (../theme).

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { css } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { LT } from "../theme";
import { FIELD_HEIGHT, FONT_FAMILY } from "../tokens";
import { DropdownChevron } from "./Button";
import {
  listHintClass,
  listIconClass,
  listLabelClass,
  listRowClass,
  listTrailingClass,
} from "./listRow";
import { MenuCheck } from "./Menu";
import { Popover } from "./Popover";
import { Tooltip } from "./Tooltip";
import type { TooltipPlacement } from "./Tooltip";
import {
  focusWhenVisible,
  isTypeaheadKey,
  moveForKey,
  stepIndex,
  typeaheadIndex,
} from "./roving";

/** Default trigger width in the ribbon band: fits "Bottom right" / "Calibri". */
const DROPDOWN_BAND_WIDTH = 104;
/** Border (1) + padding (8) of a card Popover, per side. The listbox's
 *  min-width is the trigger's width minus this twice, so the open card is
 *  exactly as wide as the trigger it hangs from. */
const CARD_INSET = 9;

// ============================================================================
// Types
// ============================================================================

export interface DropdownOption<T> {
  value: T;
  label: string;
  /** Leading icon (16px reads best in a 30px row). */
  icon?: React.ReactNode;
  /** A sample of the value (a dash pattern, a colour ramp) after the label. */
  preview?: React.ReactNode;
  /** Trailing secondary text. */
  hint?: string;
  disabled?: boolean;
}

export interface DropdownProps<T> {
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  onChange: (value: T) => void;
  /** Trigger width in px. Default 104 in the band, 100% in a panel/popover. */
  width?: number;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  /** Custom trigger content for the selected option (default: icon + label). */
  renderValue?: (option: DropdownOption<T>) => React.ReactNode;
  disabled?: boolean;
  /** Accessible name of the combobox ("Legend position"). */
  ariaLabel: string;
  /** Rendered as data-testid on the trigger. */
  testId?: string;
  /** Each option gets data-testid = optionTestIdPrefix + String(value). */
  optionTestIdPrefix?: string;
  /** Tooltip on the TRIGGER (hover + keyboard focus, aria-describedby on the
   *  combobox itself). A Tooltip cannot wrap a Dropdown from outside, because
   *  a Dropdown renders a fragment: callers used to hang one on a wrapper
   *  <span>, which never opened on keyboard focus. */
  tooltip?: React.ReactNode;
  /** Literal shortcut chip for the tooltip. */
  shortcut?: string;
  /** Resolve the tooltip chip from the keybinding registry. */
  commandId?: string;
  tooltipPlacement?: TooltipPlacement;
  /** Stacking layer of the open list (see Popover `zIndex`); the trigger's
   *  tooltip sits one above it. */
  zIndex?: number;
}

// ============================================================================
// Styles
// ============================================================================

const triggerClass = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  height: ${FIELD_HEIGHT}px;
  padding: 0 8px 0 10px;
  border: 1px solid ${LT.controlBorder};
  border-radius: ${LT.radiusControl};
  background: ${LT.inputBg};
  color: ${LT.text};
  cursor: pointer;
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
  text-align: left;
  white-space: nowrap;
  transition:
    background-color ${LT.motionHover},
    border-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  /* Layer the hover tint over the field background (the tint is translucent). */
  &:hover:not(:disabled) {
    background: linear-gradient(${LT.hover}, ${LT.hover}), ${LT.inputBg};
  }

  &[aria-expanded="true"] {
    border-color: ${LT.stateAccent};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
    border-color: ${LT.stateAccent};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const valueClass = css`
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
`;

const valueTextClass = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const placeholderClass = css`
  color: ${LT.textSecondary};
`;

const chevronClass = css`
  display: inline-flex;
  align-items: center;
  flex: none;
  color: ${LT.textSecondary};
`;

const listClass = css`
  display: flex;
  flex-direction: column;
  outline: none;
`;

const previewClass = css`
  display: inline-flex;
  align-items: center;
  flex: none;
`;

// ============================================================================
// The open list
// ============================================================================

interface DropdownListProps<T> {
  id: string;
  ariaLabel: string;
  options: ReadonlyArray<DropdownOption<T>>;
  selectedIndex: number;
  minWidth: number;
  optionTestIdPrefix?: string;
  /** Choose the option at `index` (closes the list). */
  onChoose: (index: number) => void;
  /** Close by keyboard, returning focus to the trigger. */
  onClose: () => void;
}

function DropdownList<T>({
  id,
  ariaLabel,
  options,
  selectedIndex,
  minWidth,
  optionTestIdPrefix,
  onChoose,
  onClose,
}: DropdownListProps<T>): React.ReactElement {
  const optionsRef = useRef<Array<HTMLDivElement | null>>([]);
  const disabled = options.map((o) => Boolean(o.disabled));

  // Where focus lands on open, fixed at mount: the selected option, else the
  // first enabled one.
  const [initialIndex] = useState(() =>
    selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : stepIndex("first", -1, options.map((o) => Boolean(o.disabled)), false),
  );

  useEffect(() => {
    const el = optionsRef.current[initialIndex];
    focusWhenVisible(el);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [initialIndex]);

  const focusOption = (index: number) => {
    const el = optionsRef.current[index];
    if (!el) return;
    el.focus();
    el.scrollIntoView?.({ block: "nearest" });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = optionsRef.current.findIndex((o) => o !== null && o === e.target);

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      // No preventDefault: focus returns to the trigger and Tab moves on.
      onClose();
      return;
    }

    const move = moveForKey(e.key, "vertical");
    if (move) {
      e.preventDefault();
      const next = stepIndex(move, current, disabled, false);
      if (next >= 0) focusOption(next);
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (current >= 0 && !disabled[current]) onChoose(current);
      return;
    }

    if (isTypeaheadKey(e)) {
      const next = typeaheadIndex(
        e.key,
        current,
        options.map((o) => o.label),
        disabled,
      );
      if (next >= 0) {
        e.preventDefault();
        focusOption(next);
      }
    }
  };

  return (
    <div
      id={id}
      role="listbox"
      aria-label={ariaLabel}
      className={listClass}
      style={{ minWidth }}
      onKeyDown={handleKeyDown}
      // The open list keeps its presses to itself (see NESTING in Menu.tsx).
      onMouseDown={(e) => e.stopPropagation()}
    >
      {options.map((opt, i) => {
        const selected = i === selectedIndex;
        const hasHint = opt.hint !== undefined && opt.hint !== "";
        const hasPreview = opt.preview !== undefined && opt.preview !== null;
        return (
          <div
            key={i}
            ref={(el) => {
              optionsRef.current[i] = el;
            }}
            role="option"
            aria-selected={selected}
            aria-disabled={opt.disabled ? true : undefined}
            tabIndex={-1}
            data-testid={
              optionTestIdPrefix !== undefined ? `${optionTestIdPrefix}${String(opt.value)}` : undefined
            }
            className={listRowClass}
            onClick={() => {
              if (!opt.disabled) onChoose(i);
            }}
            // The pointer moves focus, so the hovered option and the keyboard's
            // current option are one and the same.
            onMouseMove={(e) => {
              if (opt.disabled) return;
              const el = e.currentTarget;
              if (document.activeElement !== el) el.focus({ preventScroll: true });
            }}
          >
            <MenuCheck checked={selected} />
            {opt.icon !== undefined && opt.icon !== null && (
              <span className={listIconClass} aria-hidden>
                {opt.icon}
              </span>
            )}
            <span className={listLabelClass}>{opt.label}</span>
            {(hasPreview || hasHint) && (
              <span className={listTrailingClass}>
                {hasPreview && <span className={previewClass}>{opt.preview}</span>}
                {hasHint && <span className={listHintClass}>{opt.hint}</span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Dropdown
// ============================================================================

/**
 * Pick one value from a list. Controlled: `value` + `onChange`.
 *
 * ```tsx
 * <Dropdown
 *   ariaLabel="Legend position"
 *   value={position}
 *   onChange={setPosition}
 *   options={[{ value: "bottom", label: "Bottom" }, { value: "right", label: "Right" }]}
 * />
 * ```
 */
export function Dropdown<T>({
  value,
  options,
  onChange,
  width,
  placeholder,
  renderValue,
  disabled = false,
  ariaLabel,
  testId,
  optionTestIdPrefix,
  tooltip,
  shortcut,
  commandId,
  tooltipPlacement,
  zIndex,
}: DropdownProps<T>): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [triggerWidth, setTriggerWidth] = useState(0);
  const listId = `${useId()}-listbox`;

  const selectedIndex = options.findIndex((o) => Object.is(o.value, value));
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const isOpen = open && !disabled && triggerEl !== null;

  // Outside press / document Escape (Popover restores focus itself on Escape).
  const dismiss = useCallback(() => setOpen(false), []);

  const openList = () => {
    setTriggerWidth(triggerEl?.offsetWidth ?? 0);
    setOpen(true);
  };

  const closeToTrigger = () => {
    setOpen(false);
    triggerEl?.focus();
  };

  const choose = (index: number) => {
    const opt = options[index];
    if (!opt || opt.disabled) return;
    closeToTrigger();
    if (!Object.is(opt.value, value)) onChange(opt.value);
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!isOpen) openList();
  };

  let content: React.ReactNode;
  if (!selected) {
    content = <span className={[valueTextClass, placeholderClass].join(" ")}>{placeholder ?? ""}</span>;
  } else if (renderValue) {
    content = renderValue(selected);
  } else {
    content = (
      <>
        {selected.icon !== undefined && selected.icon !== null && (
          <span className={listIconClass} aria-hidden>
            {selected.icon}
          </span>
        )}
        <span className={valueTextClass}>{selected.label}</span>
      </>
    );
  }

  const trigger = (
      <button
        ref={setTriggerEl}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-label={ariaLabel}
        data-testid={testId}
        disabled={disabled}
        className={triggerClass}
        // In a band row (nowrap) a fixed-width field must not be squeezed.
        style={{ width: width ?? (band ? DROPDOWN_BAND_WIDTH : "100%"), ...(band ? { flex: "none" } : {}) }}
        onClick={() => (isOpen ? setOpen(false) : openList())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={valueClass}>{content}</span>
        <span className={chevronClass} aria-hidden>
          <DropdownChevron size={9} />
        </span>
      </button>
  );
  const hasTooltip =
    (tooltip !== undefined && tooltip !== null && tooltip !== false && tooltip !== "") ||
    shortcut !== undefined ||
    commandId !== undefined;

  return (
    <>
      {hasTooltip ? (
        <Tooltip
          content={tooltip ?? ariaLabel}
          shortcut={shortcut}
          commandId={commandId}
          placement={tooltipPlacement}
          zIndex={zIndex !== undefined ? zIndex + 1 : undefined}
        >
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <Popover
        anchorEl={triggerEl}
        open={isOpen}
        onClose={dismiss}
        card
        placement="bottom-start"
        role="presentation"
        zIndex={zIndex}
      >
        <DropdownList
          id={listId}
          ariaLabel={ariaLabel}
          options={options}
          selectedIndex={selectedIndex}
          minWidth={Math.max(0, triggerWidth - 2 * CARD_INSET)}
          optionTestIdPrefix={optionTestIdPrefix}
          onChoose={choose}
          onClose={closeToTrigger}
        />
      </Popover>
    </>
  );
}
