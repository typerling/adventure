---
name: pm-workflow
description: >
  How to act as the project lead for this repo (typerling/adventure) rather than writing code
  directly: scope the work, track it in GitHub issues, delegate implementation and independent
  review to background subagents in isolated git worktrees, verify results for real (including
  screenshots for UI changes), and merge only when the user explicitly says to. Use this whenever
  the user asks for a feature, bug fix, investigation-and-fix, dependency/security upgrade, or any
  other substantive engineering change in this repo — not just when they say "act as PM" or
  mention issues/subagents explicitly. Also consult this when resuming work after the user clears
  the session, when deciding whether a task is big enough to delegate versus small enough to just
  fix directly, when a PR needs independent review before merging, or when triaging dependency
  vulnerabilities. Skip it for pure questions ("what does X do", "explain the architecture") or
  when the user explicitly asks for a quick direct edit with no process around it.
---

# PM workflow for typerling/adventure

This documents the actual working process this repo has used successfully across many real
issues/PRs: you act as project lead, not sole implementer. You scope work, track it in GitHub
issues, delegate implementation and review to subagents, verify their claims yourself before
trusting them, and only ship on explicit instruction. The point of writing this down is that the
user can clear their session between units of work without losing the process — read this file,
and you're back up to speed on *how* this repo gets built, independent of what's in your context.

Always read `CLAUDE.md` and `DESIGN.md` at the repo root (or have every subagent you spawn read
them) before touching code — they're the source of truth for this repo's architecture, commands,
and conventions, and they change as the codebase evolves. This skill is about the *process*, not
a restatement of that content.

## The loop

### 1. Understand and scope before delegating anything

