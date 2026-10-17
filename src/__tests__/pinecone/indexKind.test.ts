import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserError } from 'fastmcp';

import {
  PINECONE_UPSERT_MAX_RECORDS,
  assertRecordsApiUsable,
  assertRecordsCarryTextField,
  assertUpsertBatchSize,
  assertUpsertBodySize,
  buildUpsertNdjson,
  classifyIndex,
  explainRecordsApiFailure,
} from '../../pinecone/indexKind.js';

/** assert.throws returns undefined, so capture the error to inspect its message. */
function failure(fn: () => void): UserError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof UserError, `expected UserError, got ${err}`);
    return err as UserError;
  }
  throw new assert.AssertionError({ message: 'expected a UserError, nothing was thrown' });
}

const legacyIndex = {
  name: 'docs',
  schema: { fields: { chunk_text: { type: 'semantic_text', model: 'multilingual-e5-large' } } },
  embed: { model: 'multilingual-e5-large', field_map: { text: 'chunk_text' } },
};

const documentIndex = {
  name: 'prod-docs',
  schema: { fields: { chunk_text: { type: 'string', embed: { model: 'llama-text-embed-v2' } } } },
};

const vectorsIndex = {
  name: 'embeddings-v2',
  schema: { fields: { _values: { type: 'dense_vector' }, _sparse_values: { type: 'sparse_vector' } } },
};

describe('classifyIndex', () => {
  it('recognises a legacy integrated index and its text field', () => {
    const v = classifyIndex(legacyIndex);
    assert.equal(v.kind, 'legacy-integrated');
    assert.equal(v.textField, 'chunk_text');
    assert.equal(v.embedModel, 'multilingual-e5-large');
    assert.match(v.evidence, /semantic_text/);
  });

  it('recognises a document index', () => {
    const v = classifyIndex(documentIndex);
    assert.equal(v.kind, 'document');
    assert.match(v.evidence, /string with an embed configuration/);
  });

  it('recognises a vectors index from the reserved fields alone', () => {
    const v = classifyIndex(vectorsIndex);
    assert.equal(v.kind, 'vectors');
    assert.match(v.evidence, /_values/);
  });

  it('treats metadata fields beside the reserved vectors as still a vectors index', () => {
    const v = classifyIndex({
      schema: { fields: { _values: { type: 'dense_vector' }, author: { filterable: true } } },
    });
    assert.equal(v.kind, 'vectors');
  });

  it('prefers semantic_text when a payload somehow declares both, and records the ambiguity', () => {
    // The supported kind must never be misclassified as one we refuse.
    const v = classifyIndex({
      schema: {
        fields: {
          chunk_text: { type: 'semantic_text' },
          body: { type: 'string', embed: { model: 'x' } },
        },
      },
    });
    assert.equal(v.kind, 'legacy-integrated');
    assert.match(v.evidence, /ALSO declares/);
  });

  it('reports field_map disagreeing with the semantic_text field name', () => {
    const v = classifyIndex({
      schema: { fields: { old_name: { type: 'semantic_text' } } },
      embed: { field_map: { text: 'real_name' } },
    });
    // field_map wins because it is what the data plane reads, but both names
    // must reach the evidence so the disagreement is reportable.
    assert.equal(v.textField, 'real_name');
    assert.match(v.evidence, /old_name/);
    assert.match(v.evidence, /real_name/);
  });

  it('returns unknown rather than guessing, and never throws', () => {
    assert.equal(classifyIndex(undefined).kind, 'unknown');
    assert.equal(classifyIndex({}).kind, 'unknown');
    assert.equal(classifyIndex({ schema: { fields: {} } }).kind, 'unknown');
    assert.equal(classifyIndex({ schema: { fields: { body: { type: 'widget' } } } }).kind, 'unknown');
  });

  it('names what it saw when it cannot classify', () => {
    const v = classifyIndex({ schema: { fields: { body: { type: 'widget' } } } });
    assert.match(v.evidence, /body:widget/);
  });
});

describe('assertRecordsApiUsable', () => {
  it('lets a legacy integrated index through', () => {
    assert.doesNotThrow(() => assertRecordsApiUsable(classifyIndex(legacyIndex), 'docs', 'search'));
  });

  it('lets UNKNOWN through — absence of evidence is not a refusal', () => {
    // A classifier that fails closed on unfamiliarity breaks the connector on
    // Pinecone's next release.
    assert.doesNotThrow(() => assertRecordsApiUsable(classifyIndex({}), 'mystery', 'upsert'));
  });

  it('refuses a document index, naming the index, the evidence and the right API', () => {
    const err = failure(() => assertRecordsApiUsable(classifyIndex(documentIndex), 'prod-docs', 'search'));
    assert.match(err.message, /prod-docs/);
    assert.match(err.message, /document index/);
    assert.match(err.message, /chunk_text/);
    assert.match(err.message, /Documents API/);
    // No roadmap language: it must not promise a tool that does not exist.
    assert.doesNotMatch(err.message, /not yet|coming soon|will be/i);
  });

  it('refuses a vectors index and says why text search cannot work', () => {
    const err = failure(() => assertRecordsApiUsable(classifyIndex(vectorsIndex), 'embeddings-v2', 'upsert'));
    assert.match(err.message, /vectors index/);
    assert.match(err.message, /no embedding model is attached/);
  });
});

