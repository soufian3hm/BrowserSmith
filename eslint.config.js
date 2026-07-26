'use strict';
/**
 * ESLint flat config for BrowserSmith.
 *
 * The three environments in this repo are genuinely different and a single
 * globals set makes real bugs invisible: the main process is Node, the control
 * renderer is a browser page with no Node at all, and the chat-tab preload is a
 * sandboxed page that may still `require('electron')`. Splitting them is what
 * makes `no-undef` able to catch a typo'd API instead of shrugging at it.
 */
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    // Nothing here is ours to lint: `workspace` holds AI-authored projects and
    // `.profile` is a live Chromium session directory.
    ignores: [
      'node_modules/**',
      'workspace/**',
      '.profile/**',
      'build-out/**',
      'dist/**',
      'out/**',
      '*-win32-*/**',
      '*-darwin-*/**',
      '*-linux-*/**',
      'assets/**',
    ],
  },

  js.configs.recommended,

  {
    // Main process, shared contract, MCP server, tooling and tests: CommonJS
    // on Node.
    files: [
      'src/main/**/*.js',
      'src/shared/**/*.js',
      'src/mcp/**/*.js',
      'tools/**/*.js',
      'test/**/*.js',
      'eslint.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  {
    // The chat-tab preload is sandboxed and runs inside the page: it owns all
    // the DOM knowledge and still reaches ipcRenderer.
    files: ['src/main/preload-chatgpt.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },

  {
    // The control renderer is loaded with a plain <script> tag: no module
    // wrapper, no require, no process.
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },

  {
    rules: {
      // `catch { /* already gone */ }` is a deliberate pattern all over the
      // toolchain - a kill that races a process that already exited is not an
      // error worth handling.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Handlers are written `(_e, payload)`; the leading argument is part of
      // the Electron signature and cannot be dropped.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      // This is a desktop tool whose console output is the debugging channel.
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-throw-literal': 'error',
      // A dropped `await` inside the agent loop looks like a chat tab that
      // answered instantly with nothing.
      'require-atomic-updates': 'off',
      'no-return-await': 'error',
    },
  },

  // Must stay last: turns off every rule that would fight Prettier.
  prettier,
];
