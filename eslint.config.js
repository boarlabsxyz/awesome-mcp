import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', '*.js', '**/*.mjs', '!eslint.config.js'],
  },
  {
    // Browser scripts served straight from public/ — no bundler, no TS build.
    // Until public/docs/docs.js there were no standalone .js files here (the
    // other pages inline their script), so nothing had ever declared the DOM
    // globals and every `document` read as undefined.
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        setTimeout: 'readonly',
        IntersectionObserver: 'readonly',
      },
    },
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
