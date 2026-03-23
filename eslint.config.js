import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', '*.js', '!eslint.config.js'],
  },
  {
    rules: {
      // Relaxed for existing codebase — tighten incrementally
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': 'warn',
      'prefer-const': 'warn',
      'preserve-caught-error': 'off',
    },
  },
);
