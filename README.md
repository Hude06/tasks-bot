# tasks-bot

A one-file, dependency-free client for [Jude's Tasks app](https://tasks.judemakes.dev) — the personal, Things-style to-do list that syncs between his Mac and phone. It lets a bot or script **list, add, reschedule, complete and trash** to-dos through the sync server's JSON API.

It needs a **bot key**, which Jude hands out separately. The key can do those things and nothing else.

## Setup (once per machine)

```sh
curl -fsSL https://raw.githubusercontent.com/Hude06/tasks-bot/main/tasks-bot.mjs -o tasks-bot.mjs
mkdir -p ~/.config/tasks
# save the key Jude gave you:
printf '%s\n' '<the key>' > ~/.config/tasks/bot.key && chmod 600 ~/.config/tasks/bot.key
```

Node 18+ is the only requirement. If the machine can't keep files between sessions, set `TASKS_BOT_KEY` in the environment instead of writing the file.

## Commands

```sh
node tasks-bot.mjs list                # everything open, grouped Today / Upcoming / Later
node tasks-bot.mjs list today          # just today's list (also: upcoming, later)
node tasks-bot.mjs list --project "Website Rebuild"
node tasks-bot.mjs list --search milk  # substring match on title or notes
node tasks-bot.mjs meta                # the projects, areas and tags that exist

node tasks-bot.mjs add "Buy milk @today #errands"
node tasks-bot.mjs add "Ship the release @2026-10-01 !2026-10-03 +\"Website Rebuild\""
node tasks-bot.mjs add --from tasks.json   # several at once, see below

node tasks-bot.mjs move <id> @tomorrow          # reschedule (also @today, @evening, @later, @2026-10-01)
node tasks-bot.mjs move "Buy milk" @2026-10-01 !2026-10-03   # with a deadline; --clear-deadline drops one
node tasks-bot.mjs done <id>           # mark complete (id from `list`)
node tasks-bot.mjs done "Buy milk"     # or by exact title, if it's unambiguous
node tasks-bot.mjs remove <id>         # move to Trash (Jude can restore it in the app)
```

Add `--json` to any command for machine-readable output. `--dry-run` on `add` shows what would be written without writing it.

## Writing a to-do

Inline: the title, then any of these tokens anywhere in the string:

| Token | Meaning |
|---|---|
| `@today` `@evening` `@tomorrow` `@2026-10-01` | when it's for. Omit it for **Later** — the right default for anything not genuinely due today |
| `!2026-10-03` `!tomorrow` | deadline |
| `#tag` | tag; created if new |
| `+Project` or `+"Two Words"` | file into a project — must already exist |
| `~Area` | file into an area — must already exist |

For more than a couple of tasks, write a JSON file and `add --from file.json`:

```json
[
  { "title": "Renew judemakes.com", "when": "2026-10-01", "deadline": "2026-10-10",
    "project": "Clients", "tags": ["admin"] },
  { "title": "Reply to Sam", "when": "today",
    "notes": "He asked about the Android build.",
    "checklist": ["find the APK link", "note the min SDK"] }
]
```

Titles are one line. Detail goes in `notes`; steps go in `checklist`.

## Rules for bots

- **Never print or echo the key.** Never pass it as an argument.
- **Never invent a project or area.** An unknown name is an error and nothing is written — on purpose. Run `meta` first if you mean to file something. `--create-missing` exists, but ask Jude before using it.
- **Only move, complete or remove what Jude asked you to.** If a title matches more than one open to-do the script refuses and shows the candidates; pick by id. `remove` moves to Trash, which Jude can restore from the app.
- **Tell Jude what you changed**, exactly as the script printed it, including the when/project.
- **Don't add to-dos he didn't ask for.** If something belongs on the list, propose it.
- **Exit code 0 means it happened.** Exit 1 means nothing was written — the message says why (bad project name, unreachable server, rejected key). Don't retry blindly.
- If the server is unreachable, say so and stop. Don't write the task somewhere else and call it done — nothing reads anywhere else.

## The API underneath

If you'd rather speak HTTP directly: `Authorization: Bearer <bot key>` on `https://tasks.judemakes.dev`.

| | |
|---|---|
| `GET /api/tasks` | open to-dos; `?list=today\|upcoming\|later\|all`, `&project=`, `&area=`, `&tag=`, `&q=` |
| `GET /api/meta` | projects, areas, tags, open count |
| `POST /api/tasks` | add — one `{title,…}`, an array, or `{tasks:[…], createMissing:true}` |
| `POST /api/tasks/:id/done` | complete; a repeating to-do returns its next occurrence too |
| `POST /api/tasks/:id/move` | reschedule — `{when, deadline}`; `deadline: null` clears it |
| `DELETE /api/tasks/:id` | move to Trash |

Pass `today=YYYY-MM-DD` (query or body) — your local date — so "today" and "tomorrow" mean your day, not the server's. The script does this for you.

The app and server live in a separate, private repo; this one holds only what a bot needs.
