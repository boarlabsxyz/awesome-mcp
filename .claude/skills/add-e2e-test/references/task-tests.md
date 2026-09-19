# When a live-client task test is justified

The bar is high. A task test costs a full LLM conversation plus a browser
session; a tool check costs about a second. Per-tool coverage belongs on the
direct transport, always.

Write a task test only when the thing under test is **how a model uses the
tools**, not what a tool returns.

## The two things only this tier can see

**The argument combinations a model picks.** Tool checks assert the combinations
someone thought to write down. A model picks its own — and `listGoogleDocs` 403'd
on *every* query for months because the failing combination was the **default**
one. `orderBy` defaults to `modifiedTime`, Drive rejects any sort on a query
carrying a `fullText` term, and no hand-written check had tried it. The task
prompt "find my doc about X" found it immediately, without anyone predicting it.

**Failures that do not look like failures.** A direct check gets a 403 and fails
loudly. A model gets the same 403 and says *"I don't have permission to search
your Drive"* — or silently falls back to a different tool and answers correctly.
Both read as success to anything watching the transport, and in production
neither gets reported, because the assistant sounds like it is working.
`mustNotReportFailure` is the only assertion in the suite that sees this.

## Writing one

**Phrase it the way a person would ask.** Name no tool and no parameters.

```
I have a Google Doc somewhere that mentions BANANA-PHONE-7714. Find it and tell me its title.
Which of my Google Docs was changed most recently?
What does this Google Doc say? https://docs.google.com/document/d/<id>/edit
```

A prompt like *"Call the readGoogleDoc MCP tool with documentId … and format
'text'"* makes no decisions, so it can only fail if the whole chain is down. It
tests the client's dispatch, which `runToolCheck` covers far more cheaply.

**Assert the outcome, never the format.** Do not demand `OUTPUT_BEGIN…OUTPUT_END,
nothing else`. That makes the test fail on *format compliance*, which varies run
to run and says nothing about the server — one real run answered correctly and
then declined the wrapper: *"I won't reproduce it wrapped in the exact
OUTPUT_BEGIN/OUTPUT_END format you specified"*.

```ts
assertions: {
  mustNotReportFailure: true,
  includes: [TITLE],
}
```

When the answer cannot be known in advance — the rich account's content changes —
`matchesBody: /\S{3,}/` still asserts something: that a substantive answer came
back rather than an empty one.

**`"I couldn't find"` is not a failure phrase.** It is the correct answer to a
search with no matches. The detector's patterns are qualified by an *access*
verb for exactly this reason: "unable to **find**" passes, "unable to **access**"
fails. Pass extra phrases per test if one only counts as a failure in that
context.

## How many

Three prompts cover Google Docs today: find by content, order by recency, read a
named resource. That is close to sufficient for a service.

A good set covers the *shapes of request* a user makes — search, list, read,
write — not the tools. Adding a fourth prompt that exercises the same shape as an
existing one buys a browser session and no information.

## Before you run one

Task tests need a client account with the MCP connector on it, and a seeded
browser context. A scaffolding pass should **generate and typecheck** them, never
run them. `npm run test:tasks` needs `CLIENT` and either a local Chrome on
`:9222` or `E2E_BROWSER=browserbase`.

When one goes red, read `e2e/runbook.md` before suspecting the tool: of every
failure this tier has produced so far, one was the selectors and the rest were
the harness.
