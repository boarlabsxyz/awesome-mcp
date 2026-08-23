---
name: triage-e2e-failure
description: Diagnose a failing or recently-failed e2e smoke test in this repo by walking through the forensics bundle (summary.json + prompt.txt + response.txt + snapshot.txt + screenshot.png) following the procedure in e2e/runbook.md. Accepts a GitHub Actions run URL, a local artifact zip, or an unpacked bundle directory. Identifies whether the failure is from app version drift, selector drift, an auth challenge, a Cloudflare interstitial, an assertion mismatch, or something else, and points at the likely fix. Use this skill whenever the user mentions an e2e test failure, smoke test failure, GHA failure for the claude-desktop or chatgpt-web jobs, a red CI run, a failing forensics bundle, or asks to investigate a failed run. Also use when invoked as `/triage-e2e-failure <run-url-or-path>`.
metadata:
  argument-hint: <gha-run-url | artifact-zip | bundle-dir>
---

# Triage E2E Failure

Walks through a forensics bundle to identify why a live-client e2e test failed. The bundle layout and the triage steps come from `e2e/runbook.md` ("Failure triage") and `e2e/forensics.ts`.

The runbook explicitly says: "find the forensics bundle, open summary.json, compare snapshot.txt against a known-good snapshot, cross-check screenshot.png for unexpected modals, then look at the driver." This skill is the codification of that procedure — same steps, just consistent and faster.

## Inputs

The argument can be any of:

- **GHA run URL** — e.g. `https://github.com/<owner>/<repo>/actions/runs/<runId>`. The skill resolves it via `gh run download --dir <tmp> <runId>` and finds the bundle inside.
- **Local artifact zip** — a `.zip` previously downloaded from the GHA run page.
- **Local bundle directory** — already unpacked.

If no argument, ask. Don't guess.

## Procedure

### 1. Acquire the bundle

The forensics layout (per `e2e/forensics.ts`) is:
```
.artifacts/<sha>/<client>/<testName>/
  summary.json
  prompt.txt
  response.txt          (may be missing if the driver never got a response)
  snapshot.txt          (accessibility tree — may be missing if the driver couldn't capture it)
  screenshot.png        (may be missing under the same conditions)
```

How to materialize that locally:

- **GHA run URL**: parse the run id from the URL, then
  ```
  TMP=$(mktemp -d)
  gh run download <runId> --dir "$TMP"
  ```
  The downloaded artifact root usually contains one subdirectory per test (testName). If multiple tests failed, the skill picks the first failing one and notes that the others exist — don't try to triage everything in one pass.
- **Zip file**: `unzip -d "$TMP" <path>`.
- **Bundle directory**: read in place.

If the bundle is missing `summary.json`, stop — without it there is no triage; ask the user to confirm the path or re-download.

### 2. Read `summary.json`

This file holds the ground truth for what happened. Read it first and base everything else on it.

Fields and what to do with each:

- `passed: false` — proceed; if `true`, tell the user the test didn't actually fail (or finished after a retry) and stop.
- `error` — the JS error stack. Categorize:
  - `"Response missing start delimiter \"OUTPUT_BEGIN\""` / `"... end delimiter"` → the LLM didn't follow the OUTPUT envelope. Common causes: model rewrote the response, hit a content filter, or the response was truncated by the client. Move to step 4 (response.txt).
  - `"Response missing expected substring"` → the LLM responded in the envelope but the assertion content (fixture needle, marker round-trip) didn't appear. Either the tool didn't do what the test expected, or the readback didn't see the change. Move to step 4.
  - Driver-side errors (`element not found`, `selector ... did not match`, `session not created`) → likely selector drift in the driver or an app-version mismatch. Move to step 3.
  - `"Missing required env var"` → the runner is misconfigured. Point at `e2e/fixtures/{read,write}.md`.
  - Timeout messages → the LLM took longer than the test's timeout, or the driver stalled. Check screenshot.
- `appVersion` — compare against the pinned version in `e2e/runbook.md` ("Claude Desktop version pin" / equivalent for ChatGPT). If they differ, that's likely the cause — Sparkle let an auto-update through. Surface this prominently.
- `client` — `claude-desktop` vs `chatgpt-web` changes the driver expectation and which UI shifts to suspect.
- `durationMs` — close to the test's timeout (180_000 for read, 240_000 for write) suggests a stall; well under suggests a fast failure (selector miss, env miss).

