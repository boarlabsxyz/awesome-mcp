import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import { PRIVATE_ADDRESS, pinnedHttpsRequest, publicAddressLookup } from '../util/pinnedHttps.js';

// No real DNS: dns.lookup is replaced per test with a fixed answer.
const originalLookup = dns.lookup;
afterEach(() => { (dns as any).lookup = originalLookup; });

function answer(...addresses: string[]): void {
  (dns as any).lookup = (_host: string, _opts: unknown, cb: (err: Error | null, list: dns.LookupAddress[]) => void) =>
    cb(null, addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 })));
}

function lookup(hostname: string, all: boolean): Promise<{ err: any; address: unknown; family?: number }> {
  return new Promise((resolve) => {
    publicAddressLookup(hostname, { all } as any, (err: any, address: unknown, family?: number) => resolve({ err, address, family }));
  });
}

describe('publicAddressLookup', () => {
  test('passes public addresses through, in either callback shape', async () => {
    answer('52.216.0.1', '2600:1f18::1');
    assert.deepEqual((await lookup('s3.example.com', false)), { err: null, address: '52.216.0.1', family: 4 });
    const all = await lookup('s3.example.com', true);
    assert.equal(all.err, null);
    assert.equal((all.address as dns.LookupAddress[]).length, 2);
  });

  test('fails when ANY address is private, not only the first', async () => {
    answer('52.216.0.1', '169.254.169.254');
    const r = await lookup('rebind.example.com', true);
    assert.equal(r.err?.code, PRIVATE_ADDRESS);
    assert.match(r.err.message, /169\.254\.169\.254/);
  });
});

describe('pinnedHttpsRequest', () => {
  test('never connects when the name resolves to a private address at connect time', async () => {
    let connections = 0;
    const server = net.createServer((s) => { connections += 1; s.destroy(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo;
    answer('127.0.0.1');
    try {
      await assert.rejects(
        pinnedHttpsRequest(new URL(`https://rebind.example.com:${port}/obj`), { method: 'PUT', body: 'x' }),
        (e: any) => e.code === PRIVATE_ADDRESS,
      );
      assert.equal(connections, 0);
    } finally {
      server.close();
    }
  });

  test('refuses a private IP literal and plain http before any lookup', async () => {
    (dns as any).lookup = () => { throw new Error('must not resolve'); };
    await assert.rejects(pinnedHttpsRequest(new URL('https://10.0.0.5/obj'), { method: 'PUT', body: 'x' }), (e: any) => e.code === PRIVATE_ADDRESS);
    await assert.rejects(pinnedHttpsRequest(new URL('http://s3.example.com/obj'), { method: 'PUT', body: 'x' }), /Only https/);
  });
});
