// The runner service's HTTP API: the SandboxProvider interface, one route per
// method, for the Sandbox MCP service (client.ts) to call over Railway's
// private network. Every route but /health needs SANDBOX_RUNNER_SECRET. The
// caller is trusted to have checked the user, the lock and the quota; this
// side only runs code and keeps files.
import * as crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SandboxHandle, SandboxProvider } from '../provider.js';

const createBody = z.object({
  userId: z.number().int(),
  timeoutMs: z.number().int().positive(),
  allowNet: z.array(z.string().max(260)).max(20),
});
const runBody = z.object({
  code: z.string().max(200_000),
  language: z.enum(['python', 'javascript']),
  envs: z.record(z.string()),
  timeoutMs: z.number().int().positive().max(600_000),
  maxOutputChars: z.number().int().positive().max(1_000_000),
});
const timeoutBody = z.object({ timeoutMs: z.number().int().positive() });
const writeBody = z.object({ path: z.string().min(1).max(1024), content: z.string().max(1_000_000) });
const pathQuery = z.object({ path: z.string().min(1).max(1024) });
const readQuery = pathQuery.extend({ maxBytes: z.coerce.number().int().min(0).max(10_000_000) });

function sameSecret(given: string, secret: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createRunnerApp(provider: SandboxProvider & { stats?: () => object }, secret: string) {
  if (!secret) throw new Error('The sandbox runner needs SANDBOX_RUNNER_SECRET.');
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true, ...provider.stats?.() });
  });

  app.use((req, res, next) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || !sameSecret(header.slice(7), secret)) {
      res.status(401).json({ error: 'The sandbox runner refused the caller: SANDBOX_RUNNER_SECRET does not match.' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  /** The sandbox the path names; a stopped one is a 404 the client turns into "gone". */
  const sandbox = async (req: Request): Promise<SandboxHandle> => {
    const handle = await provider.connect(String(req.params.id));
    if (!handle) throw Object.assign(new Error('This sandbox has stopped.'), { name: 'NotFoundError' });
    return handle;
  };

  app.post('/sandboxes', async (req, res) => {
    const handle = await provider.create(createBody.parse(req.body));
    res.status(201).json({ id: handle.id });
  });

  app.get('/sandboxes/:id', async (req, res) => {
    const endsAt = await provider.endsAt(String(req.params.id));
    if (!endsAt) {
      res.status(404).json({ error: 'This sandbox has stopped.' });
      return;
    }
    res.json({ endsAt: endsAt.toISOString() });
  });

  app.delete('/sandboxes/:id', async (req, res) => {
    await provider.kill(String(req.params.id));
    res.status(204).end();
  });

  app.post('/sandboxes/:id/run', async (req, res) => {
    const { code, ...opts } = runBody.parse(req.body);
    res.json(await (await sandbox(req)).runCode(code, opts));
  });

  app.post('/sandboxes/:id/timeout', async (req, res) => {
    await (await sandbox(req)).setTimeout(timeoutBody.parse(req.body).timeoutMs);
    res.status(204).end();
  });

  app.get('/sandboxes/:id/files', async (req, res) => {
    res.json({ entries: await (await sandbox(req)).listFiles(pathQuery.parse(req.query).path) });
  });

  app.get('/sandboxes/:id/file', async (req, res) => {
    const { path, maxBytes } = readQuery.parse(req.query);
    const file = await (await sandbox(req)).readFile(path, maxBytes);
    res.json({ size: file.size, data: Buffer.from(file.bytes).toString('base64') });
  });

  app.put('/sandboxes/:id/file', async (req, res) => {
    const { path, content } = writeBody.parse(req.body);
    await (await sandbox(req)).writeFile(path, content);
    res.status(204).end();
  });

  // Express 5 routes rejected promises here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { name?: string; message?: string; issues?: unknown };
    if (err instanceof z.ZodError) res.status(400).json({ error: `Bad request to the sandbox runner: ${err.message}` });
    else if (e?.name === 'NotFoundError') res.status(404).json({ error: e.message });
    else if (e?.name === 'SandboxRefusal') res.status(409).json({ error: e.message });
    else res.status(500).json({ error: e?.message ?? String(err) });
  });
  return app;
}
