import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', '.wrangler/', 'worker-configuration.d.ts', '**/.obsidian/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Anchor the parser to this directory: the repo's pre-push hook lints changed files
    // from the repo root, where two tsconfig roots are candidates and parsing fails
    // (2026-10-06, the first gankdat push through the hook).
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    // Node scripts run outside the Workers runtime (CLI tooling + Apify actors).
    files: ['scripts/**/*.mjs', 'apify/**/*.mjs'],
    // Plain JS: JSDoc carries the types; the TS boundary rule does not apply.
    rules: { '@typescript-eslint/explicit-module-boundary-types': 'off' },
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // Browser client scripts for the static pages (public/js/*.js): run in the
    // DOM, not the Workers runtime, so declare the browser globals they use.
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        history: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        matchMedia: 'readonly',
        getSelection: 'readonly',
        confirm: 'readonly',
        setTimeout: 'readonly',
        requestAnimationFrame: 'readonly',
        performance: 'readonly',
        addEventListener: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        // Global injected by the Scalar CDN bundle on the docs page.
        Scalar: 'readonly',
      },
    },
    rules: {
      // `try { … } catch {}` (ignore best-effort failures) is intentional here.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
