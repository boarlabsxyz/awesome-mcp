// Pyodide packages baked into the runner image (prefetch.ts) and loaded on
// import. Their dependencies come along. The workers' package directory is
// read-only — a shared writable one would let one user's code plant a wheel
// that another user's interpreter loads — so a Pyodide package missing here
// cannot be loaded at all; pure-Python ones still install from PyPI with
// micropip. Keep the runCode description's list in step.
export const BUNDLED_PACKAGES = [
  'micropip',
  'numpy',
  'pandas',
  'matplotlib',
  'scipy',
  'scikit-learn',
  'pyarrow',
  'duckdb',
  'requests',
  'beautifulsoup4',
  'lxml',
  'pyyaml',
  'xlrd',
  'regex',
  'pillow',
];
