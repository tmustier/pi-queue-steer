# Compaction and reload validation

This document records the deterministic validation matrix for compaction-aware command rows. The implementation remains extension-only and uses public Pi extension APIs.

## Automated suite

The Pi package ranges are intentionally unpinned. The lockfile records the versions used for a reproducible checkout, but the package manifest does not declare an artificial Pi compatibility target.

Run the resolved dependency set:

```bash
npm ci --ignore-scripts
npm run ci
```

Refresh to the current Pi packages before compatibility review:

```bash
npm update --ignore-scripts \
  @earendil-works/pi-ai \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui
npm run ci
```

The suite covers queue/edit invariants, command classification, images, one-at-a-time and all-mode delivery, synchronous partial handoff restoration, non-TUI pass-through, prompt and Skill expansion, manual compaction success/failure, automatic overflow compaction, retry ordering, settled-handler launch ordering, repeated reload restoration, and compaction/native-input ordering.

Release 0.2.2: 86 tests passed on both Pi 0.87.0 (the lockfile) and Pi 1.0.0 (the current installed release).

Release 0.2.1: 84 tests passed on both Pi 0.87.0 and Pi 0.99.2.

## Embedded working status

Validated on 1 October 2026 at `3cbd2b57ac4d78efbeb60c6b579c9a8efc7a95c9` for release 0.2.2.

A scratch Pi 1.0.0 TUI used `openai/gpt-6-astra` at low thinking with only this extension loaded. The prompt asked the model to run `sleep 20 && echo done` with bash. While the tool ran, the TUI queued a follow-up. Terminal captures showed:

- `── ⠸ Working ───` in the editor's top border below the queue, where 0.2.1 showed `⠸ Working` above the queue
- the same border line below the queue while the queued row was edited inline, with no stray border when editing a paused queue at idle
- the follow-up delivered once after the run

## Automatic-compaction steering regression

Validated on 1 October 2026 at `afd4db006d72792d5605a1d026e809f3018ff975` for release 0.2.1.

The 3 regressions use real `AgentSession` scheduling and bash tools to exercise threshold compaction success, failure and cancellation. They queue steering while the resumed assistant response waits, then check delivery before `agent_end`, in the original run, exactly once. All 3 fail against the original `91e3a5f` implementation.

The release review replaced fabricated completion events with these integration tests. It also removed an impossible synchronous compaction-start failure test. The full suite has 84 passing tests on Pi 0.87.0 and 0.99.2. The full TUI harness passed on both versions at the tested revision with a clean working tree.

### Live-model proof

A scratch Pi 0.99.2 TUI used `openai/gpt-6.1-sol` at medium thinking, the release extension and a `queue_probe` tool. Normal Pi summarization compacted between tool turns. Scratch settings were `reserveTokens: 266000` and `keepRecentTokens: 200` (agent defaults for this test, not user rules). Production settings were unchanged.

Prompt:

```text
This is an isolated queue-steer regression test. Use queue_probe only. Call inflate first, then call hold in a separate later assistant turn, then call record with token ORIGINAL in a later turn, then finish. Never batch phases in one assistant turn. The filler is disposable and can be summarized very briefly. If a later steering message changes the token, record its token instead. Do not skip phases or ask questions.
```

The model called `inflate`, Pi compacted, and the model called `hold`. While that tool waited, the TUI queued:

```text
Steering update: when the hold tool returns, call queue_probe record with token STEERED instead of ORIGINAL, then finish.
```

After release, the model called `record` with `token: "STEERED"` before its final response. Independent file, transcript and event-log checks confirmed one steering user message, one agent run and recording before `agent_end`. Terminal captures showed the waiting queue and the successful tool result.

Live-model coverage is successful threshold compaction and mid-run steering. Failure and cancellation use real-session deterministic tests. Native-input ordering uses the real TUI harness. Later asynchronous send rejection remains outside Pi's public acknowledgement contract.

## Real TUI evidence

`test/tui-evidence.sh` starts the real resolved Pi TUI under tmux with a deterministic faux provider. It uses actual terminal key sequences, public compaction lifecycle events, public provider registration, actual runtime reloads, and Pi's real native compaction queue.

