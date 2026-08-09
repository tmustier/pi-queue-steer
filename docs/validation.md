# Compaction and reload validation

This document records the deterministic validation workflow for compaction-aware command rows. The implementation remains extension-only and uses public Pi extension APIs.

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

The suite covers queue and edit invariants, command classification, images, one-at-a-time and all-mode delivery, preparation-failure restoration, non-TUI pass-through, prompt and Skill expansion, manual compaction success and failure, automatic overflow compaction, retry ordering, reload restoration, and compaction/native-input ordering.

## Real TUI evidence

`test/tui-evidence.sh` starts the real Pi TUI under tmux with a deterministic faux provider. It uses actual terminal key sequences, public compaction lifecycle events, public provider registration, runtime reloads, and Pi's native compaction queue.

Run:

```bash
./test/tui-evidence.sh /tmp/pi-queue-tui-evidence
```

The output directory contains terminal captures, provider-call logs, lifecycle-event logs, and runtime-initialization logs. Run it immediately before review so `summary.txt` records the exact Pi version, commit, and working-tree state under test. A release evidence run should report `working tree: clean`.

The harness verifies manual compaction success and failure, abort pause and resume, queued reload restoration, resource expansion, native post-compaction ordering, overflow handling, and all-mode FIFO delivery.

## Public API boundary

`ExtensionAPI.sendUserMessage` and the TUI editor submit callback return `void`. The extension restores rows when prompt or Skill expansion fails before handoff, but it cannot observe later asynchronous acceptance or rejection without risking duplicate delivery. Queued `/reload` likewise has no result channel.

`ExtensionContext.compact` reports completion and failure through `onComplete` and `onError`. Command rows remain blocked until one of those callbacks releases the queue.
