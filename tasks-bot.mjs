#!/usr/bin/env node
// The bot's way into Tasks: list, add, complete and trash to-dos.
//
// Talks to the sync server's /api with the *bot key*, which can do exactly
// these four things and nothing else. No dependencies — copy this one file
// anywhere with Node 18+ and it works.
//
// Usage:
//   tasks-bot.mjs list [today|upcoming|later|all] [--project P] [--area A]
//                      [--tag T] [--search TEXT]
//   tasks-bot.mjs add "Buy milk @today #errands" ["another…"]
//   tasks-bot.mjs add --from tasks.json      (or --from - for stdin, or inline JSON)
//   tasks-bot.mjs done <id | exact title>
//   tasks-bot.mjs remove <id | exact title>          (moves it to Trash)
//   tasks-bot.mjs meta                               (projects, areas, tags)
//
// Options:
//   --json             machine-readable output (on any command)
//   --from SRC         (add) read tasks as JSON from a file, `-` (stdin) or a literal
//   --create-missing   (add) create a project/area that doesn't exist yet
//   --dry-run          (add) show what would be added, write nothing
//   --server URL       default $TASKS_SERVER or https://tasks.judemakes.dev
//
// Key: $TASKS_BOT_KEY, else ~/.config/tasks/bot.key. Never passed as an
// argument, so it can't end up in a shell history or a process listing.
//
// Inline syntax for add, same as the app's importer:
//   @…  when: today | evening | later | tomorrow | YYYY-MM-DD   (default: later)
//   !…  deadline: today | tomorrow | YYYY-MM-DD
//   #…  tag (created if new)
//   +…  project, ~… area — bare word or +"quoted name"; must already exist
//
// JSON shape for add: { title, notes, when, deadline, tags, project, area, checklist }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_SERVER = process.env.TASKS_SERVER || "https://tasks.judemakes.dev";
const KEY_FILE = path.join(os.homedir(), ".config", "tasks", "bot.key");

// ---------- inline task syntax ----------

/** Pulls a bare word or a "quoted phrase" starting at index i. */
function readValue(line, i) {
  if (line[i] === '"' || line[i] === "'") {
    const quote = line[i];
    const end = line.indexOf(quote, i + 1);
    if (end === -1) return { value: line.slice(i + 1), end: line.length };
    return { value: line.slice(i + 1, end), end: end + 1 };
  }
  let end = i;
  while (end < line.length && !/\s/.test(line[end])) end++;
  return { value: line.slice(i, end), end };
}

/** "Buy milk @today #errands +Home" -> { title, when, tags, project, … }. */
function parseTaskLine(line) {
  const spec = { title: "", tags: [] };
  const words = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const atBoundary = i === 0 || /\s/.test(line[i - 1]);
    if (atBoundary && "@!#+~".includes(ch) && i + 1 < line.length && !/\s/.test(line[i + 1])) {
      const { value, end } = readValue(line, i + 1);
      if (ch === "@") spec.when = value;
      else if (ch === "!") spec.deadline = value;
      else if (ch === "#") spec.tags.push(value);
      else if (ch === "+") spec.project = value;
      else spec.area = value;
      i = end;
      continue;
    }
    words.push(ch);
    i++;
  }
  spec.title = words.join("").replace(/\s+/g, " ").trim();
  if (!spec.title) throw new Error(`no title in "${line}"`);
  return spec;
}

// ---------- server ----------

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readKey() {
  const fromEnv = (process.env.TASKS_BOT_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    throw new Error(`no bot key. Set TASKS_BOT_KEY or save it to ${KEY_FILE} (the server prints it on start; it's data/bot.key there)`);
  }
}

async function api(opts, method, route, { query, body } = {}) {
  const url = new URL(route, opts.server);
  url.searchParams.set("today", todayISO());
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
  const key = readKey();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`couldn't reach ${opts.server} (${e.cause?.code || e.message})`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${url.pathname} → ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 401) throw new Error("the server rejected the bot key");
  if (!res.ok) throw new Error(data.error || `${method} ${url.pathname} failed with ${res.status}`);
  return data;
}

// ---------- output ----------

function describe(t) {
  const bits = [t.when];
  if (t.deadline) bits.push(`due ${t.deadline}`);
  if (t.project) bits.push(`+${t.project}`);
  if (t.area) bits.push(`~${t.area}`);
  for (const tag of t.tags || []) bits.push(`#${tag}`);
  if (t.checklist) bits.push(`${t.checklist.filter((c) => c.done).length}/${t.checklist.length} checklist`);
  if (t.repeat) bits.push(t.repeat);
  return bits.join(" · ");
}

function printTasks(tasks) {
  if (!tasks.length) return console.log("(nothing)");
  let section = null;
  for (const t of tasks) {
    if (t.list !== section) {
      section = t.list;
      console.log(`${section === "today" ? "Today" : section === "upcoming" ? "Upcoming" : "Later"}:`);
    }
    console.log(`  ${t.id}  ${t.title}   (${describe(t)})`);
    if (t.notes) for (const line of t.notes.split("\n")) console.log(`      ${line}`);
  }
}

// ---------- commands ----------

