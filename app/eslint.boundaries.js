// =============================================================================
// ARCHITECTURE BOUNDARY RULES — single source of truth
// =============================================================================
// These flat-config blocks encode Calcula's microkernel boundaries
// (see ARCHITECTURE.md + PHILOSOPHY.md "Independence Through Boundaries"):
//
//   1. ALIEN RULE      — Core must not import Shell or Extensions.
//   2. FACADE RULE     — Extensions must import only through src/api.
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

export const boundaryConfigs = [
  // FACADE RULE: Extensions must ONLY import from src/api (no deep core/shell).
  {
    files: ['extensions/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [BOUNDARY_SEVERITY.facade, {
        patterns: [
          {
            group: ['**/src/core/**', '**/core/types/**', '**/core/types', '**/core/lib/**', '**/core/state/**', '@core', '@core/*'],
            message: 'Extensions must import through src/api only (Facade Rule).',
          },
          {
            group: ['**/src/shell/**', '**/shell/registries/**', '**/shell/Ribbon/**', '@shell', '@shell/*'],
            message: 'Extensions must import through src/api only (Facade Rule).',
          },
        ],
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
]
