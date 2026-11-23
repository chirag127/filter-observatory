import { defineConfig } from 'wxt';

export default defineConfig({
  imports: false,
  manifest: ({ browser }) => ({
    name: 'Filter Observatory',
    description: 'Capture the current viewport and queue evidence for your local audit worker.',
    permissions: ['activeTab', 'scripting', 'storage', 'alarms'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
    commands: {
      'capture-evidence': {
        description: 'Capture this viewport for Filter Observatory',
        ...(browser === 'chrome' ? { suggested_key: { windows: 'Ctrl+Q' } } : {}),
      },
    },
    ...(browser === 'chrome'
      ? { minimum_chrome_version: '106' }
      : {
          browser_specific_settings: {
            gecko: { id: 'filter-observatory@chirag127.github.io', strict_min_version: '127.0' },
          },
        }),
  }),
  zip: {
    includeSources: [
      'entrypoints/**',
      'utils/**',
      'components/**',
      'assets/**',
      'public/**',
      'wxt.config.ts',
      'tsconfig.json',
      'package.json',
      'package-lock.json',
      'README.md',
    ],
    excludeSources: ['test-results/**', '**/*.private.json', '**/.env*'],
  },
});
