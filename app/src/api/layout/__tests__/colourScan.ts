//! FILENAME: app/src/api/layout/__tests__/colourScan.ts
// PURPOSE: Test-only wrapper around findHardcodedColours for the Segmented,
//          Menu, Dropdown, SegmentedTabs, Launcher and container tests.
// CONTEXT: The colour-name alternation in ../testing.ts is `\b(?:white|...)\b`,
//          and `\b` matches between "white" and "-", so every
//          `white-space: nowrap` reports "-> white". Filtering those findings
//          out afterwards is NOT safe: the helper reports only the FIRST hit
//          per rule, so a real literal after a white-space declaration in the
//          same rule would be dropped with it. So the white-space declarations
//          are removed — from the stylesheet text AND from inline style
//          attributes (the containers write inline styles) — for the duration
//          of the scan, and every real colour stays visible. (The button/
//          popover tests carry the stylesheet half of this inline.) Once
//          testing.ts anchors the names with `(?<![\w-])white(?![\w-])` this is
//          a harmless no-op.

import { findHardcodedColours } from "../testing";

const WHITE_SPACE_DECL = /white-space\s*:\s*[a-z-]+\s*;?/gi;

export function hardcodedColours(root: Element): string[] {
  const tags = Array.from(document.querySelectorAll("style"));
  const savedTags = tags.map((tag) => tag.textContent);
  const styled = [root, ...Array.from(root.querySelectorAll("[style]"))].filter((el) =>
    el.hasAttribute("style"),
  );
  const savedStyles = styled.map((el) => el.getAttribute("style") ?? "");
  try {
    for (const tag of tags) {
      tag.textContent = (tag.textContent ?? "").replace(WHITE_SPACE_DECL, "");
    }
    styled.forEach((el, i) => el.setAttribute("style", savedStyles[i].replace(WHITE_SPACE_DECL, "")));
    return findHardcodedColours(root);
  } finally {
    tags.forEach((tag, i) => {
      tag.textContent = savedTags[i];
    });
    styled.forEach((el, i) => el.setAttribute("style", savedStyles[i]));
  }
}

/**
 * The value `el` is DECLARED to have for `prop` by the stylesheet rules that
 * match it (last match wins). jsdom's getComputedStyle drops shorthands
 * written with var() (`background: var(--x, ...)` reads as transparent), so
 * the token a rule paints with is read from the rule text instead.
 */
export function declared(el: Element, prop: string): string {
  let value = "";
  const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  for (const style of Array.from(document.querySelectorAll("style"))) {
    const text = style.textContent ?? "";
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let matches = false;
      try {
        matches = el.matches(m[1].trim());
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const hit = decl.exec(m[2]);
      if (hit) value = hit[1].trim();
    }
  }
  return value;
}
