# Special-case test patterns

Read this only when the default write template (write → readback → assert marker round-trip) does not fit the tool you are scaffolding. The default pattern works for tools that visibly mutate doc content; this doc covers the cases where it doesn't.

For any of these cases, write the test with the closest available pattern and leave a single `// TODO` comment naming the case. Silently weakening the assertion to "always passes" is the failure mode this doc exists to prevent.

## Tools that operate on a range

Examples: `deleteRange`, `applyTextStyle`, `formatMatchingText`.

The marker the test injects must land *inside* the range the tool targets, otherwise the assertion is meaningless. Two options:

- Have setup write the initial content with the marker already embedded at the offset the tool will touch, then assert on the *effect* (marker present for styling, marker absent for deletion).
- Use `findAndReplace`-style targeting: pick a unique anchor in the initial content and have the prompt ask the tool to operate relative to that anchor.

## Tools that don't surface in doc text

Examples: `addComment`, `applyParagraphStyle`, `resolveComment`.

A `readGoogleDoc` readback won't show comments or paragraph-level styling, so the marker round-trip pattern is wrong. Use the corresponding read tool for verification:

- Comment tools → readback via `listComments`, assert the marker appears in the listed comment text.
- Structural style tools → readback via `inspectDocStructure`, assert on the field the tool actually affects.

## Tools that return a result rather than mutating

Examples: `findElement`, `findAndReplace` (when used in dry-run / count mode).

Treat as read-flavored even if registered in `WRITE_TOOLS` — assert on the tool's own response, not on a readback. Skip the scratch resource entirely; use a fixture doc instead, the same way `readGoogleDoc.smoke.ts` does.

## Tools that operate across multiple resources

Examples: `importDocx`, `copyFile`, `moveFile`.

Setup needs more than one scratch resource. The current `scratchFactory.ts` only exposes `createScratchDoc` and `createScratchSheet`; if the test needs a folder or a binary file, extend the factory first, then come back to scaffold the test. Don't inline ad-hoc setup logic in the test file — that's where flake comes from.

## Tools that depend on prior state in the doc

Examples: tools that take `startIndex` / `endIndex` / `tabId` — the indices only mean anything for a specific doc structure.

The skill cannot derive these. Generate the test with `<TODO: startIndex>` placeholders, and list the tool + the missing fields in the final report. The scaffold is still useful because it locks in setup, teardown, and the prompt shape; the user just fills in the indices.
