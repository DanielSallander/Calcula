// =============================================================================
// ARCHITECTURE BOUNDARY RULES — single source of truth
// =============================================================================
// These flat-config blocks encode Calcula's microkernel boundaries
// (see ARCHITECTURE.md + PHILOSOPHY.md "Independence Through Boundaries"):
//
//   1. ALIEN RULE      — Core must not import Shell or Extensions.
//   2. FACADE RULE     — Extensions must import only through src/api, and must
//                        not reach the raw @api/backend invokeBackend door —
//                        the ungated passthrough (A3). Typed @api/backend
//                        wrappers + ctx.invokeBackend / createBackendChannel are
//                        the sanctioned routes.
//   3. API NEUTRALITY  — The src/api facade must not import a specific
//                        extension (No First-Class Citizens).
//   4. SIBLING ISOLATION — Extensions must not import each other's internals;
//                        they share only through src/api or extensions/_shared.
//
// Severity is staged during Wave A of the architecture remediation:
//   - ALIEN + FACADE are 'error' (verified clean — they gate now).
//   - API_NEUTRALITY is 'warn' until the @api->Pivot dependency is relocated
//     (A2); then flip BOUNDARY_SEVERITY.apiNeutrality to 'error'.
//   - SIBLING isolation is 'warn' until the cross-extension leaks are triaged
//     (A1); then flip BOUNDARY_SEVERITY.sibling to 'error'.
//
// Consumed by:
//   - eslint.config.js            (inline editor feedback, full rule set)
//   - eslint.config.boundaries.js (CI gate — boundary rules ONLY, no noise)
// =============================================================================

import boundaries from 'eslint-plugin-boundaries'

/** Flip these to 'error' as each Wave A batch lands (see header). */
export const BOUNDARY_SEVERITY = {
  alien: 'error',
  facade: 'error',
  apiNeutrality: 'error', // A2 done: @api->Pivot relocated, api->shell inverted
  sibling: 'error', // A1 done: the 24 cross-extension leaks are resolved
}

// The Facade Rule's path patterns (deep core/shell imports are forbidden in
// extensions). Factored so the main FACADE block and the tests/TestRunner
// relax-block below share one definition (flat-config rules are last-wins per
// rule id, NOT merged — so a file matched by both blocks gets the LATER block's
// `no-restricted-imports` in full; the relax-block re-declares these patterns
// while dropping the raw-backend-door ban).
const FACADE_IMPORT_PATTERNS = [
  {
    group: ['**/src/core/**', '**/core/types/**', '**/core/types', '**/core/lib/**', '**/core/state/**', '@core', '@core/*'],
    message: 'Extensions must import through src/api only (Facade Rule).',
  },
  {
    group: ['**/src/shell/**', '**/shell/registries/**', '**/shell/Ribbon/**', '@shell', '@shell/*'],
    message: 'Extensions must import through src/api only (Facade Rule).',
  },
]

// A3 BACKEND DOOR: extensions must not import the RAW invokeBackend passthrough
// from @api/backend — it is ungated. Use the capability-scoped ctx.invokeBackend,
// a createBackendChannel bound in activate(), or a typed @api/backend wrapper
// (those named imports stay allowed). importNames keeps this surgical.
const RAW_BACKEND_INVOKE_PATH = {
  name: '@api/backend',
  importNames: ['invokeBackend'],
  message:
    'Extensions must not import the raw invokeBackend from @api/backend (ungated passthrough, A3). ' +
    'Use the capability-gated ctx.invokeBackend, a createBackendChannel(...) bound in activate(), ' +
    'or a typed @api/backend wrapper. Typed wrappers from @api/backend remain allowed.',
}

// A3 BACKEND DOOR (raw Tauri): extensions must not import the raw `invoke` from
// @tauri-apps/api/core either — it bypasses the @api/backend door entirely. Use a
// typed @api/backend wrapper or a createBackendChannel(...) bound in activate().
// importNames-scoped to `invoke` so @tauri-apps/api/event + the legitimate
// plugin-dialog / webviewWindow / path imports stay allowed.
const RAW_TAURI_INVOKE_PATH = {
  name: '@tauri-apps/api/core',
  importNames: ['invoke'],
  message:
    'Extensions must not import the raw `invoke` from @tauri-apps/api/core (bypasses the @api/backend door, A3). ' +
    'Use a typed @api/backend wrapper, or a createBackendChannel(...) bound in activate().',
}

