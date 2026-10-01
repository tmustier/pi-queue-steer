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

Latest result for the automatic-compaction steering fix: 88 tests passed on both Pi 0.87.0 (the lockfile) and Pi 0.99.2 (the current installed release).

## Automatic-compaction steering regression

Validated on 1 October 2026 against code revision `ae8b7b3bd88fec4a6a4453e0a8c25119b0c9c353`. The later validation-record commit changes documentation only.

The regression test makes Pi compact between tool turns, then queues steering while the next assistant response is gated. It checks that the following provider request sees the steering before `agent_end`, with one agent run and exactly one delivered steering message. The test uses actual `AgentSession` scheduling, real bash tools and a deterministic provider.

Against the original `91e3a5f` implementation, all 5 targeted regressions failed: continuing-tool-run delivery, automatic compaction success, failure, cancellation, and native-input ordering with mid-run steering. They pass with the fix. Additional checks preserve paused and edited heads. The full suite passed with 88 tests on both Pi versions.

The full `test/tui-evidence.sh` harness also passed on both versions at the tested revision with a clean working tree. It covers manual compaction success and failure, abort recovery, native-input-before-command ordering, repeated reloads, overflow recovery, resources and all-mode FIFO delivery.

### Live-model proof

A separate scratch Pi 0.99.2 TUI used provider `openai`, model `gpt-6.1-sol`, and medium thinking. It loaded the fixed extension and a scratch `queue_probe` tool. Normal Pi summarization performed automatic threshold compaction. The scratch compaction settings were `reserveTokens: 266000` and `keepRecentTokens: 200` (agent defaults for this test, not user rules). No production settings changed.

The prompt was:

```text
This is an isolated queue-steer regression test. Use queue_probe only. Call inflate first, then call hold in a separate later assistant turn, then call record with token ORIGINAL in a later turn, then finish. Never batch phases in one assistant turn. The filler is disposable and can be summarized very briefly. If a later steering message changes the token, record its token instead. Do not skip phases or ask questions.
```

The model called `inflate`, Pi compacted from 26,628 tokens, and the model called `hold`. While that tool waited, the TUI queued:

```text
Steering update: when the hold tool returns, call queue_probe record with token STEERED instead of ORIGINAL, then finish.
```

After the tool was released, the steering left the visible queue. Pi compacted again, and the model called `record` with `token: "STEERED"` before its final response. Independent file and transcript assertions confirmed:

- the scratch result file contained `{"phase":"record","token":"STEERED"}`
- the transcript contained exactly one steering user message, before the recording tool call
- the event log contained one `agent_start` and one `agent_end`
- the recording tool ran before `agent_end`, after the first compaction completed

Terminal captures showed the queued steering row beside the waiting tool, then the delivered message and recording tool. This live run covers successful threshold compaction and mid-run steering. Automatic failure and cancellation use deterministic regressions; native-input ordering uses deterministic and real-TUI tests. Asynchronous public-API rejection remains outside the extension's acknowledgement contract.

## Real TUI evidence

`test/tui-evidence.sh` starts the real resolved Pi TUI under tmux with a deterministic faux provider. It uses actual terminal key sequences, public compaction lifecycle events, public provider registration, actual runtime reloads, and Pi's real native compaction queue.

Run:

```bash
./test/tui-evidence.sh /tmp/pi-queue-tui-evidence
```

The output directory contains plain terminal captures, provider-call logs, lifecycle-event logs, and runtime-initialization logs. Run it immediately before review so `summary.txt` records the exact Pi version, commit and working-tree state under test. A release evidence run should report `working tree: clean`.

The full harness passed against Pi 0.87.0 for this compatibility update. The latest retained clean release-evidence run reported:

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
