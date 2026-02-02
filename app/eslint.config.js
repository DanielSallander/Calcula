import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.tmp']),
  {
    // Base configuration for all TS files
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    // Register the boundaries plugin here
    plugins: {
      boundaries,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        // "projectService" is required for @typescript-eslint/naming-convention
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // =========================================================================
    // ARCHITECTURE SETTINGS
    // Define what your folders represent
    // =========================================================================
    settings: {
      "boundaries/include": ["src/**/*", "extensions/**/*"],
      "boundaries/elements": [
        {
          type: "core",
          mode: "full",
          pattern: "src/core"
        },
        {
          type: "shell",
          mode: "full",
          pattern: "src/shell"
        },
        {
          type: "api",
          mode: "full",
          pattern: "src/api"
        },
        {
          type: "extension",
          mode: "full",
          pattern: "extensions"
        }
      ]
    },
    rules: {
      // 1. BOUNDARIES: Ensure imports match the Microkernel Architecture
      "boundaries/no-unknown": "error",
      "boundaries/element-types": [
        "error",
        {
          default: "allow",
          rules: [
            // ALIEN RULE: Core cannot import Shell or Extensions
            {
              from: "core",
              disallow: ["shell", "extension"],
              message: "CRITICAL: The Core Engine cannot depend on the Shell or Extensions."
            },
            // FACADE RULE: Extensions can ONLY import API
            {
              from: "extension",
              allow: ["api"], 
              disallow: ["core", "shell", "extension"],
              message: "SANDBOX VIOLATION: Extensions may only speak to the API Facade."
            },
            // API RULE: API is a contract, cannot depend on volatile Shell/Extensions
            {
              from: "api",
              disallow: ["shell", "extension"],
              message: "The API is a stable contract and cannot depend on volatile layers."
            }
          ]
        }
      ],

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
          "selector": "typeLike",
          "format": ["PascalCase"]
        },
        {
          "selector": "objectLiteralProperty",
          "format": ["camelCase"] // STRICT: Forces { styleIndex: 1 } instead of { style_index: 1 }
        }
      ],

      // React specific tweaks
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
])