// A3 EVENT DOOR: the analog of the invoke ban for the Tauri EVENT bus. Extensions
// must not import raw emit/listen from @tauri-apps/api/event — that is an ungated
// cross-window/back-channel door. Use ctx.events / the @api event channels.
// importNames-scoped so other @tauri-apps/api/event symbols (if any) stay allowed.
const RAW_TAURI_EVENT_PATH = {
  name: '@tauri-apps/api/event',
  importNames: ['emit', 'listen'],
  message:
    'Extensions must not import raw emit/listen from @tauri-apps/api/event (ungated event door, A3). ' +
    'Use ctx.events or a typed @api event channel.',
}

// =============================================================================
// DIALOG GLOBALS — the async-confirm defect class
// =============================================================================
// tauri-plugin-dialog replaces window.alert/window.confirm in every webview
// (see src/api/dialogs.ts for the verbatim shim and the full rationale):
//
//   window.confirm returns a PROMISE, so `if (!window.confirm(m)) return;` tests
//   `!Promise` — always false. The guard never fires and the code runs as though
//   the user pressed OK. On a CONSENT gate that means Cancel grants consent.
//
//   window.alert is fire-and-forget and NOT async, so awaiting it does not help
//   either; execution continues past a message nobody has read.
//
//   window.prompt is not replaced at all and depends on the embedder's
//   script-dialog policy.
//
// This shipped six times, patched at the call site each time, and returned each
// time. A per-site fix cannot stop the seventh — only refusing to compile the
// construct can. Every caller uses confirmAsync / alertAsync / promptAsync from
// @api/dialogs, which await properly and fail CLOSED.
//
// Enforced with TWO rules because the hazard has two syntactic shapes and each
// rule sees only one of them:
//   - no-restricted-globals   catches the BARE `alert(msg)` / `confirm(msg)`.
//     It is scope-aware, so a local variable or parameter named `alert` is
//     correctly left alone — a text search cannot make that distinction, and
//     bare calls are the majority shape in src/core.
//   - no-restricted-properties catches the QUALIFIED `window.confirm(msg)`,
//     including non-call references like `typeof window.confirm === "function"`,
//     which is how one site smuggled the global past review as a feature probe.
// Together they cover globalThis/self/window-qualified and unqualified use.
const DIALOG_GLOBAL_MESSAGE =
  'Banned: the browser dialog globals are broken under Tauri (confirm returns a Promise, ' +
  'so `if (!confirm(...))` NEVER fires; alert is fire-and-forget; prompt is not implemented). ' +
  'Use confirmAsync / alertAsync / promptAsync from @api/dialogs and AWAIT the result.'

const DIALOG_GLOBAL_NAMES = ['confirm', 'alert', 'prompt']
const DIALOG_GLOBAL_HOSTS = ['window', 'globalThis', 'self']

// THE SAME CLASS THROUGH THE PLUGIN'S FRONT DOOR. Importing `ask` / `confirm` /
// `message` straight from @tauri-apps/plugin-dialog skips the wrapper as surely
// as the globals do: `ask` THROWS when its dialog cannot be shown, and a caller
// that does not catch it fails OPEN. Measured in fix round 3: Pivot imported
// `ask` for its overwrite prompt, the prompt threw, every caller skipped
// `undo_pivot_overwrite`, and the user's cells stayed overwritten without being
// asked. `open` and `save` (file pickers) stay allowed -- they are not
// questions, and a refused pick already reads as "no file".
//
// Enforced with `@typescript-eslint/no-restricted-imports`, NOT core
// `no-restricted-imports`: flat config is last-wins per rule id, and the
// FACADE / ALIEN / API-NEUTRALITY blocks below all set the core rule for their
// files, so a dialog path added here under the core id would be silently
// replaced for every extension, Core and @api file. The typescript-eslint rule
// is the same rule under a different id, which nothing else sets. It also
// reports `import * as d` and `export { ask } from` (importNames covers both).
//
// A DYNAMIC import of the plugin cannot be name-checked at all, so it is
// refused outright (`no-restricted-syntax`); import `open` / `save`
// statically. Those selectors are repeated in the two colour blocks below,
// because they set `no-restricted-syntax` for their files and would otherwise
// replace this one there (last-wins again).
const DIALOG_PLUGIN_IMPORT_MESSAGE =
  'Banned: ask / confirm / message from @tauri-apps/plugin-dialog. They THROW when the dialog ' +
  'cannot be shown, so an uncaught call fails OPEN. Use confirmAsync / alertAsync from @api/dialogs ' +
  '(confirmOutcomeAsync when "no" also acts) and AWAIT the result. open / save stay allowed. ' +
  'Only src/core/lib/dialogs.ts may import them.'

