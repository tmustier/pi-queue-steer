# Changelog

## Unreleased

- Add command rows: `/compact [instructions]` and `/reload` queue in FIFO position and execute only once the agent is idle, so rows behind them wait — e.g. a queued `continue` delivers after compaction completes.
- Queue a mid-run `Enter` on `/reload` instead of surfacing Pi's built-in "wait until the agent finishes" warning; mid-run `Enter` on `/compact` keeps Pi's built-in behaviour.
- Restore rows queued behind a `/reload` after the runtime swap.
- Execute idle `Option+Enter` command submissions instead of letting them reach the LLM as text.

- Add `Option+X` to mark the selected row for removal — deleted on save, restored by `Escape` or a second press, and finally covering image-only rows.
- Add `Option+T` to re-lane the selected row between steering and follow-up, previewing at its destination tail before the save commits it.
- Navigate row selection through the visual timeline so lane previews and `Option+Up`/`Option+Down` movement stay aligned.

- Show steering and follow-ups as separate lanes in one delivery-ordered timeline.
- Group the lanes into stacked blue and yellow boxes with aligned inline editing.
- Add a compact looping demo in the original GitHub Dark terminal treatment, starting on a populated screen.
- Keep steering rows editable until Pi's native turn boundary.
- Honour Pi's independent `one-at-a-time` and `all` modes at active-run delivery boundaries.
- Add `Option+Down` navigation and recency-first `Option+Up` selection.
- Pin edited heads so asynchronous delivery cannot consume a row under the cursor.
- Stash unrelated composer text and remove empty text-only rows on save.
- Pause both lanes after an abort and require an explicit empty `Enter` to resume.
- Feed follow-ups into Pi's native continuation queue to preserve transcript and run semantics.

## 0.1.0 — 2026-07-16

- Add a visible, session-local FIFO for queued Pi follow-ups.
- Add inline row editing with stable queue positions and rollback on Escape.
- Preserve image attachments, editor integrations, and failed dispatches.
- Compose with existing Pi custom editors while removing nested editor chrome from the active row.