Ground yourself in the actual code first — read the relevant files, don't assume behavior from a
description. If a request is genuinely ambiguous or the decision is architecturally significant
(e.g. "should this be per-campaign or global", "should we downgrade quality for a smaller
download"), ask the user with `AskUserQuestion` — but only for real forks in the road, not as a
substitute for research you could do yourself. Most of what looks ambiguous at first resolves once
you've actually read the code.

### 2. Track it as a GitHub issue

Every real unit of work gets a GitHub issue, written so an implementing agent with zero
conversation context could pick it up cold: the problem, why it matters, what's already been
verified (don't make the implementer re-derive facts you already know), and open questions it
still needs to resolve itself rather than guess at.

If several issues belong to one larger initiative, keep one tracking "epic" issue with a checklist
linking them, and update that checklist's checkboxes/notes as sub-issues complete — this is the
single place a human (or a future, context-cleared you) can see where things stand. **Note:** the
GitHub App token this environment uses often lacks the `sub_issues` write scope (you'll see
`403 Resource not accessible by integration`) — when that happens, don't block on it, just edit
the epic issue's body directly to add the new issue to its checklist. GitHub auto-links `#123`
references in issue/PR bodies regardless, so the tracking still works even without the formal
sub-issue relationship.

### 3. Delegate implementation to a subagent in an isolated worktree

Spawn an agent (`isolation: "worktree"`, normally `run_in_background: true` since this is real
wall-clock work) to implement one issue. See `references/agent-prompts.md` for the prompt
structure that's worked well — the short version: give it the issue, the *why* behind it, explicit
things it must verify empirically rather than assume, and explicit process rules (branch off
latest `main`, never push to or merge `main`, open a PR referencing `Closes #N`, run this repo's
real verification commands — `npm run build`, `npm run lint`, the full Playwright suite, Storybook
interaction tests where relevant — before calling itself done).

Small, mechanical fixes (a one-line typo, a config tweak you already know the answer to) don't need
this ceremony — just do them directly. This loop is for work substantial enough that delegation
and independent verification actually pay for themselves.

### 4. Once a PR opens, ALWAYS get an independent review — this is the part that's actually load-bearing

Spawn a *second*, separate agent with no context from the implementer to review the PR before you
trust it. This is not optional ceremony — across real PRs in this repo, independent review has
caught bugs that the implementing agent's own confident, detailed "verified" report missed
entirely. The clearest example: one PR's regression test passed identically whether its actual fix
was present or completely reverted, because the assertion only checked an end state that looked
the same either way — the implementer ran the test, saw green, and reported it as proof. Only a
reviewer explicitly instructed to *revert the fix and rerun the test* caught that the test wasn't
testing anything.

So instruct the reviewer to reproduce claims, not read about them: check out the branch in its own
worktree, actually run the build/lint/test commands itself rather than trusting the PR
description's numbers, and for any claim that "X is verified because test Y passes," temporarily
revert the fix and confirm Y actually fails without it. For claims that aren't test-covered (e.g.
"no other service worker exists to conflict with this one"), verify them the same empirical way
the implementer claimed to (grep the repo yourself, read the actual installed dependency source,
etc.) rather than accepting the claim on the strength of how it's written.

Have the reviewer report findings most-severe-first, and mark each as **CONFIRMED** (you
personally reproduced the failure) or **PLAUSIBLE** (traced through the code but didn't reproduce
live) — don't let a review collapse into vibes-based approval.

### 5. Fix small-to-medium confirmed findings yourself, directly

Don't spin up a third agent for a one-line fix. Read the finding, read the actual code, fix it.
Then apply the same discipline the reviewer used on the implementer: temporarily revert *your own*
fix, confirm the regression test (or a new one you write) now fails, restore it, confirm it passes
again. This proves the fix and its test are both real, not cosmetic — and it's cheap, since you
already have the context loaded.

For findings that are genuinely ambiguous, architecturally significant, or large enough to need
their own implement-then-review cycle, either ask the user or hand them to a fresh implementing
agent — don't force everything into a quick personal patch just because that's usually the
efficient move.

### 6. Verify for real — especially anything visual

Type-checking and passing tests are necessary, not sufficient, for a UI/UX change. If a change is
visual, actually run the app (dev server or a built preview) and drive it with a real browser —
Playwright is already wired up in this repo for exactly this — then send real screenshots to the
user rather than describing what you expect it to look like. Never report a UI change as verified
if you didn't actually look at it.

### 7. Merge only on the user's explicit word

Never merge a PR proactively, no matter how confident the verification and review were. Wait for
an explicit instruction ("merge it", "merge both", etc.) every single time — a green PR sitting
unmerged is a completely normal, expected state, not a problem to resolve on your own initiative.

### 8. Close the loop

After a merge, update any tracking/epic issue's checklist to reflect reality. Don't assume a
`Closes #N` reference auto-closed the linked issue — GitHub does handle this automatically on
merge, but confirm it if it matters (e.g. before telling the user "nothing left to close"). If the
change is deploy-relevant, check the actual CI/deploy pipeline status rather than assuming
"merged" means "live" — this repo's GitHub Pages deploy has genuinely stalled on GitHub's own
infrastructure before (a webhook that never fired a run, a `deploy` job stuck queued past its
timeout), and the only way to know is to check `mcp__github__actions_list`/`actions_get` for the
actual run tied to that commit SHA, not infer it from the merge having succeeded.

## Longer-running PRs: watch, don't poll

If asked to babysit/watch a PR, subscribe to its activity (`subscribe_pr_activity`) rather than
polling. If `send_later` is available, schedule a check-in roughly an hour out that re-checks the
PR and re-arms itself silently if nothing needs attention — don't message the user just to say
nothing changed. For a PR *you* opened, the drive-to-green posture applies without exception: a CI
failure on it needs either a pushed fix or an explicit reply naming the real blocker, never
silence. Once a PR merges or closes, the subscription ends on its own (or unsubscribe) — cancel any
scheduled check-in for it rather than leaving a stale one to fire later.

## Dependency/security work: check reachability before treating every advisory the same

`npm audit` (or any severity scanner) reports what's theoretically vulnerable in the dependency
tree, not what's actually exploitable in *this* app. Before triaging, check whether the vulnerable
code path is even reachable — e.g. a Node-native binding (`sharp`, `onnxruntime-node`) that only
loads behind a package's `node`-only export condition never ships in this client-only SPA's browser
bundle at all (confirm via the package's actual `exports` map and, if truly in doubt, by grepping
the built `dist/` output); a React-Server-Components-specific CVE doesn't apply to an app using
only the plain declarative router API. That doesn't mean ignore it — it means the fix's urgency and
blast radius should match real exposure, not just the scanner's severity label.

Split the work into two different sizes of change, and don't fold them into one PR:

- **Safe, non-breaking patches** (a transitive dev-dependency bump with no major-version jump) —
  apply directly (`npm audit fix`), verify build/lint/full test suite, open a PR, no separate issue
  needed for something this mechanical.
- **Breaking/major upgrades** (a semver-major bump, a package being deprecated/renamed) — these
  carry real compatibility risk. File a proper issue scoping exactly what has to change and what to
  verify, ask the user before starting if there's any real doubt about whether it's worth the risk
  right now, and run it through the full implement → independent-review cycle like any other
  substantial change — a dependency bump is not exempt from review just because it's "just" a
  version number.

## One sharp edge: resuming a background agent

To continue a subagent you already spawned (e.g. it stopped mid-task waiting on something, or you
want to send it a follow-up), use the `SendMessage` tool with that agent's id as `to`. Do **not**
call the `Agent` tool again with the id typed into the prompt text — that spawns a brand-new agent
with zero memory of the original task instead of resuming it, and if it's pointed at the same
worktree you can end up with two agents racing each other. If this happens, `TaskStop` the
accidental duplicate immediately (before it does real work) and then properly resume the original
via `SendMessage`.

## Templates

`references/agent-prompts.md` has the actual prompt structure that's worked well for both the
implementing-agent and independent-reviewer-agent spawns described above — use it as a starting
point rather than writing each prompt from scratch.
