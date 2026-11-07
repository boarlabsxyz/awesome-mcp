import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { WorkerProcess, type WorkerCommand } from '../../../sandbox/runner/workerProcess.js';

// A stand-in for worker.ts, run by Node: the same protocol, scripted by the code it is sent.
const FAKE_WORKER = `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
if (process.argv[2] === 'die-at-start') { process.stderr.write('pyodide failed to load'); process.exit(3); }
if (process.argv[2] === 'never-ready') setInterval(() => {}, 1000);
else send({ type: 'ready' });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const req = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    const { id, code } = req;
    if (code === 'hang') { send({ id, type: 'out', stream: 'stdout', text: 'started\\n' }); continue; }
    if (code === 'crash') { send({ id, type: 'out', stream: 'stderr', text: 'partial' }); process.stderr.write('Pyodide has suffered a fatal error'); process.exit(1); }
    if (code === 'huge') { process.stdout.write('x'.repeat(17 * 1024 * 1024)); continue; }
    if (code === 'forge') {
      // What user code can write: non-objects, and its own run's messages, uncapped.
      process.stdout.write('null\\n42\\n"s"\\n[1]\\n');
      for (let i = 0; i < 5; i++) send({ id, type: 'out', stream: 'stdout', text: 'z'.repeat(80) });
      send({ id, type: 'out', stream: 'stderr', text: '', more: true });
      continue;
    }
    process.stdout.write('not json, written by user code\\n');
    send({ id: 999, type: 'out', stream: 'stdout', text: 'another run' });
    send({ id, type: 'out', stream: 'stdout', text: 'out:' + code + '\\n' });
    send({ id, type: 'out', stream: 'stderr', text: 'warn\\n' });
    send({ id, type: 'done', results: ['42'], resultsTotal: 900, images: ['iVBOR'], imagesDropped: 1, stdoutTotal: 5000, stderrTotal: 0,
      ...(code === 'raise' ? { error: { name: 'ValueError', value: 'bad', traceback: 'tb' } } : {}) });
  }
});
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-proc-'));
const script = path.join(dir, 'fake-worker.cjs');
fs.writeFileSync(script, FAKE_WORKER);
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const cmd = (...args: string[]): WorkerCommand => ({ command: process.execPath, args: [script, ...args], env: {} });
const req = (code: string) => ({ language: 'python' as const, code, envs: {}, maxOutputChars: 100 });

describe('WorkerProcess', () => {
  it('runs a request, collecting streamed output and the final result, ignoring lines that are not its own', async () => {
    const worker = await WorkerProcess.start(cmd(), 5000);
    try {
      const r = await worker.run(req('a'), 5000);
      assert.equal(r.stdout, 'out:a\n');
      assert.equal(r.stderr, 'warn\n');
      assert.equal(r.stdoutTotal, 5000, 'the worker counted more than it sent');
      assert.deepEqual(r.results, ['42']);
      assert.equal(r.resultsTotal, 900);
      assert.deepEqual(r.images, ['iVBOR']);
      assert.equal(r.imagesDropped, 1);
      assert.equal(r.stopped, undefined);
      const err = await worker.run(req('raise'), 5000);
      assert.equal(err.error?.name, 'ValueError');
      assert.ok(worker.alive);
    } finally {
      worker.kill();
    }
  });

  it('kills the process at the timeout and returns what was printed until then', async () => {
    const worker = await WorkerProcess.start(cmd(), 5000);
    const r = await worker.run(req('hang'), 300);
    assert.equal(r.stopped, 'timeout');
    assert.equal(r.stdout, 'started\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(worker.alive, false);
    await assert.rejects(worker.run(req('a'), 1000), /exited/);
  });

  it('reports a crash with the end of the worker’s own stderr', async () => {
    const worker = await WorkerProcess.start(cmd(), 5000);
    const r = await worker.run(req('crash'), 5000);
    assert.equal(r.stopped, 'crashed');
    assert.equal(r.stderr, 'partial');
    assert.match(String(r.crashDetail), /fatal error/);
  });

  it('kills a worker that writes an oversized line', async () => {
    const worker = await WorkerProcess.start(cmd(), 5000);
    const r = await worker.run(req('huge'), 10_000);
    assert.equal(r.stopped, 'crashed');
    assert.match(String(r.crashDetail), /oversized/);
  });

  it('survives lines user code writes, and caps forged output on this side too', async () => {
    const worker = await WorkerProcess.start(cmd(), 5000);
    const r = await worker.run(req('forge'), 500);
    assert.equal(r.stopped, 'timeout');
    assert.equal(r.stdout.length, 100, 'capped at maxOutputChars');
    assert.equal(r.stdoutTotal, 400, 'everything sent was counted');
    assert.equal(r.stderrTotal, 1, 'the worker said there was more than it sent');
  });

  it('reports the reason it was killed for during a run', async () => {
    const worker = await WorkerProcess.start(cmd(), 5000);
    const running = worker.run(req('hang'), 5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    worker.kill('memory');
    assert.equal((await running).stopped, 'memory');
    assert.ok(worker.pid);
  });

  it('refuses a second request while one is running', async () => {
    const worker = await WorkerProcess.start(cmd(), 5000);
    try {
      const first = worker.run(req('hang'), 300);
      await assert.rejects(worker.run(req('a'), 1000), /already running/);
      await first;
    } finally {
      worker.kill();
    }
  });

  it('fails to start with the worker’s stderr when it exits first, and when it never gets ready', async () => {
    await assert.rejects(WorkerProcess.start(cmd('die-at-start'), 5000), /failed to start: pyodide failed to load/);
    await assert.rejects(WorkerProcess.start(cmd('never-ready'), 300), /did not start within 300 ms/);
    await assert.rejects(WorkerProcess.start({ command: path.join(dir, 'no-such-deno'), args: [], env: {} }, 5000), /failed to start/);
  });
});
