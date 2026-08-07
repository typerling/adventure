# Agent prompt templates

These are structures, not scripts — fill in the specifics for the actual issue/PR, but keep the
sections, because each one is doing real work (see the "why" after each).

## Implementing-agent prompt

```
Repo: <owner/repo> (one-line reminder of what this app is and its hard architectural constraints
— e.g. "client-only SPA, no server"). Read CLAUDE.md and DESIGN.md at the repo root in full before
starting. GitHub issue to implement: <url> — read the issue itself via the GitHub MCP tools for
the full spec; this prompt summarizes but the issue body is authoritative.

Fetch origin/main first and branch off its current tip — <name what it should already include,
e.g. "which now includes PR #52's cross-origin isolation work">, so you're not building on stale
state.

## Background
<Why this matters, in enough detail that the agent could explain it back to someone else. Include
concrete evidence already gathered — measured numbers, confirmed root causes, file sizes checked
against a real registry — so the agent doesn't have to re-derive facts you already have.>

## What to build
<The actual change, described precisely enough to implement, but leaving real design decisions to
the agent where the issue itself left them open — don't over-specify to the point the agent is
just typing what you already wrote.>

## Things you must actually verify, not assume
<Numbered list of specific claims/behaviors that are easy to get wrong or fake-verify. Each one
should be phrased as an instruction to *check*, e.g. "confirm X by reading the actual installed
package source, not by trusting its README" — this is what turns a plausible-sounding PR
description into one backed by real verification.>

## Process (this repo's established convention)
- Branch off latest origin/main (verify you're not stale).
- Do NOT merge or push to main. Push your branch and open a PR referencing "Closes #N" in the
  body, explaining what changed and your verification results for each item above (or an honest
  note where something wasn't obtainable in this environment — don't fabricate numbers).
- Follow the repo's PR template if one exists.
- Run this repo's real verification commands before calling it done: <the actual commands, e.g.
  npm run build / npm run lint / npx playwright test (full suite, not a subset) / npm run
  test:stories>.
- Update CLAUDE.md/DESIGN.md if they now describe something inaccurately.

Report back with: what you changed, your verification results for each numbered item above, and
the PR URL.
```

**Why the "things you must actually verify" section matters:** an agent given a vague "make sure
it works" will often report success based on a plausible-sounding but shallow check. Naming the
exact things that are easy to fake-verify — "the download really is cached," "the fallback really
does restart cleanly," "this really is the only service worker" — and demanding the check be
empirical (read the actual dependency source, actually revert-and-rerun, actually measure) is what
produces PR descriptions worth trusting in the first place.

## Independent-reviewer-agent prompt

```
Repo: <owner/repo>. Independently review PR #<N> (<url>), which implements issue #<M> (<url>).
Read the issue and full PR description via GitHub MCP tools first — do not rely on a summary
alone. Read CLAUDE.md and DESIGN.md at the repo root for project conventions.

You were not involved in writing this PR — approach it fresh and skeptically. <If a prior PR in
this same effort had a review catch something real, say so explicitly — it sets the right bar:>
"On the immediately preceding PR in this same tracking issue, independent review found a fix that
didn't actually close the bug it claimed to, and found that PR's own regression test passed
identically whether the fix was present or reverted. Treat every claim below as something to
reproduce yourself, not take on faith."

## What the PR claims — verify each against the actual diff, and by reproducing, not by reading
<Numbered list, one per significant claim in the PR description. For each: what to check, and
critically, HOW to check it empirically — e.g. "temporarily strip this fallback code, run the
relevant test, confirm it now fails; restore the code, confirm it passes again" rather than "check
the fallback works." For test-suite/build/lint claims: "re-run this yourself in your own worktree,
don't trust the PR's stated numbers.">

## Also do a general independent pass
Look for anything else wrong: edge cases, race conditions, whether the PR scope-crept beyond the
issue, whether documentation updates are accurate rather than aspirational.

## Output
Use the ReportFindings tool with verified findings only (most severe first). Actually reproduce
each finding before reporting it as CONFIRMED (e.g. by reverting the specific fix and confirming
the failure mode occurs); mark anything you couldn't fully verify as PLAUSIBLE instead of
CONFIRMED. Do not report style nitpicks or things already explicitly disclosed as known
limitations in the PR description, unless the disclosure itself is misleading.
```

**Why "approach it fresh and skeptically" plus a concrete prior example:** a review agent primed
only with "review this PR" tends to read the code, nod along with the description, and approve.
Naming a real precedent where review caught something — and demanding reproduction, not
reading-comprehension — is what gets a reviewer agent to actually revert code and rerun tests
instead of summarizing what the PR says it did.

## After review: applying fixes yourself

When you take confirmed findings back into the implementer's worktree to fix them personally
(see the main skill file's step 5), use the same revert-and-confirm discipline on your own patch:

1. Make the fix.
2. Temporarily revert just that fix (comment it out, restore the old code inline via a quick
   patch — whatever's fastest) and re-run the specific test that should catch the regression.
   Confirm it fails.
3. Restore your fix and re-run the same test. Confirm it passes.
4. Only then commit.

This is cheap — you already have full context loaded — and it's the same proof-of-load-bearing-ness
the independent reviewer demanded of the original implementer. Skipping it for your own fixes,
just because you're confident, is exactly the failure mode that let the original bug through in
the first place.
