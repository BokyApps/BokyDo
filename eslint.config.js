import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import regexp from 'eslint-plugin-regexp';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'apps/server/drizzle/**',
      'apps/android/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_' },
      ],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // ReDoS gate: no regex may backtrack super-linearly on hostile input.
    plugins: { regexp },
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
      'regexp/no-dupe-disjunctions': 'error',
      'regexp/no-misleading-capturing-group': 'error',
      'regexp/no-useless-quantifier': 'error',
      'regexp/no-empty-alternative': 'error',
    },
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Untrusted task content must go through the sanitised Markdown renderer, never this.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Use the sanitised Markdown renderer instead of dangerouslySetInnerHTML.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
