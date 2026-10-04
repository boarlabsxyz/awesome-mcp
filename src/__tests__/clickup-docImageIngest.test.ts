import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertOneImageSource,
  decodeBase64Image,
  isImageUrlOnOurHost,
} from '../clickup/docImageIngest.js';

// These three were private to clickup/server.ts until the image ingest path was
// hoisted so the REST plane could share it. They are guards, not plumbing: the
// base64 validation stops garbage reaching the image decoder, and the host check
// is what decides whether a caller-supplied URL is fetched by this server at all.

describe('ClickUp doc image ingest', () => {
  describe('assertOneImageSource', () => {
    it('accepts exactly one source', () => {
      assert.doesNotThrow(() => assertOneImageSource({ imageUrl: 'https://e.test/a.png' }));
      assert.doesNotThrow(() => assertOneImageSource({ imageBase64: 'AAAA' }));
    });

    it('rejects both, and rejects neither', () => {
      assert.throws(
        () => assertOneImageSource({ imageUrl: 'https://e.test/a.png', imageBase64: 'AAAA' }),
        /only one/i,
      );
      assert.throws(() => assertOneImageSource({}), /exactly one/i);
    });

    it('treats an empty string as absent rather than as a source', () => {
      assert.throws(() => assertOneImageSource({ imageUrl: '', imageBase64: '' }), /exactly one/i);
    });
  });

  describe('decodeBase64Image', () => {
    it('decodes plain base64', () => {
      const bytes = decodeBase64Image(Buffer.from('hello world').toString('base64'));
      assert.equal(bytes.toString(), 'hello world');
    });

    it('strips a data-URL prefix and embedded whitespace', () => {
      const b64 = Buffer.from('hello world').toString('base64');
      const chunked = `data:image/png;base64,${b64.slice(0, 4)}\n  ${b64.slice(4)}`;
      assert.equal(decodeBase64Image(chunked).toString(), 'hello world');
    });

    it('rejects non-base64 input instead of decoding garbage', () => {
      // Buffer.from silently DROPS invalid characters, so without this check the
      // image decoder downstream receives nonsense bytes rather than an error.
      assert.throws(() => decodeBase64Image('not valid base64!!'), /not valid base64/i);
    });

    it('rejects a length that cannot be base64', () => {
      assert.throws(() => decodeBase64Image('AAA=A'), /not valid base64/i);
    });

    it('rejects an empty payload', () => {
      assert.throws(() => decodeBase64Image(''), /empty/i);
      assert.throws(() => decodeBase64Image('data:image/png;base64,'), /empty/i);
    });

    it('rejects an oversize string before spending a decode', () => {
      // 'A' is valid base64 and the cap is on the STRING, so this never decodes.
      const huge = 'A'.repeat(2 * 1024 * 1024 + 4);
      assert.throws(() => decodeBase64Image(huge), /too large/i);
    });

    it('rejects decoded bytes past the decoded cap', () => {
      // Under the string cap but over the ~1.5 MB decoded cap.
      const bytes = Buffer.alloc(1.6 * 1024 * 1024, 0x41);
      assert.throws(() => decodeBase64Image(bytes.toString('base64')), /too large/i);
    });

    it('names the file but never echoes the payload in an error', () => {
      try {
        decodeBase64Image('not valid base64!!', 'shot.png');
        assert.fail('expected a throw');
      } catch (err: any) {
        assert.match(err.message, /shot\.png/);
        // The payload can be ~2MB; putting any slice of it in an error would
        // blow up the caller's context and flood the logs.
        assert.ok(!err.message.includes('not valid base64!!'), 'must not echo the payload');
      }
    });
  });

  describe('isImageUrlOnOurHost', () => {
    const base = 'https://img.example.com';

    it('accepts an /images/ path on the same origin', () => {
      assert.equal(isImageUrlOnOurHost(`${base}/images/abc.webp`, base), true);
    });

    it('rejects a different origin that merely shares the base as a string prefix', () => {
      // The bug a naive startsWith(base) check would have: this is a DIFFERENT
      // host that an attacker controls, and treating it as ours would skip
      // re-hosting and embed their URL in the doc.
      assert.equal(isImageUrlOnOurHost('https://img.example.com.evil.test/images/a.webp', base), false);
    });

    it('rejects the right origin on a path we do not serve', () => {
      assert.equal(isImageUrlOnOurHost(`${base}/not-images/a.webp`, base), false);
    });

    it('rejects a scheme change on the same host', () => {
      assert.equal(isImageUrlOnOurHost('http://img.example.com/images/a.webp', base), false);
    });

    it('rejects a non-http(s) scheme', () => {
      assert.equal(isImageUrlOnOurHost('file:///etc/passwd', base), false);
      assert.equal(isImageUrlOnOurHost('data:image/png;base64,AAAA', base), false);
    });

    it('returns false rather than throwing on unparseable input', () => {
      assert.equal(isImageUrlOnOurHost('not a url', base), false);
      assert.equal(isImageUrlOnOurHost(`${base}/images/a.webp`, 'not a url'), false);
    });
  });
});