Run:

```bash
./test/tui-evidence.sh /tmp/pi-queue-tui-evidence
```

The output directory contains plain terminal captures, provider-call logs, lifecycle-event logs, and runtime-initialization logs. Run it immediately before review so `summary.txt` records the exact Pi version, commit and working-tree state under test. A release evidence run should report `working tree: clean`.

The full harness passed against Pi 0.87.0 and 1.0.0 for release 0.2.2, and against Pi 0.87.0 and 0.99.2 for release 0.2.1. The historical 0.2.0 release-evidence run reported:

```text
pi: 0.84.1
commit: 37fcd1433b8960f13c030d9ba1a5e8cc36535e05
working tree: clean
manual events: {"event":"session_before_compact","reason":"manual"} {"event":"session_before_compact","reason":"manual"}
overflow events: {"event":"session_before_compact","reason":"overflow"} {"event":"session_before_compact","reason":"threshold"}
runtime initializations across two queued reloads: 3
captures: abort-paused, manual-reload-resources, native-before-command, automatic-overflow, all-mode
```

The three runtime initializations are the initial load plus two queued `/reload` rows. The final queued message ran after both reloads.

The semantic capture excerpts were:

```text
[compaction]
Compacted from 798 tokens
FAUX RESPONSE: after manual compaction

Error: Compaction failed: Summarization failed: synthetic TUI summary failure
FAUX RESPONSE: after failed compaction

Operation aborted
follow-ups (1) · paused
enter resume · option+up edit · escape keep paused
FAUX RESPONSE: after abort resume

Reloaded keybindings, extensions, skills, prompts, themes, and context files
FAUX RESPONSE: after repeated reload

PROMPT EXPANDED: first=alpha all=alpha beta default=fallback
[skill] bro
FAUX RESPONSE: <skill name="bro" ...>
```

The native post-compaction ordering capture showed the ordinary message submitted during manual `/compact` entering Pi's native queue, finishing before the extension-owned command row, and `/reload` never reaching the model:

```text
[compaction]
Compacted from 785 tokens
ordinary native during compaction
FAUX RESPONSE: ordinary native during compaction
Reloaded keybindings, extensions, skills, prompts, themes, and context files
```

The overflow event log recorded `reason: "overflow"`, the TUI rendered a compaction entry, and `overflow-provider-calls.jsonl` proved the queued follow-up completed exactly once. `all-mode-provider-calls.jsonl` proved all three rows reached Pi exactly once in FIFO order; the all-mode capture rendered them together before the final response.

## Normal-Pi adversarial evidence

PR [#9](https://github.com/tmustier/pi-queue-steer/pull/9) was also exercised at commit `37fcd1433b8960f13c030d9ba1a5e8cc36535e05` through normal `pi` execution under tmux, using the installed extension and Pi 0.84.1 rather than extension-selection or test-fixture flags. The three captures cover automatic compaction above 200k tokens followed by queued `/reload`, manual `/compact` with Pi-native queued input ahead of an extension-owned `/reload`, and abort recovery with repeated queued reloads.

The [public evidence comment](https://github.com/tmustier/pi-queue-steer/pull/9#issuecomment-5231404721) embeds the replacement Menlo-rendered videos and screenshots. Its [reproducible evidence bundle](https://github.com/user-attachments/files/30873175/pi-queue-steer-normal-pi-evidence-37fcd14.zip) has SHA-256 `c6b1150f13fccc195eb5747aa6af63c4589b73df116e3d36d27e92fb85a45e98`. The archive contains machine-checked assertions, tapes, captures, deterministic-suite output and bounded sanitized session proof slices.

This evidence confirms the public API boundary: ordinary input submitted while manual compaction is active belongs to Pi's native post-compaction queue and can execute before extension-owned command rows resume.

## Public API boundary

`ExtensionAPI.sendUserMessage` and the TUI editor submit callback return `void`. The extension can restore synchronous handoff failures and preflight/expansion failures, but it cannot prove every later asynchronous acceptance or rejection without risking duplicate delivery. Queued `/reload` likewise has no result channel. These limits are documented in the README and are not hidden by timing heuristics.
