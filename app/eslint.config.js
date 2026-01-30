//! FILENAME: app/eslint.config.js
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
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
    },
  },
  // =========================================================================
  // Architecture boundary enforcement (Microkernel rules)
  // 1. Extensions must ONLY import from src/api, never from src/core or src/shell
  // 2. Core must NEVER import from extensions or shell
  // =========================================================================
  {
    files: ['extensions/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/src/core/**'],
          message: 'Extensions must import from src/api/ only, not directly from src/core/.',
        }, {
          group: ['**/src/shell/**'],
          message: 'Extensions must import from src/api/ only, not directly from src/shell/.',
        }],
      }],
    },
  },
  {
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/extensions/**'],
          message: 'Core must not import from extensions.',
        }, {
          group: ['**/src/shell/**', '**/shell/**'],
          message: 'Core must not import from shell.',
        }],
      }],
    },
  },
])
