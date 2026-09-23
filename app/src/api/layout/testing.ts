//! FILENAME: app/src/api/layout/testing.ts
// PURPOSE: A test helper that finds hardcoded colour literals in rendered DOM.
// CONTEXT: The ribbon redesign makes every surface follow the skin through
//          tokens. A lint rule catches literals in SOURCE; this catches them in
//          what actually RENDERS — inline style attributes, SVG fill/stroke
//          attributes, and the CSS rules (emotion or styled-components) whose
//          class names appear on elements inside the container.
//
//          Exported from @api/layout (not from a __tests__ folder) so extension
//          tests can use it through the facade: extensions may only import @api.
//
//          ALLOWED, because they are not surfaces:
//          - the fallback half of `var(--token, #literal)` (stripped first);
//          - `transparent`, `currentColor`, `inherit`, `none`;
//          - anything inside an element carrying `data-colour-data`, which marks
//            categorical colour DATA (a chart palette swatch, a style gallery
//            thumbnail, a user's chosen font colour) rather than chrome.

// The named colours are fenced by (?<![\w-]) / (?![\w-]) rather than \b,
// because \b sits between "white" and "-" and so matched every
// `white-space: nowrap` — five agents independently wrote a local shim to
// strip white-space before scanning. The fence also keeps a real literal that
// FOLLOWS a white-space declaration visible, which a filter on "-> white"
// findings would have hidden.
const COLOUR_PATTERN =
  /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![\w-])(?:white|black|red|blue|green|gray|grey|orange|yellow|purple|pink|silver|navy|teal)(?![\w-])/i;

/** Remove `var(--name, fallback)` groups (with nested parentheses), url(),
 *  and every font-family / font declaration. A font NAME can spell a colour —
 *  "Arial Black" — and the Home font picker writes the current font into its
 *  trigger's style, so a band scan failed whenever the active cell was in
 *  Arial Black. A font declaration never paints a colour, so dropping it hides
 *  nothing. */
function stripAllowed(input: string): string {
  const css = input.replace(/(^|[;{\s])font(?:-family)?\s*:[^;}]*/gi, "$1");
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css.startsWith("var(", i) || css.startsWith("url(", i)) {
      let depth = 0;
      let j = i + 3;
      for (; j < css.length; j++) {
        if (css[j] === "(") depth++;
        else if (css[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      out += " ";
      i = j + 1;
      continue;
    }
    out += css[i];
    i++;
  }
  return out;
}

function isData(el: Element): boolean {
  return el.closest("[data-colour-data]") !== null;
}

function collectStyleText(): string[] {
  if (typeof document === "undefined") return [];
  const out: string[] = [];
  document.querySelectorAll("style").forEach((s) => {
    if (s.textContent) out.push(s.textContent);
    // Rules inserted with insertRule (speedy mode) never reach textContent.
    const sheet = (s as HTMLStyleElement).sheet;
    if (sheet) {
      try {
        for (const rule of Array.from(sheet.cssRules)) out.push(rule.cssText);
      } catch {
        /* cross-origin or detached sheet */
      }
    }
  });
  return out;
}

/**
 * Split CSS text into `selector { body }` rules. Good enough for emotion and
 * styled-components output, which never nests braces except @media blocks.
 */
function rulesOf(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

/**
 * Every hardcoded colour a rendered subtree paints with. Returns a list of
 * human-readable findings; an empty list means the subtree follows the skin.
 *
 * ```ts
 * expect(findHardcodedColours(container)).toEqual([]);
 * ```
 */
export function findHardcodedColours(root: Element): string[] {
  const findings: string[] = [];
  const classes = new Set<string>();
  const all = [root, ...Array.from(root.querySelectorAll("*"))];

  for (const el of all) {
    if (isData(el)) continue;
    const tag = el.tagName.toLowerCase();

    const style = el.getAttribute("style");
    if (style) {
      const hit = COLOUR_PATTERN.exec(stripAllowed(style));
      if (hit) findings.push(`<${tag}> style="${style}" -> ${hit[0]}`);
    }
    for (const attr of ["fill", "stroke", "color", "stop-color"]) {
      const v = el.getAttribute(attr);
      if (v) {
        const hit = COLOUR_PATTERN.exec(stripAllowed(v));
        if (hit) findings.push(`<${tag}> ${attr}="${v}"`);
      }
    }
    const cls = el.getAttribute("class");
    if (cls) for (const c of cls.split(/\s+/)) if (c) classes.add(c);
  }

  if (classes.size > 0) {
    for (const text of collectStyleText()) {
      for (const { selector, body } of rulesOf(text)) {
        const owner = Array.from(classes).find((c) =>
          new RegExp(`\\.${c.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?![\\w-])`).test(selector),
        );
        if (!owner) continue;
        const hit = COLOUR_PATTERN.exec(stripAllowed(body));
        if (hit) findings.push(`.${owner} { ${body.trim().slice(0, 120)} } -> ${hit[0]}`);
      }
    }
  }

  return Array.from(new Set(findings));
}
