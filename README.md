# pi-queue-steer

[![CI](https://github.com/tmustier/pi-queue-steer/actions/workflows/ci.yml/badge.svg)](https://github.com/tmustier/pi-queue-steer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Cursor-style visible follow-up queue for [Pi](https://github.com/earendil-works/pi-mono).

Queue prompts while the agent is working, see their FIFO order, and move directly into any row to edit it. The selected row becomes the live Pi editor: the cursor, wrapping, paste handling, autocomplete, and custom-editor behavior stay intact, but the editor's separate frame disappears so changing rows feels like moving focus rather than opening a new component.

[Watch the 19-second demo](assets/pi-queue-steer-demo.mp4)

## Install

Install directly from GitHub:

```bash
pi install git:github.com/tmustier/pi-queue-steer
```

To pin the first release instead of tracking `main`:

```bash
pi install git:github.com/tmustier/pi-queue-steer@v0.1.0
```

Then start a new Pi session or run `/reload`.

To try it for one session without installing:

```bash
pi -e git:github.com/tmustier/pi-queue-steer
```

## Controls

The extension follows your configured Pi action bindings. These are the defaults on macOS terminals:

| Context | Key | Action |
|---|---|---|
| Agent working | `Enter` | Steer the current run through Pi's normal input path |
| Agent working | `Option+Enter` | Add a visible follow-up to the FIFO |
| Queue visible | `Option+Up` | Select the row nearest the composer, then move upward through the queue |
| Editing a row | Type normally | Edit directly inside the selected row |
| Editing a row | `Option+Up` | Keep the current draft and move the live editor to the previous row |
| Editing a row | `Enter` or `Option+Enter` | Save all row edits in place |
| Editing a row | `Escape` | Cancel the editing session and roll back all unsaved row edits |
| Empty composer, queue visible | `Enter` | Send the oldest follow-up now |

On other terminals, `Option` may be labelled `Alt`.

## Queue semantics

- Follow-ups dispatch one at a time in FIFO order.
- Editing never changes a row's position or delivery mode.
- Cycling can edit several rows as one rollback-safe snapshot.
- FIFO pauses only when the oldest row has an unsaved edit. Editing a later row does not block older work.
- A failed send is restored at the front of the queue.
- Text and image attachments stay together when a row is edited.
- Queue state and edit drafts are session-local and are never written to the Pi transcript.
- An unrelated composer draft is left untouched; clear or send it before entering queue-edit mode.

## Editor composition

pi-queue-steer wraps the active Pi editor instead of replacing its input model. This keeps app keybindings and composes with custom editors such as raw-paste and pi-session-hud.

For display, it extracts the live editor's content and cursor from the editor's own frame, then places that content inside the selected queue row. Autocomplete rows remain visible beneath the edited text.

## Development

```bash
npm install
npm run ci
pi -e ./index.ts
```

The automated suite covers queue ordering, stable edits, rollback, dispatch restoration, editor-frame extraction, and the inline row transition. TUI changes should also be checked in a real interactive Pi session.

Tested with Pi 0.80.9.

## Security

Pi extensions run with the same system permissions as Pi. Review extension source before installing any third-party package.

## Licence

MIT. See [LICENSE](LICENSE).

This project is inspired by Cursor's queue interaction and is not affiliated with Cursor or Anysphere.
