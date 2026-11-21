import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The fixture deck's frozen text, plus its ID. Line formats are copied from
// handleGetPresentation in src/google-slides/toolHandlers.ts: slide text renders
// as "  Slide N: <run> | <run>" under "**Text Content:**", and only for slides
// that have any -- so a missing needle means extraction broke, not that the deck
// changed.

const env = serviceEnv('google-slides', ['E2E_FIXTURE_SLIDES_ID', 'E2E_FIXTURE_SLIDES_NEEDLE']);

const TEXT_SECTION = '\n**Text Content:**\n';

test('getPresentation returns the frozen fixture slide text', { timeout: 30_000, skip: env.skip }, async () => {
  const PRESENTATION_ID = env.get('E2E_FIXTURE_SLIDES_ID');
  const NEEDLE = env.get('E2E_FIXTURE_SLIDES_NEEDLE');
  await runToolCheck({
    tool: 'getPresentation',
    service: 'google-slides',
    account: 'fixture',
    shape: 'needle',
    args: { presentationId: PRESENTATION_ID },
    invariants: {
      includes: [`**ID:** ${PRESENTATION_ID}\n`, TEXT_SECTION, NEEDLE],
      matches: [/\*\*Slides:\*\* [1-9]\d*\n/, /\n {2}1\. \S+\n/],
      excludes: ['undefined'],
      // The needle must come from a slide's text, not from the title line: a deck
      // named after its needle would otherwise pass with extraction broken.
      predicate: (body) => {
        const textAt = body.indexOf(TEXT_SECTION);
        return textAt !== -1 && body.indexOf(NEEDLE, textAt) !== -1
          ? undefined
          : 'the needle is not in the "**Text Content:**" section -- slide text extraction returned nothing for it';
      },
    },
  });
});

// A todo, not transportSafe above: Slides text runs carry U+000B for a
// shift-enter soft break, and extractTextRuns (src/google-slides/toolHandlers.ts:20-29)
// only trim()s each run, so one inside a run reaches the wire verbatim. Docs
// fixed the same thing in src/google-docs/textSafety.ts. Seed a soft break into
// the fixture's needle slide and add `transportSafe: true` in the commit that
// routes Slides text through textSafety.
test('getPresentation never puts a raw soft-break character on the wire', {
  todo: 'Slides text is not passed through textSafety.ts',
}, () => {});
