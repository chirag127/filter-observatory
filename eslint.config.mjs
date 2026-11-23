import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.wxt/**',
      '**/.output/**',
      '**/dist/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/megalinter-reports/**',
      'contributions/**',
    ],
  },
  {
    ...js.configs.recommended,
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  // Input validators deliberately match forbidden control characters.
  {
    files: ['src/{analysis,browser,capture,catalog,config,corpus,reports}.mjs'],
    rules: { 'no-control-regex': 'off' },
  },
  { files: ['public/**/*.mjs'], languageOptions: { globals: { ...globals.browser } } },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['companion/**/*.ts'] })),
  {
    files: ['companion/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
];
