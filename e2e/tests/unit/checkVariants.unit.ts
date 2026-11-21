import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// runToolCheck names a forensics bundle service.tool.shape[.variant]. Two checks
// in one file share the first three, so each needs its own variant or the later
// bundle overwrites the earlier one -- usually the failure someone came to read.

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');

test('checks that share a file carry distinct variants', () => {
  const problems: string[] = [];
  for (const shape of readdirSync(toolsDir).filter((d) => statSync(join(toolsDir, d)).isDirectory())) {
    for (const file of readdirSync(join(toolsDir, shape)).filter((f) => f.endsWith('.check.ts'))) {
      const src = readFileSync(join(toolsDir, shape, file), 'utf8');
      const calls = src.split(/await runToolCheck\b/).slice(1);
      if (calls.length < 2) continue;
      const variants = calls.map((c) => c.match(/^[^]*?\n\s+variant: '([^']+)'/)?.[1]);
      if (variants.some((v) => v === undefined) || new Set(variants).size !== variants.length) {
        problems.push(`${shape}/${file}: ${JSON.stringify(variants)}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