/** An id is 20 hex-ish chars; anything else is taken as an exact title. */
async function resolveTask(opts, ref) {
  if (/^[0-9a-f]{20}$/.test(ref)) return ref;
  const { tasks } = await api(opts, "GET", "/api/tasks", { query: { q: ref } });
  const want = ref.trim().toLowerCase();
  const exact = tasks.filter((t) => t.title.trim().toLowerCase() === want);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) {
    throw new Error(`${exact.length} open to-dos are titled "${ref}" — use the id:\n` + exact.map((t) => `  ${t.id}  ${t.title}   (${describe(t)})`).join("\n"));
  }
  if (tasks.length) {
    throw new Error(`no open to-do titled exactly "${ref}". Close matches:\n` + tasks.slice(0, 8).map((t) => `  ${t.id}  ${t.title}   (${describe(t)})`).join("\n"));
  }
  throw new Error(`no open to-do titled "${ref}"`);
}

const commands = {
  async list(opts, args) {
    const list = args[0] && !args[0].startsWith("-") ? args.shift() : "all";
    const data = await api(opts, "GET", "/api/tasks", {
      query: { list, project: opts.project, area: opts.area, tag: opts.tag, q: opts.search },
    });
    if (opts.json) return console.log(JSON.stringify(data, null, 2));
    printTasks(data.tasks);
  },

  async meta(opts) {
    const data = await api(opts, "GET", "/api/meta");
    if (opts.json) return console.log(JSON.stringify(data, null, 2));
    const show = (label, items) => console.log(`${label}:\n${items.length ? items.map((i) => `  ${i}`).join("\n") : "  (none)"}`);
    show("Projects", data.projects.map((p) => `${p.title}${p.area ? ` (~${p.area})` : ""} — ${p.openTasks} open`));
    show("Areas", data.areas);
    show("Tags", data.tags);
    console.log(`\n${data.openTasks} open to-do${data.openTasks === 1 ? "" : "s"}.`);
  },

  async add(opts, args) {
    let specs;
    if (opts.from !== undefined) {
      const raw = opts.from === "-" ? fs.readFileSync(0, "utf8")
        : /^\s*[\[{]/.test(opts.from) ? opts.from
        : fs.readFileSync(opts.from, "utf8");
      const parsed = JSON.parse(raw);
      specs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tasks) ? parsed.tasks : [parsed];
      specs = specs.map((s) => (typeof s === "string" ? parseTaskLine(s) : s));
    } else {
      if (!args.length) throw new Error('nothing to add — give a task like add "Buy milk @today", or --from');
      specs = args.map(parseTaskLine);
    }
    if (opts.dryRun) {
      if (opts.json) return console.log(JSON.stringify({ dryRun: true, tasks: specs }, null, 2));
      console.log(`Would add ${specs.length}:`);
      for (const s of specs) console.log(`  • ${s.title}   (${describe({ ...s, when: s.when || "later" })})`);
      return;
    }
    const data = await api(opts, "POST", "/api/tasks", {
      body: { tasks: specs, createMissing: !!opts.createMissing, today: todayISO() },
    });
    if (opts.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`Added ${data.added.length}:`);
    for (const t of data.added) console.log(`  ${t.id}  ${t.title}   (${describe(t)})`);
    for (const c of data.created) console.log(`  + created ${c.kind} "${c.name}"`);
  },

  async done(opts, args) {
    if (!args.length) throw new Error("done needs an id or an exact title");
    const id = await resolveTask(opts, args.join(" "));
    const data = await api(opts, "POST", `/api/tasks/${id}/done`);
    if (opts.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`Completed: ${data.task.title}`);
    if (data.next) console.log(`Next occurrence: ${data.next.id}  ${data.next.title}   (${describe(data.next)})`);
  },

  async remove(opts, args) {
    if (!args.length) throw new Error("remove needs an id or an exact title");
    const id = await resolveTask(opts, args.join(" "));
    const data = await api(opts, "DELETE", `/api/tasks/${id}`);
    if (opts.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`Moved to Trash: ${data.trashed.title}`);
  },
};

// ---------- cli ----------

function parseArgs(argv) {
  const opts = { server: DEFAULT_SERVER };
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--json": opts.json = true; break;
      case "--from": opts.from = next(); break;
      case "--project": opts.project = next(); break;
      case "--area": opts.area = next(); break;
      case "--tag": opts.tag = next(); break;
      case "--search": case "-s": opts.search = next(); break;
      case "--create-missing": opts.createMissing = true; break;
      case "--dry-run": case "-n": opts.dryRun = true; break;
      case "--server": opts.server = next(); break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-") && a !== "-") throw new Error(`unknown option ${a}`);
        args.push(a);
    }
  }
  return { opts, args };
}

function help() {
  const lines = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
  const doc = [];
  for (const l of lines) {
    if (!l.startsWith("//")) break;
    doc.push(l.replace(/^\/\/ ?/, ""));
  }
  console.log(doc.join("\n").trim());
}

async function main() {
  const { opts, args } = parseArgs(process.argv.slice(2));
  const cmd = args.shift();
  if (opts.help || !cmd) return help();
  const run = commands[cmd];
  if (!run) throw new Error(`unknown command "${cmd}" (list, add, done, remove, meta — or --help)`);
  await run(opts, args);
}

main().catch((e) => {
  console.error(`tasks-bot: ${e.message}`);
  process.exit(1);
});
