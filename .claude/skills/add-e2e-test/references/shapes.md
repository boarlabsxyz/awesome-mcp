# Choosing a shape, and what to assert in it

A shape describes **the data**, not the account. The account follows from it:
`needle` → fixture, `volume` → rich, `zero` → sandbox.

Full invariant list: `e2e/assertions.ts`. This is how to choose.

## needle — frozen content, exact substring

The account's content never changes, so an exact assertion is deterministic.

```ts
invariants: { includes: [NEEDLE], transportSafe: true }
```

Assert an **ID** alongside a title wherever one is available. A title match alone
is also satisfied by a second document someone named the same thing.

`transportSafe` on every text-returning read: it catches lone surrogates from a
`substring` truncation, the `U+000B` Docs emits for shift-enter, and the
private-use characters it uses as inline-object placeholders. All three have been
real bugs in this repo.

## volume — enough data that limits become observable

This is where paging caps, truncation and silent limits show up. On a
few-record fixture account every one of these passes vacuously.

Three things worth asserting:

**The response is actually large.** `minLength`, or `minLines` for list output.

**Truncation produced a valid result.** `format: 'json'` with `maxLength` must
still parse — it once returned a fragment of serialised JSON, and callers got
`EOF while parsing a string`, which reads exactly like a transport bug.

**Truncation did not cut a character.** `noLoneSurrogates`, or `transportSafe`
which implies it. Use an **odd** `maxLength` (4097, not 4096): an even cut can
land between code units by luck and the check would prove nothing.

### Guard against passing vacuously

The most important rule in this file. A volume check on too-small a fixture is
green and meaningless. Assert the **precondition**, and fail with a message
naming the fixture to fix:

```ts
predicate: (body) => {
  const header = body.match(/^Content \(truncated to (\d+) chars of (\d+) total\)/);
  if (!header) {
    return 'the response is not the truncated form. Point E2E_RICH_DOC_ID at a ' +
      'document longer than 4097 characters.';
  }
  return undefined;
}
```

Read the tool's **own header** rather than measuring the response. A reply that
wraps content in `Content (truncated to N chars of M total):` plus a trailing
note has a length that is not the content length, so a length comparison answers
the wrong question.

## zero — the empty-state answer

The half of the contract nobody tests, and the one that finds things. A bare "no
results" reads to a caller — and to a model — as *that thing does not exist*.

Two flavours:

**A query that matches nothing.** Assert the no-results string **verbatim** from
the handler, and assert it does not read as an error:

```ts
args: { query: 'zzz-no-such-document-zzz-9f3a1c7b', maxResults: 10 },
invariants: {
  includes: ['No Google Docs found matching your criteria.'],
  excludes: ['Error', 'Permission denied', 'Found '],
}
```

Make the query **impossible**, not merely unlikely, so it does not start failing
the day someone creates a plausibly-named document.

**An empty resource.** Create a scratch doc with no content and read it. Nothing
specifies what this should say, which is exactly why it is worth pinning: an
empty body returned as `undefined`, as a stack trace, or as a paragraph of
apology all look identical to a caller deciding whether the read failed.

```ts
invariants: {
  transportSafe: true,
  excludes: ['undefined', 'Traceback', 'at Object.<anonymous>'],
  predicate: (body) =>
    body.length > 400 ? `expected a short empty-state answer, got ${body.length} chars` : undefined,
}
```

If a zero check goes red on its first run, **read `response.txt` before touching
the assertion**. A surprising empty-state answer is a finding.

## Write tools: volume and zero only

A write has no frozen output to match, so there is no needle shape for it. Its
equivalent is the marker it writes, asserted by the sandbox check.

Both shapes are seeded in the **sandbox**. Volume is a property of the fixture,
not a licence to write somewhere read-only — and `accounts.ts` enforces that:
`writes: true` cannot resolve fixture or rich credentials.

- **volume** — seed a large document (`bulkText(200, 'SEED')`), then assert the
  write landed correctly *and* did not damage what was there. For an append,
  assert position: the marker must appear after the last seeded paragraph.
- **zero** — write into an empty resource. The interesting parameters are the
  ones that ask a question of content that is not there: `addNewlineIfNeeded`
  asks "does the doc end with a newline" of a body with nothing in it.
