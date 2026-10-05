import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const WORKSPACE = [
  '@crateball/sim',
  '@crateball/protocol',
  '@crateball/client',
  '@crateball/server',
  '@crateball/devtools',
  '@crateball/assets',
];
const NODE_BUILTINS = builtinModules.flatMap((m) => [m, `${m}/*`]);
// Gitignore tarzı desenler './net' gibi göreli yolları 'net' sanır; göreli yolları hariç tut.
const RELATIVE_OK = ['!./*', '!../*', '!./**', '!../**'];
const restrict = (group, message) => ['error', { patterns: [{ group, message }] }];

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'desktop/out/**',
      'prototypes/**',
      'logs/**',
      'test-results/**',
      'playwright-report/**',
      '.claude/**',
      '.superpowers/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Node globalleri yalnızca Node'da koşan dosyalarda (M0 backlog).
  {
    files: [
      'packages/server/**',
      'desktop/**',
      'scripts/**',
      'tests/**',
      '*.config.ts',
      'eslint.config.js',
      'packages/*/vite.config.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: [
      'packages/client/**',
      'packages/devtools/**',
      'packages/assets/**',
      'tests/e2e/**',
      'tests/e2e-prod/**',
    ],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['packages/sim/src/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ['three', 'three/*', 'ws', 'node:*', ...NODE_BUILTINS, ...WORKSPACE],
        'sim saf kalmalı: ekran, ağ, Node ve diğer paketlere bağımlı olamaz.',
      ),
      'no-restricted-syntax': [
        'error',
        { selector: 'ImportExpression', message: 'sim dinamik import kullanamaz.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'sim deterministik olmalı: createRng(seed) kullan.' },
        { object: 'globalThis', property: 'Math', message: 'sim globalThis üzerinden Math kullanamaz.' },
        {
          object: 'globalThis',
          property: 'Date',
          message: 'sim duvar saatine erişemez; tick sayacını kullan.',
        },
        { object: 'globalThis', property: 'performance', message: 'sim duvar saatine erişemez.' },
        { object: 'globalThis', property: 'process', message: 'sim Node ortamına erişemez.' },
      ],
      // typescript-eslint recommended TS'te no-undef'i kapatır; DOM ve Node globalleri hedefli yasaklanır.
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'performance',
        'Date',
        'process',
        'Buffer',
        'global',
        'require',
        'module',
        '__dirname',
        '__filename',
        'setTimeout',
        'setInterval',
      ],
    },
  },
  {
    // İzin listesi: yalnızca three, three/* ve paket içi göreli yollar. (Paket dışına çıkan göreli yollar M0 kararıyla kapsam dışı.)
    files: ['packages/assets/src/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ['*', '*/**', '!three', '!three/**', ...RELATIVE_OK, '!.', '!..'],
        'assets yalnızca three paketine ve kendi dosyalarına bağlı olabilir.',
      ),
    },
  },
  {
    files: ['packages/protocol/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@crateball/sim',
              message: "protocol @crateball/sim'den sadece tip alabilir (import type).",
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
              group: [
                'three',
                'three/*',
                'ws',
                'node:*',
                ...NODE_BUILTINS,
                ...RELATIVE_OK,
                ...WORKSPACE.filter((p) => p !== '@crateball/sim'),
              ],
              message: 'protocol sadece @crateball/sim tiplerine bağlı olabilir.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/client/src/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ['@crateball/server', 'ws', 'node:*', ...NODE_BUILTINS, ...RELATIVE_OK],
        'client sunucu koduna ve Node modüllerine bağlanamaz.',
      ),
    },
  },
  {
    files: ['packages/server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ['@crateball/client', '@crateball/assets', 'three', 'three/*'],
        'server render koduna bağlanamaz.',
      ),
    },
  },
  {
    files: ['packages/devtools/src/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(
        [
          '@crateball/server',
          '@crateball/client',
          '@crateball/assets',
          'node:*',
          ...NODE_BUILTINS,
          ...RELATIVE_OK,
        ],
        'devtools client/server içine takılır, onlara ve Node modüllerine bağımlı olmaz.',
      ),
    },
  },
);