### 3. Check for selector drift

If the error suggests the driver couldn't find an element, read `snapshot.txt`. This is the accessibility tree the driver captured at failure time. Look for:

- The expected element with a slightly different label, role, or path.
- A wrapping element that wasn't there before (the locator was looking for a direct child but now there's a div in between).
- Markers like `SELECTOR-TODO` in `e2e/drivers/<client>.ts` — these are the locators that are known to drift.

When you find the new shape, the fix is to update the matching locator in `e2e/drivers/claude-desktop.ts` or `e2e/drivers/chatgpt-web.ts`. Cite the file + line where the SELECTOR-TODO comment lives. Don't silently propose a fix — show the user the old locator, the new one from `snapshot.txt`, and let them confirm.

### 4. Check the response and the prompt

For assertion failures, read `response.txt` and `prompt.txt` side by side. Common patterns:

- The model wrapped the answer in markdown despite the prompt saying not to → assertion fails because the envelope is buried. Often a model-version regression; flag the appVersion.
- The model called the wrong tool (the prompt says `awesome-mcp-readonly` but the model used `awesome-mcp-full`, or vice versa). Surface this — it means the prompt's preface line isn't dispatching correctly, or the connector isn't installed on the runner.
- The marker round-trip didn't show up because the write tool's setup created a doc in the wrong account, or the read tool ran before the write committed. Cross-check with the test file in `e2e/tests/write/<tool>.smoke.ts` — usually a setup bug, not the tool itself.

If `response.txt` is missing, the driver never got a response (probably a stall or auth interstitial — go to step 5).

### 5. Check the screenshot

`screenshot.png` is the final visual state of the runner. The model can read it directly via the Read tool. Look for:

- **An auth modal** (Anthropic / OpenAI / Google sign-in challenge) — session expired on the runner. Fix is in the runbook's "Account rotation" table.
- **A Cloudflare interstitial** ("Verify you are human", checkbox) — ChatGPT's anti-bot fired. The runbook notes this is why we don't re-create the Chrome profile.
- **A permission prompt** ("Allow this site to use ...") — happens after a Chrome update.
- **A paywall or upsell** — plan tier expired.
- **A connector-picker modal** — Claude Desktop's connector UI changed shape; selector drift.
- **The expected UI** but no response visible — driver finished but never read the response. Often a timing race in the driver.

Mention what you see specifically. "Cloudflare verify-human modal visible at the center of the screen, confirming the Cloudflare hypothesis" beats "auth issue".

### 6. Cross-check the app version

If `appVersion` from summary.json doesn't match the pinned version in the runbook, that's almost certainly load-bearing. Auto-update slipped through, the new client has shifted selectors or response timing. Recommend pinning to the old version (`e2e/runbook.md` "Claude Desktop version pin" describes how) and re-running before doing any other fix — don't update selectors against a moving target.

### 7. Report

Tight, actionable summary. The user wants to know the cause and the next move, not a re-read of the bundle.

```
Test: <testName> on <client>
Result: failed at <iso timestamp>, duration <s>s
App version: <found> (pinned: <expected> <- if mismatch, FLAG>)

Cause (most likely):
  <one-sentence diagnosis>

Evidence:
  - summary.json: <relevant field/value>
  - <snapshot.txt | screenshot.png | response.txt>: <what you saw>

Suggested fix:
  <one or two concrete next steps, with file:line where applicable>

Other notes:
  <anything else worth flagging, e.g. other failing tests in the same bundle>
```

## When you can't tell

If the bundle doesn't conclusively point at one cause — say so. The runbook prefers a careful "I see X and Y, both plausible" over a confident wrong guess. Re-running with a small fix is cheap; chasing the wrong root cause for an hour is not.

## File layout

```
triage-e2e-failure/
└── SKILL.md       ← procedural skill; no templates, no references needed
```

The skill is intentionally light on bundled assets — the source of truth for what each bundle field means is `e2e/forensics.ts` and `e2e/runbook.md` in the repo itself. Read those when in doubt rather than duplicating their content here.