const DIALOG_PLUGIN_IMPORT_PATH = {
  name: '@tauri-apps/plugin-dialog',
  importNames: ['ask', 'confirm', 'message'],
  message: DIALOG_PLUGIN_IMPORT_MESSAGE,
}

const DIALOG_PLUGIN_DYNAMIC_IMPORT_MESSAGE =
  'Import @tauri-apps/plugin-dialog statically: a dynamic import hides which function is taken ' +
  'from the ask / confirm / message ban. ' + DIALOG_PLUGIN_IMPORT_MESSAGE

// TWO spellings of the same specifier, one selector each. A quoted string is a
// `Literal` (it has a `value`); a backtick specifier is a `TemplateLiteral`,
// which has no `value` at all, so the first selector never sees it -- measured
// in the round-4 review: import(`@tauri-apps/plugin-dialog`) linted clean and
// handed back the raw `ask`. The second matches the template's static text, so
// a template that merely interpolates around the name is refused too. A
// specifier computed from a VARIABLE cannot be checked by any selector; no
// production file imports dynamically from a non-literal today.
const DIALOG_PLUGIN_DYNAMIC_IMPORTS = [
  {
    selector: "ImportExpression[source.value='@tauri-apps/plugin-dialog']",
    message: DIALOG_PLUGIN_DYNAMIC_IMPORT_MESSAGE,
  },
  {
    selector: 'ImportExpression > TemplateLiteral.source > TemplateElement[value.raw=/plugin-dialog/]',
    message: DIALOG_PLUGIN_DYNAMIC_IMPORT_MESSAGE,
  },
]

export const dialogGuardConfigs = [
  {
    files: ['src/**/*.{ts,tsx}', 'extensions/**/*.{ts,tsx}'],
    ignores: [
      // The single sanctioned wrapper: it must touch the raw globals to provide
      // the non-Tauri (jsdom / browser-smoke) fallback. It also carries inline
      // disables so the rule is still visible there rather than silently off.
      // Its @api/dialogs re-export needs no exemption — it touches no global.
      'src/core/lib/dialogs.ts',
      // Tests legitimately stub the globals (`window.confirm = vi.fn()`), and
      // jsdom has none of the Tauri hazards. Excluded so the gate reports only
      // shipping code. New PRODUCTION sites are still caught.
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        ...DIALOG_GLOBAL_NAMES.map((name) => ({ name, message: DIALOG_GLOBAL_MESSAGE })),
      ],
      'no-restricted-properties': [
        'error',
        ...DIALOG_GLOBAL_HOSTS.flatMap((object) =>
          DIALOG_GLOBAL_NAMES.map((property) => ({
            object,
            property,
            message: DIALOG_GLOBAL_MESSAGE,
          })),
        ),
      ],
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [DIALOG_PLUGIN_IMPORT_PATH] }],
      'no-restricted-syntax': ['error', ...DIALOG_PLUGIN_DYNAMIC_IMPORTS],
    },
  },
]

// =============================================================================
// MODEL EDITOR: no hardcoded colours
// =============================================================================
// The Model Editor window accumulated 362 hex literals and three independent
// palettes against 18 var() usages, and it never loaded the app's skin at all,
// so switching Calcula to Dark left it white. It now resolves every colour from
// components/theme.ts. This rule is what stops that drifting back one
// convenient `#fff` at a time — the drift was never a decision anyone made, it
// was 362 individually reasonable choices.
//
// theme.ts itself is exempt: it is the ONE place a literal is correct, as the
// fallback half of `var(--token, #literal)`.
const MODEL_EDITOR_HEX_MESSAGE =
  'Hardcoded colour in the Model Editor. Use a token from components/theme.ts ' +
  '(ME.surface, ME.text, ME.border, ME.dangerFg, …) so the window follows the ' +
  "user's skin. If the colour is genuinely categorical DATA (a chart series, a " +
  'node kind) keep it literal and say so in a comment, then add the file here.'

