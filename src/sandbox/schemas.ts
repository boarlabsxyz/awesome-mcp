// Parameter schemas for the Sandbox MCP tools. Argument names stay out of the
// analytics PREVIEW_KEYS allowlist (src/usage/argSummary.ts) — `code`, `path`
// and `content` are never recorded — so code and data never reach usage rows.
import { z } from 'zod';

export const runCodeSchema = z.object({
  language: z.enum(['python', 'javascript', 'bash']).default('python')
    .describe('python (default) and javascript keep their variables between calls; bash runs a shell command.'),
  code: z.string().min(1).max(200_000).describe('The code to run.'),
  timeoutSec: z.number().int().min(1).max(300).default(120)
    .describe('Stop the run after this many seconds (max 300, the lifetime of the run\'s REST token).'),
});

const path = z.string().min(1).max(1024);

export const listFilesSchema = z.object({
  path: path.default('/home/user').describe('Directory to list. Default /home/user, the working directory.'),
});

export const readFileSchema = z.object({
  path: path.describe('File to read, e.g. /home/user/report.csv.'),
  maxChars: z.number().int().min(1).max(100_000).default(20_000).describe('Return at most this many characters of a text file.'),
});

export const writeFileSchema = z.object({
  path: path.describe('Where to write, e.g. /home/user/input.csv. Parent directories are created.'),
  content: z.string().max(1_000_000).describe('Text content, at most 1 MB. For more, have a script fetch the data over the REST API.'),
});

export const sandboxStatusSchema = z.object({});
export const resetSandboxSchema = z.object({});
