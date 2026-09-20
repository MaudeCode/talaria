// @ts-check
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['node_modules', 'dist', 'fixtures'] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'] }, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // Ported Python code relies on `''`/`0` falling through to a fallback; `??` would change behaviour.
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: true }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['**/*.test.ts', 'scripts/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off', '@typescript-eslint/no-floating-promises': 'off' },
  },
)
