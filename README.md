# pi-memories

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that gives pi its own persistent, file-based memory system — modeled on Claude Code's auto-memory behavior.

Companion to [pi-claude-memories](https://github.com/Acelogic/pi-claude-memories): that one reads Claude's memory files, this one lets pi write and maintain its own. The two are designed to coexist — different storage dirs, different command names, different status entries.

## What it does

### 1. Passive auto-injection (always on)

On every turn (`before_agent_start`), injects a system-prompt block that:

1. Teaches pi the 4 memory types (`user`, `feedback`, `project`, `reference`), the frontmatter format, and when to save.
2. Includes the current contents of your project-scoped and user-scoped `MEMORY.md` indices.

Pi then uses its existing `write` / `edit` / `read` tools to create and maintain memory files on its own — no custom tool registration needed.

### 2. Active injection (trigger phrase)

If your user input contains any of these phrases (case-insensitive):

- `read memories`, `check memories`, `load memories`, `remember memories`, `use memories`, `@memories`, `@pi-memories`

…the **full contents** of every pi memory file are inlined as a `<pi-memory>` block in your user message (not just the MEMORY.md index). Use this when you want pi to actively reason over the memory bodies, not just know they exist.

These triggers overlap with `pi-claude-memories` by design: saying `read memories` makes both extensions inject their respective blocks (`<claude-memory>` + `<pi-memory>`) into the same turn.

## Storage

- **Project-scoped**: `~/.pi/memory/projects/<cwd-encoded>/`
  (e.g., `/Users/you/src/foo` → `-Users-you-src-foo`)
- **User-level** (cross-project): `~/.pi/memory/user/`

Each directory holds individual `*.md` memory files plus a `MEMORY.md` index that points to them.

## Compatibility with pi-claude-memories

- Different storage root: `~/.pi/memory/` vs `~/.claude/`
- Different status ID: `pi-memories` vs `claude-memories` — both appear in the footer
- Different commands: `/pi-memory-*` vs `/memories-*`
- Different env var prefix: `PI_MEMORIES_*` vs `PI_CLAUDE_MEMORIES_*`
- Different trigger behavior: pi-memories always auto-injects; pi-claude-memories injects on trigger phrase (`read memories`, etc.). Say `read memories` and pi-claude-memories will inject Claude's memories *in addition to* pi's own.

## Commands

- `/pi-memory-list` — list memory files in both scopes
- `/pi-memory-show [name]` — print one memory file (autocompletes)
- `/pi-memory-load` — force-inject all pi memory contents on the next turn
- `/pi-memory-refresh` — rescan memory directories
- `/pi-memory-debug` — print the exact system-prompt block being injected (for troubleshooting)
- `/pi-memory-clear [project|user|all]` — delete memory files in a scope (asks for confirmation)

## Install

```bash
pi install git:github.com/Acelogic/pi-memories
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/Acelogic/pi-memories"]
}
```

## Environment overrides

- `PI_MEMORIES_DIR` — override memory root (default `~/.pi/memory`)
- `PI_MEMORIES_INJECT=false` — disable passive system-prompt auto-injection
- `PI_MEMORIES_TRIGGER=false` — disable trigger-phrase active injection
- `PI_MEMORIES_TRIGGERS` — comma-separated trigger phrases (overrides defaults)
- `PI_MEMORIES_MAX_INDEX_BYTES=60000` — cap injected `MEMORY.md` size in system prompt (default 60 KB per scope)
- `PI_MEMORIES_MAX_INJECT_BYTES=200000` — cap total bytes of full-content trigger injection (default 200 KB)
