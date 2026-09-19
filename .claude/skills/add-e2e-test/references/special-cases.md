# When the default write pattern does not fit

The default write check is: seed a scratch resource → call the tool → read it
back with a different tool → assert the marker. Read this when that shape is
wrong for the tool you are scaffolding.

For any of these, write the closest available pattern and leave one `// TODO`
naming the case. **Silently weakening an assertion until it always passes is the
failure mode this file exists to prevent** — a green check that asserts nothing
is worse than no check, because it is counted as coverage.

## Tools that operate on a range

`deleteRange`, `applyTextStyle`, `formatMatchingText`.

The marker must land *inside* the range the tool targets, or the assertion is
meaningless. Either seed the content with the marker already at the offset the
tool will touch and assert on the effect (marker present after styling, absent
after deletion), or pick a unique anchor in the seeded content and target
relative to it.

## Tools whose effect is invisible in the document text

`addComment`, `applyParagraphStyle`, `resolveComment`.

A `readGoogleDoc` read-back shows neither comments nor paragraph-level styling,
so the marker round-trip is the wrong verification. Use the matching read tool:

- comment tools → read back with `listComments`
- structural style tools → read back with `inspectDocStructure`, asserting on the
  field the tool actually affects

`runToolCheck`'s `readback` takes any tool on any service, so this is a one-line
change, not a different pattern.

## Tools that return a result rather than mutating

`findElement`, `findAndReplace` in count mode.

Treat as read-flavoured even when `annotations` says otherwise: assert on the
tool's own response, skip the scratch resource, use a fixture document. These can
take all three shapes.

## Tools spanning multiple resources

`importDocx`, `copyFile`, `moveFile`.

Setup needs more than one scratch resource. `setup/docsScratch.ts` exposes
`createScratchDoc` and `trashFile` only. **Extend the factory first**, then
scaffold — ad-hoc setup inlined in a test file is where flake comes from, and a
second copy of the create/trash logic will drift from the sweeper that cleans up
after it.

Whatever you add must produce a **run-scoped, self-dating** name
(`scratchTitle()` → `e2e-<epochMs>-<run>-<tool>`). `sweepScratch` dates a
resource from its title; anything named otherwise is either never swept or, worse,
matched by a broader pattern later and deleted when it should not be.

## Tools needing indices or ids from a specific document

Anything taking `startIndex`, `endIndex`, `tabId`.

These only mean something for one document's structure and cannot be derived.
Generate with `<TODO: startIndex>` and list the tool plus the missing fields in
the report. The scaffold still locks in setup, teardown and shape.

Better where possible: have setup seed known content and **derive** the indices
from it in the test, rather than hard-coding numbers that break the first time
the fixture changes.

## Destructive tools

`deleteRange`, `deleteComment`, `deleteFile`, and anything with
`destructiveHint: true`.

These need the opposite of an empty account: **something to delete**. Seed it,
delete it, then assert it is gone — asserting absence is the whole point, so
`excludes` carries the check rather than `includes`.

Never point one at a fixture or rich resource. `writes: true` prevents resolving
those credentials, but a delete that takes an id from an env var can still be
handed the wrong id by a misconfigured run; prefer ids that came from `setup`.

Some destructive operations are not safely repeatable in CI at all — CLAUDE.md
flags `disqualifyVacancyApplication` as non-idempotent. Scaffold those, mark them
`todo` with the reason, and leave them out of the scheduled run.
