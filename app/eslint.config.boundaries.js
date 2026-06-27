// =============================================================================
// ARCHITECTURE BOUNDARY GATE — CI config
// =============================================================================
// Runs ONLY the architecture-boundary rules (./eslint.boundaries.js), with none
// of the project's other lint rules. This is deliberate: the full `eslint .`
// surface carries thousands of pre-existing style/type lint findings that are
// out of scope for boundary enforcement and would mask a real boundary
// regression. This config reports boundary violations and nothing else, so it
// can be a meaningful CI gate.
//
//   Run with:  npm run lint:boundaries   (eslint -c eslint.config.boundaries.js .)
//
// Boundary rules use only the import specifier + element classification (no
// type information), so a lightweight parser with no projectService is enough
// and keeps the gate fast.
// =============================================================================

import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'
import { boundaryConfigs } from './eslint.boundaries.js'

export default defineConfig([
  globalIgnores(['dist', '.tmp', 'src-tauri', 'node_modules', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    // Only the boundary rules below are enabled, so inline eslint-disable
    // comments in source target rules that are off here and are harmless
    // no-ops. Silence the "unused directive" reports so the gate output is
    // exclusively architecture-boundary findings.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    // Register (but do NOT enable) the plugins referenced by inline
    // eslint-disable comments in source, so those directives resolve to a known
    // rule instead of erroring with "Definition for rule X was not found".
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2020,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  ...boundaryConfigs,
])