describe('explainRecordsApiFailure', () => {
  it('attaches the evidence to an upstream 400 we chose not to pre-empt', () => {
    const msg = explainRecordsApiFailure(classifyIndex({}), 'mystery', 'search', 'bad request');
    assert.match(msg, /bad request/);
    assert.match(msg, /mystery/);
    assert.match(msg, /attempted the call rather than guessing/);
  });
});

describe('assertUpsertBatchSize', () => {
  it('allows the maximum exactly', () => {
    assert.doesNotThrow(() => assertUpsertBatchSize(PINECONE_UPSERT_MAX_RECORDS));
  });

  it('refuses above the cap, says nothing was sent, and does the arithmetic', () => {
    const err = failure(() => assertUpsertBatchSize(5000));
    assert.match(err.message, /Nothing was sent/);
    assert.match(err.message, /5 calls/);
    // The reasoning must reach the model, or it will just retry.
    assert.match(err.message, /not atomic across the body/);
  });
});

describe('buildUpsertNdjson', () => {
  it('emits one JSON object per line with a trailing newline', () => {
    const { body } = buildUpsertNdjson([{ _id: 'a' }, { _id: 'b' }]);
    assert.equal(body, '{"_id":"a"}\n{"_id":"b"}\n');
  });

  it('cannot be broken by a newline inside a value — JSON.stringify escapes it', () => {
    const { body } = buildUpsertNdjson([{ _id: 'a', text: 'one\ntwo' }, { _id: 'b' }]);
    const lines = body.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).text, 'one\ntwo');
  });

  it('measures bytes in UTF-8, not UTF-16 code units', () => {
    // An embedding corpus is the payload most likely to be multibyte-heavy,
    // so `.length` would under-measure exactly the bodies nearest the limit.
    const { body, bytes } = buildUpsertNdjson([{ _id: 'a', text: '日本語' }]);
    assert.ok(bytes > body.length, `expected ${bytes} > ${body.length}`);
    assert.equal(bytes, Buffer.byteLength(body, 'utf8'));
  });
});

describe('assertUpsertBodySize', () => {
  it('allows a normal body', () => {
    assert.doesNotThrow(() => assertUpsertBodySize(1024, 10));
  });

  it('refuses an over-size body with the measured size and a split', () => {
    const err = failure(() => assertUpsertBodySize(3.1 * 1024 * 1024, 840));
    assert.match(err.message, /3\.1 MB/);
    assert.match(err.message, /2\.0 MB/);
    assert.match(err.message, /Nothing was sent/);
  });
});

describe('assertRecordsCarryTextField', () => {
  it('passes when every record has an id and the text field', () => {
    assert.doesNotThrow(() =>
      assertRecordsCarryTextField([{ _id: 'a', chunk_text: 'x' }], 'chunk_text', 'docs'),
    );
  });

  it('accepts `id` as an alias for `_id`', () => {
    assert.doesNotThrow(() => assertRecordsCarryTextField([{ id: 'a', chunk_text: 'x' }], 'chunk_text', 'docs'));
  });

  it('refuses a record carrying BOTH id spellings, which Pinecone rejects', () => {
    const err = failure(() =>
      assertRecordsCarryTextField([{ _id: 'a', id: 'a', chunk_text: 'x' }], 'chunk_text', 'docs'),
    );
    assert.match(err.message, /both "_id" and "id"/);
  });

  it('refuses a missing id', () => {
    const err = failure(() => assertRecordsCarryTextField([{ chunk_text: 'x' }], 'chunk_text', 'docs'));
    assert.match(err.message, /no id/);
    assert.match(err.message, /Nothing was sent/);
  });

  it('names the expected field, the position and the keys actually present', () => {
    const err = failure(() =>
      assertRecordsCarryTextField([{ _id: 'a', text: 'x' }], 'chunk_text', 'docs'),
    );
    assert.match(err.message, /chunk_text/);
    assert.match(err.message, /position 0/);
    assert.match(err.message, /"text"/);
    // The reason a local check beats the upstream 400.
    assert.match(err.message, /record by record/);
  });

  it('summarises rather than listing all 1000 positions', () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ _id: `r${i}` }));
    const err = failure(() => assertRecordsCarryTextField(records, 'chunk_text', 'docs'));
    assert.match(err.message, /and 45 more/);
  });
});
