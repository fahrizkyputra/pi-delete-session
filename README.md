# pi-delete-session

Delete the Pi session you are in — or multi-select saved sessions and clean them up in bulk — from one slash command.

Pi ships session deletion only inside the `/resume` picker (`Ctrl+D`, one file at a time). This extension adds the command people actually reach for.

## Install

```bash
pi install npm:@fahrizkyputra/pi-delete-session
```

Or try it for one run:

```bash
pi -e npm:@fahrizkyputra/pi-delete-session
```

## Usage

| Command | What it does |
|---|---|
| `/delete-session` | Deletes the **active** session after a confirmation, then starts a fresh session |
| `/delete-session list` | Opens a searchable checklist of sessions in the current project |
| `/delete-session list --all` | Same checklist, across every project |
| `/delete-session <query>` | Opens the checklist with the search already filled in |
| `/delete-session help` | Prints the usage summary |

### Checklist keys

| Key | Action |
|---|---|
| type anything | Filters as you type: matches session name, first message, transcript text, or cwd |
| `↑` / `↓` | Move the highlight |
| `tab` | Switch between searching and selecting |
| `space` | Toggle the highlighted session (select mode) |
| `a` | Toggle every session the current search shows (select mode) |
| `enter` | Delete the selected sessions |
| `esc` | Clear the search, then leave the checklist |

Selections survive filtering, so you can search `auth`, tick one session, search `deploy`, tick another, and delete both at once.

```
/delete-session list

  Sessions in this project
  ⌕ deploy▌
  ────────────────────────────
    [x] Deploy script (current) — 5m ago · 18 msg
    [ ] deploy hotfix notes     — 2h ago · 31 msg
  2 of 7 shown
  1 selected · searching · ↑↓ move · tab: select mode · enter: delete 1 · esc: clear
```

## What happens on delete

- **Confirmation first.** The current-session dialog shows the session file, its entry count, and its size. Bulk delete lists every selected session before touching anything.
- **Favorites are protected by a second question.** Sessions marked `★` (see [`pi-session-favorites`](https://pi.dev/packages/@fahrizkyputra/pi-session-favorites)) trigger another confirmation before they are removed; declining it cancels the whole deletion, so nothing is lost by accident.
- **Trash-safe.** Files are moved to the OS trash with the `trash` CLI when it is installed, and unlinked otherwise. Same behavior as Pi's built-in picker.
- **No orphan writes.** When the active session is deleted, a new session starts *first*, so Pi never re-creates the file you just deleted.
- **Works without a TUI.** In RPC mode the bulk flow falls back to one-by-one selection dialogs.

## Notes

- Deleting sessions is permanent from Pi's point of view. Prefer `/export` if you might want the transcript later.
- `/delete-session list` reads sessions through Pi's own `SessionManager`, so custom `sessionDir` settings and project grouping behave exactly like `/resume`.
- Favorite detection is a plain check on the `★ ` name prefix, so this package works whether or not `pi-session-favorites` is installed.
- The search field is Pi's own `Input` component, so typing, pasting, word-delete, and IME behavior match the rest of the terminal UI.

## Development

```bash
npm install
npm test          # node:test, no Pi required
npm run typecheck # tsc --noEmit
npm run test:e2e  # real Pi over RPC: runs /delete-session and checks the file is gone
```

`npm run test:e2e` needs the `pi` binary on `PATH` and a Pi build with the RPC extension UI sub-protocol. It answers the confirmation dialog over the wire and fails on any `extension_error` event, so stale-context regressions surface in CI instead of in your terminal.

Try it locally without publishing:

```bash
pi -e /path/to/pi-delete-session
```

`src/handlers.ts` holds the command logic behind an injected host, `src/session-files.ts` holds the filesystem helpers, and `extensions/delete-session.ts` is the thin wiring into Pi. Never touch the command context after `newSession()`: the replacement makes it stale, and Pi throws.

## License

MIT
