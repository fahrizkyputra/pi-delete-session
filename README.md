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
| `/delete-session list` | Opens a checklist of sessions in the current project; `space` toggles, `enter` deletes |
| `/delete-session list --all` | Same checklist, across every project |
| `/delete-session <query>` | Opens the checklist pre-filtered to sessions matching a search term |
| `/delete-session help` | Prints the usage summary |

Checklist keys: `↑`/`↓` (or `k`/`j`) move, `space` toggles, `a` selects all, `enter` confirms, `esc` cancels.

```
/delete-session list

  Sessions in this project
  ❯ [x] Fix auth bug             (current) — 5m ago · 18 msg
    [ ] deploy script                      — 2h ago · 31 msg
    [ ] untitled                           — 3d ago · 4 msg

  1 selected of 3 · space toggle · a all · enter delete · esc cancel
```

## What happens on delete

- **Confirmation first.** The current-session dialog shows the session file, its entry count, and its size. Bulk delete lists every selected session before touching anything.
- **Trash-safe.** Files are moved to the OS trash with the `trash` CLI when it is installed, and unlinked otherwise. Same behavior as Pi's built-in picker.
- **No orphan writes.** When the active session is deleted, a new session starts *first*, so Pi never re-creates the file you just deleted.
- **Works without a TUI.** In RPC mode the bulk flow falls back to one-by-one selection dialogs.

## Notes

- Deleting sessions is permanent from Pi's point of view. Prefer `/export` if you might want the transcript later.
- `/delete-session list` reads sessions through Pi's own `SessionManager`, so custom `sessionDir` settings and project grouping behave exactly like `/resume`.

## Development

```bash
npm install
npm test          # node:test, no Pi required
npm run typecheck # tsc --noEmit
```

Try it locally without publishing:

```bash
pi -e /path/to/pi-delete-session
```

`src/handlers.ts` holds the command logic behind an injected host, `src/session-files.ts` holds the filesystem helpers, and `extensions/delete-session.ts` is the thin wiring into Pi.

## License

MIT
