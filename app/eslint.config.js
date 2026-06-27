import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { boundaryConfigs } from './eslint.boundaries.js'

export default defineConfig([
  globalIgnores(['dist', '.tmp', 'src-tauri']),
  {
    // Base configuration for all TS files
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        // "projectService" is required for @typescript-eslint/naming-convention
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {

      // 2. NAMING CONVENTION: Enforce camelCase for Rust compatibility
      "@typescript-eslint/naming-convention": [
        "error",
        {
          "selector": "default",
          "format": ["camelCase"]
        },
        {
          "selector": "variable",
          "format": ["camelCase", "UPPER_CASE", "PascalCase"]
        },
        {
          "selector": "function",
          "format": ["camelCase", "PascalCase"] // React components are PascalCase
        },
        {
          "selector": "import",
          "format": ["camelCase", "PascalCase", "UPPER_CASE"]
        },
        {
          "selector": "typeLike",
          "format": ["PascalCase"]
        },
        {
          "selector": "parameter",
          "format": ["camelCase"],
          "leadingUnderscore": "allow"
        },
        {
          "selector": "objectLiteralProperty",
          "format": ["camelCase", "UPPER_CASE", "snake_case"]
        },
        {
          "selector": "typeProperty",
          "format": ["camelCase", "snake_case"]
        }
      ],

      // Allow unused variables/params with underscore prefix
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ],

      // React specific tweaks
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },

  // =========================================================================
  // ARCHITECTURE BOUNDARY ENFORCEMENT
  // Defined once in ./eslint.boundaries.js (single source of truth) and reused
  // by the dedicated gate config ./eslint.config.boundaries.js (run in CI via
  // `npm run lint:boundaries`). Spread here too so editors surface boundary
  // violations inline.
  // =========================================================================
  ...boundaryConfigs,
])