const modelEditorColorConfigs = [
  {
    files: ['extensions/ModelEditor/**/*.{ts,tsx}'],
    ignores: [
      // The token layer: literals here are the fallback half of var().
      'extensions/ModelEditor/components/theme.ts',
      // Resolves CSS variables into the real colour values Monaco demands (it
      // cannot read custom properties), so it needs the same literal fallbacks
      // theme.ts does.
      'extensions/ModelEditor/lib/monacoTheme.ts',
      // Categorical palettes whose colours identify a KIND, not a surface.
      // Each keeps a comment saying so, and each derives its BACKGROUND from a
      // token so the tint follows the theme even though the hue does not.
      'extensions/ModelEditor/components/sections/ExecutionPlanView.tsx',
      'extensions/ModelEditor/components/sections/LineageSection.tsx',
      // Monaco TOKEN CLASS NAMES, which happen to be spelled like colours.
      // `[/\s+/, "white"]` in a tokenizer means "classify this as whitespace",
      // not "paint it white" — the actual colours live in monacoTheme.ts. The
      // named-colour rule cannot tell the two apart from the AST, and a rule
      // that flags a correct line teaches people to ignore it.
      'extensions/ModelEditor/lib/measureLanguage.ts',
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Literal hex ANYWHERE in a string: style values, JSX attributes,
          // template chunks. Matches #rgb, #rgba, #rrggbb and #rrggbbaa.
          //
          // NOT anchored. It was `^#…$` — the hex had to be the WHOLE string —
          // so `"1px solid #2f6fce"` and `"var(--x, #d32f2f)"` sailed through,
          // and fifteen hardcoded colours survived the sweep that this rule
          // exists to make permanent. Three of them were one selection outline
          // written three times in the same file. A rule that catches the easy
          // spelling and misses the common one reads as enforcement and is not.
          selector:
            'Literal[value=/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\\b/]',
          message: MODEL_EDITOR_HEX_MESSAGE,
        },
        {
          selector: 'TemplateElement[value.raw=/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b/]',
          message: MODEL_EDITOR_HEX_MESSAGE,
        },
        {
          // A NAMED colour is a hardcoded colour too, and the ban never saw
          // one. `color: "red"` appeared seventeen times — every one of them an
          // error message — so the tab's error text was the one thing on screen
          // that ignored the skin entirely, and pure red on the dark ground is
          // the worst of the two. `transparent`, `inherit`, `currentColor` and
          // `none` are deliberately absent: they are structural, not colours.
          selector:
            'Literal[value=/^(?:red|blue|green|orange|yellow|purple|pink|brown|cyan|magenta|white|black|gray|grey|lime|navy|teal|olive|maroon|silver|gold)$/i]',
          message: MODEL_EDITOR_HEX_MESSAGE,
        },
        {
          // rgb()/rgba() in a style value. Shadows are the usual offender and
          // they belong in SHADOW (theme.ts), which is a three-level scale
          // precisely so a fourth elevation cannot be invented per file.
          selector: 'Literal[value=/rgba?\\(/]',
          message: MODEL_EDITOR_HEX_MESSAGE,
        },
        // The dialog block's selector: this block's no-restricted-syntax
        // replaces that block's for these files (flat config is last-wins).
        ...DIALOG_PLUGIN_DYNAMIC_IMPORTS,
      ],
    },
  },
]

