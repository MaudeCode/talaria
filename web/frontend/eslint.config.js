// @ts-check
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/** Files allowed to talk to the network directly: the single typed client. */
const NETWORK_ALLOWED = ['src/api/client.ts', 'src/api/sse.ts', 'src/sw.ts', 'src/lib/clientEvents.ts', 'src/features/presence/presence.ts', 'src/features/voice/tts.ts']

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'src/paraglide', 'src/routeTree.gen.ts', 'playwright-report', 'test-results', '.tanstack'] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true, boolean: true } }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-restricted-properties': ['error',
        { object: 'window', property: 'fetch', message: 'Use the typed client in src/api/client.ts' },
        { object: 'globalThis', property: 'fetch', message: 'Use the typed client in src/api/client.ts' },
      ],
      'no-restricted-globals': ['error',
        { name: 'fetch', message: 'Use the typed client in src/api/client.ts' },
        { name: 'EventSource', message: 'Use the SSE helper in src/api/sse.ts' },
      ],
      'no-restricted-syntax': ['error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Raw HTML sinks are forbidden; render typed components or Streamdown.' },
        { selector: "MemberExpression[property.name='innerHTML']", message: 'innerHTML is forbidden; render through React.' },
        { selector: "MemberExpression[property.name='outerHTML']", message: 'outerHTML is forbidden; render through React.' },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'insertAdjacentHTML is forbidden.' },
      ],
    },
  },
  {
    // TanStack Router's redirect()/notFound() are thrown control-flow objects by design.
    files: ['src/routes/**', 'src/features/**/*.tsx'],
    rules: { '@typescript-eslint/only-throw-error': 'off' },
  },
  {
    files: NETWORK_ALLOWED,
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**', 'scripts/**', 'src/test/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  { files: ['scripts/**/*.mjs', 'eslint.config.js'], ...tseslint.configs.disableTypeChecked },
)
