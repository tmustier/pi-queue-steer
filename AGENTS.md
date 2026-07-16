# Contributor guidance

## Commands

- Install dependencies: `npm install`
- Type-check: `npm run check`
- Test: `npm test`
- Full verification: `npm run ci`

## Invariants

- Use Pi's public extension APIs; do not patch Pi core.
- Keep queue state and edit drafts session-local and out of the transcript.
- Preserve FIFO order, stable item IDs, image attachments, and failed-dispatch restoration.
- Preserve configured Pi keybindings by matching action IDs rather than hard-coded escape sequences.
- Compose with previously installed custom editors and retain their input behavior.
- Treat row edits as snapshots: save in place; Escape rolls back the entire editing session.
- Dispatch pauses only when the oldest row has an unsaved edit.

Keep tests close to these invariants and visually verify TUI changes in a real Pi session.