// =============================================================================
// CALCULA CLUSTERS: the redesigned chrome paints with tokens only
// =============================================================================
// The ribbon + sidebar redesign (docs/design/ribbon-design-system.md) moved
// every ribbon tab, the cluster chrome, the rail, the side and task panes and
// the mini toolbar onto theme tokens, so a skin — including a company's own —
// restyles all of it. This rule is what keeps it that way: the drift that made
// the Chart Design tab hardcode Office blue/orange/grey into its icons was
// never a decision, it was a convenient literal at a time.
//
// DIFFERENT FROM THE MODEL EDITOR RULE ABOVE, deliberately. There, literals
// live only in components/theme.ts. Here the shell and extensions write
// `var(--token, #lightFallback)` inline — the fallback half is the documented
// idiom (extensions/_shared/lib/themeTokens.ts, src/api/layout/theme.ts), and a
// bare var() can invalidate a whole shorthand when a token is missing. So a
// literal is allowed ONLY inside a string that also contains `var(`; a string
// that carries a colour and no var() is the defect.
//
// Categorical colour DATA (chart palettes, style presets, standard colours) is
// not chrome: it lives in data modules outside this list, or is listed in the
// ignores below with the reason, and its rendered element carries
// data-colour-data so findHardcodedColours skips it in tests.
const CHROME_HEX_MESSAGE =
  'Hardcoded colour in redesigned chrome. Paint with LT (@api/layout), TOKENS ' +
  '(extensions/_shared/lib/themeTokens.ts) or var(--token, #lightFallback) so the ' +
  "surface follows the user's skin. Categorical colour DATA belongs in a data " +
  'module (and its element gets data-colour-data), not in a component.'

const chromeColorConfigs = [
  {
    files: [
      'src/api/layout/**/*.{ts,tsx}',
      'src/api/icons/**/*.{ts,tsx}',
      'src/api/ribbonIcons.tsx',
      'src/shell/Ribbon/**/*.{ts,tsx}',
      'src/shell/components/**/*.{ts,tsx}',
      'src/shell/ActivityBar/**/*.{ts,tsx}',
      'src/shell/TaskPane/**/*.{ts,tsx}',
      'src/shell/Toast/**/*.{ts,tsx}',
      'src/shell/StatusBar.tsx',
      'src/shell/Overlays/MiniFormatToolbar/**/*.{ts,tsx}',
      'extensions/Charts/components/ChartDesignSections.tsx',
      'extensions/Charts/components/ChartFilterDropdown.tsx',
      'extensions/Charts/components/chartTypeCatalog.ts',
      'extensions/Charts/components/ChartJsonPane.tsx',
      'extensions/BuiltIn/HomeTab/**/*.{ts,tsx}',
      'extensions/BuiltIn/DocumentTheme/**/*.{ts,tsx}',
      'extensions/Pivot/components/PivotAnalyzeSections.tsx',
      'extensions/Pivot/components/PivotDesignSections.tsx',
      'extensions/Pivot/components/PivotTableStylesGallery.tsx',
      'extensions/Table/components/TableDesignTab.tsx',
      'extensions/Table/components/TableStylesGallery.tsx',
      'extensions/Table/components/TableJsonPane.tsx',
      'extensions/Slicer/components/SlicerOptionsSections.tsx',
      'extensions/Slicer/components/SlicerStylesGallery.tsx',
      'extensions/TimelineSlicer/components/TimelineSlicerOptionsTab.tsx',
      'extensions/Sparklines/components/SparklineDesignSections.tsx',
      'extensions/Sparklines/components/SparklineColorPicker.tsx',
      'extensions/ControlsPane/components/**/*.{ts,tsx}',
      'extensions/Reports/components/ReportTabSection.tsx',
      'extensions/CanvasSheet/components/**/*.{ts,tsx}',
      'extensions/ExtensionsManager/AddInsRibbonSection.tsx',
      'extensions/Animation/components/TimelineSections.tsx',
      'extensions/Settings/components/**/*.{ts,tsx}',
      'extensions/Settings/SettingsView.tsx',
      'extensions/_template/**/*.{ts,tsx}',
      // The shared pickers and panes the ribbon, the panes and the dialogs
      // open: once a colour picker follows the skin, a dialog that hosts it
      // must not repaint it in Office blue.
      'extensions/BuiltIn/FormatCellsDialog/components/ColorPicker.tsx',
      'extensions/_shared/components/FieldList.tsx',
      'extensions/_shared/components/EditorStyles.ts',
      'extensions/_shared/components/jsonToggle/**/*.{ts,tsx}',
    ],
    ignores: [
      // The token layer: literals here are the fallback half of var().
      'src/api/layout/theme.ts',
      // Colour DATA: the Office standard row and the quick set.
      'src/api/layout/colors.ts',
      // The colour-literal detector itself names colours in its pattern.
      'src/api/layout/testing.ts',
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/^(?![\\s\\S]*var\\()[\\s\\S]*#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\\b/]',
          message: CHROME_HEX_MESSAGE,
        },
        {
          selector:
            'TemplateElement[value.raw=/^(?![\\s\\S]*var\\()[\\s\\S]*#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\\b/]',
          message: CHROME_HEX_MESSAGE,
        },
        {
          selector:
            'Literal[value=/^(?:red|blue|green|orange|yellow|purple|pink|brown|cyan|magenta|white|black|gray|grey|lime|navy|teal|olive|maroon|silver|gold)$/i]',
          message: CHROME_HEX_MESSAGE,
        },
        {
          selector: 'Literal[value=/^(?![\\s\\S]*var\\()[\\s\\S]*\\brgba?\\(/]',
          message: CHROME_HEX_MESSAGE,
        },
        {
          selector: 'TemplateElement[value.raw=/^(?![\\s\\S]*var\\()[\\s\\S]*\\brgba?\\(/]',
          message: CHROME_HEX_MESSAGE,
        },
        // The dialog block's selector: this block's no-restricted-syntax
        // replaces that block's for these files (flat config is last-wins).
        ...DIALOG_PLUGIN_DYNAMIC_IMPORTS,
      ],
    },
  },
]

export const boundaryConfigs = [
  ...dialogGuardConfigs,
  ...modelEditorColorConfigs,
  ...chromeColorConfigs,

  // FACADE RULE: Extensions must ONLY import from src/api (no deep core/shell),
  // and must NOT reach the raw @api/backend invokeBackend door (A3).
  {
    files: ['extensions/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [BOUNDARY_SEVERITY.facade, {
        patterns: FACADE_IMPORT_PATTERNS,
        paths: [RAW_BACKEND_INVOKE_PATH, RAW_TAURI_INVOKE_PATH, RAW_TAURI_EVENT_PATH],
      }],
    },
  },

  // ALIEN RULE: Core cannot import from Shell or Extensions.
  {
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [BOUNDARY_SEVERITY.alien, {
        patterns: [
          {
            group: ['**/src/shell/**', '**/shell/**', '@shell', '@shell/*'],
            message: 'Core must not depend on the Shell (Alien Rule).',
          },
          {
            group: ['**/extensions/**', '@extensions', '@extensions/*'],
            message: 'Core must not depend on Extensions (Alien Rule).',
          },
        ],
      }],
    },
  },

  // API NEUTRALITY: the facade is a feature-agnostic contract.
  // src/api must NOT import from a specific extension (No First-Class Citizens).
  {
    files: ['src/api/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [BOUNDARY_SEVERITY.apiNeutrality, {
        patterns: [
          {
            group: ['**/extensions/**', '../../extensions/*', '@extensions', '@extensions/*'],
            message: 'The API facade must not import from a specific extension. Move the contract into src/api (No First-Class Citizens).',
          },
        ],
      }],
    },
  },

  // ELEMENT-TYPE BOUNDARIES (eslint-plugin-boundaries):
  // Enforces the layered architecture AND "extensions know nothing about each
  // other" — which no-restricted-imports cannot express generically. Relative
  // cross-element imports are resolved via the node resolver with TS extensions
  // added; alias (@api/@core/@shell) imports are governed by the rules above.
  {
    files: ['src/**/*.{ts,tsx}', 'extensions/**/*.{ts,tsx}'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      // TestRunner is the dev-only integration-test harness; like __tests__ it
      // imports other extensions' internals in order to test them.
      'extensions/TestRunner/**',
    ],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        node: { extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'] },
      },
      // Govern re-exports and lazy imports too — not just static `import`. The
      // plugin defaults to ['import'], which let sibling-isolation / api->shell
      // be laundered via `export … from` and dynamic `import()` (both invisible
      // to the gate). With these on, those paths are boundary-checked like a
      // normal import.
      'boundaries/dependency-nodes': ['import', 'dynamic-import', 'export'],
      'boundaries/include': ['src/**/*', 'extensions/**/*'],
      'boundaries/elements': [
        { type: 'api', pattern: 'src/api', mode: 'folder' },
        { type: 'core', pattern: 'src/core', mode: 'folder' },
        { type: 'shell', pattern: 'src/shell', mode: 'folder' },
        { type: 'lib', pattern: 'src/utils', mode: 'folder' },
        { type: 'app-entry', pattern: 'src/*.{ts,tsx}', mode: 'file' },
        { type: 'ext-shared', pattern: 'extensions/_shared', mode: 'folder' },
        { type: 'ext-template', pattern: 'extensions/_template', mode: 'folder' },
        { type: 'ext-manifest', pattern: 'extensions/manifest.ts', mode: 'file' },
        { type: 'ext-index', pattern: 'extensions/index.ts', mode: 'file' },
        { type: 'builtin', pattern: 'extensions/BuiltIn/*', mode: 'folder', capture: ['name'] },
        { type: 'standard', pattern: 'extensions/_standard/*', mode: 'folder', capture: ['name'] },
        { type: 'extension', pattern: 'extensions/*', mode: 'folder', capture: ['name'] },
      ],
    },
    rules: {
      'boundaries/element-types': [BOUNDARY_SEVERITY.sibling, {
        default: 'disallow',
        message: '${file.type} may not import ${dependency.type} — architecture boundary (Independence Through Boundaries).',
        rules: [
          // Composition roots: app entry points (incl. per-window editor mains)
          // and the extension aggregators may mount any feature.
          { from: ['app-entry'], allow: ['app-entry', 'api', 'core', 'shell', 'lib', 'ext-manifest', 'ext-index', 'extension', 'builtin', 'standard'] },
          { from: ['lib'], allow: ['lib', 'core', 'api'] },
          // Core: api + lib only. Never shell or extensions (Alien Rule).
          { from: ['core'], allow: ['core', 'api', 'lib'] },
          // API facade: core + lib only. Never an extension (No First-Class
          // Citizens) and never the Shell (layering: shell->api->core).
          { from: ['api'], allow: ['api', 'core', 'lib'] },
          // Shell: the extension HOST — orchestrates core + api and loads/mounts
          // extensions. shell->extension is its job (distinct from the Alien Rule,
          // which forbids core->extension). The A4 nuance (Layout importing a
          // specific built-in's component directly, bypassing the manifest) is a
          // finer concern tracked separately, not expressible via element-types.
          { from: ['shell'], allow: ['shell', 'core', 'api', 'lib', 'ext-manifest', 'ext-index', 'extension', 'builtin', 'standard'] },
          // Extensions: api + _shared + their OWN subtree only. No siblings, no core/shell.
          { from: ['extension'], allow: ['api', 'ext-shared', ['extension', { name: '${from.name}' }]] },
          { from: ['builtin'], allow: ['api', 'ext-shared', ['builtin', { name: '${from.name}' }]] },
          { from: ['standard'], allow: ['api', 'ext-shared', ['standard', { name: '${from.name}' }]] },
          { from: ['ext-shared'], allow: ['api', 'core', 'lib', 'ext-shared'] },
          { from: ['ext-template'], allow: ['api', 'ext-shared'] },
          // Aggregators: allowed to reference every extension.
          { from: ['ext-manifest', 'ext-index'], allow: ['api', 'ext-shared', 'extension', 'builtin', 'standard'] },
        ],
      }],
    },
  },

  // RAW BACKEND DOOR — tests + the dev-only TestRunner harness legitimately reach
  // the raw invokeBackend (TestRunner) or mock @api/backend (unit tests). This
  // block comes AFTER the FACADE block and, for these files only, re-declares the
  // Facade patterns WITHOUT the raw-invoke ban (flat-config is last-wins per rule
  // id). The core/shell Facade patterns still apply to them.
  {
    files: [
      'extensions/**/__tests__/**/*.{ts,tsx}',
      'extensions/**/*.{test,spec}.{ts,tsx}',
      'extensions/TestRunner/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [BOUNDARY_SEVERITY.facade, {
        patterns: FACADE_IMPORT_PATTERNS,
      }],
    },
  },
]
