import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const STATUS_ID = "pi-memories";
const DEFAULT_MAX_INDEX_BYTES = 60_000;
const DEFAULT_MAX_INJECT_BYTES = 200_000;
const DEFAULT_TRIGGERS = [
	"read memories",
	"check memories",
	"load memories",
	"remember memories",
	"use memories",
	"@memories",
	"@pi-memories",
];

const CYAN = "\x1b[38;5;51m";
const RESET = "\x1b[0m";
const LABEL = `${CYAN}Pi Memories${RESET}`;

type MemoryScope = "project" | "user";

type MemoryFile = {
	id: string;
	label: string;
	absPath: string;
	scope: MemoryScope;
};

function memoryRoot(): string {
	const override = process.env.PI_MEMORIES_DIR?.trim();
	return override || path.join(os.homedir(), ".pi", "memory");
}

function encodePath(p: string): string {
	return p.replace(/\//g, "-");
}

function projectMemoryDir(cwd: string): string {
	return path.join(memoryRoot(), "projects", encodePath(path.resolve(cwd)));
}

function userMemoryDir(): string {
	return path.join(memoryRoot(), "user");
}

function indexPath(dir: string): string {
	return path.join(dir, "MEMORY.md");
}

function maxIndexBytes(): number {
	const raw = process.env.PI_MEMORIES_MAX_INDEX_BYTES?.trim();
	if (!raw) return DEFAULT_MAX_INDEX_BYTES;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_INDEX_BYTES;
}

function maxInjectBytes(): number {
	const raw = process.env.PI_MEMORIES_MAX_INJECT_BYTES?.trim();
	if (!raw) return DEFAULT_MAX_INJECT_BYTES;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_INJECT_BYTES;
}

function triggers(): string[] {
	const raw = process.env.PI_MEMORIES_TRIGGERS?.trim();
	if (!raw) return DEFAULT_TRIGGERS;
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

function triggersEnabled(): boolean {
	const raw = process.env.PI_MEMORIES_TRIGGER?.trim().toLowerCase();
	if (!raw) return true;
	return !["0", "false", "no", "off"].includes(raw);
}

function injectionEnabled(): boolean {
	const raw = process.env.PI_MEMORIES_INJECT?.trim().toLowerCase();
	if (!raw) return true;
	return !["0", "false", "no", "off"].includes(raw);
}

function ensureDir(p: string): void {
	try {
		fs.mkdirSync(p, { recursive: true });
	} catch {
		/* best effort */
	}
}

function safeRead(p: string): string | null {
	try {
		const stat = fs.statSync(p);
		if (!stat.isFile()) return null;
		return fs.readFileSync(p, "utf8");
	} catch {
		return null;
	}
}

function listMemoryFiles(dir: string, scope: MemoryScope): MemoryFile[] {
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const prefix = scope === "project" ? "project" : "user";
	return entries
		.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
		.map((e) => ({
			id: `${prefix}/${e.name}`,
			label: e.name,
			absPath: path.join(dir, e.name),
			scope,
		}))
		.sort((a, b) => a.label.localeCompare(b.label));
}

function truncateForPrompt(content: string, budget: number): string {
	if (content.length <= budget) return content;
	return `${content.slice(0, budget)}\n[truncated: exceeded ${budget} bytes]`;
}

function matchTrigger(text: string): { matched: boolean; stripped: string } {
	const lower = text.toLowerCase();
	for (const phrase of triggers()) {
		const idx = lower.indexOf(phrase);
		if (idx !== -1) {
			const stripped = (text.slice(0, idx) + text.slice(idx + phrase.length)).trim();
			return { matched: true, stripped };
		}
	}
	return { matched: false, stripped: text };
}

function buildInjectionBlock(
	projectDir: string,
	userDir: string,
	projectIndex: string | null,
	userIndex: string | null,
	projectFiles: MemoryFile[],
	userFiles: MemoryFile[],
): string {
	const total =
		(projectIndex != null ? 1 : 0) +
		(userIndex != null ? 1 : 0) +
		projectFiles.length +
		userFiles.length;
	if (total === 0) {
		return "<pi-memory>(no pi memory files found)</pi-memory>";
	}

	const budget = maxInjectBytes();
	const parts: string[] = [];
	let used = 0;

	const addPart = (header: string, body: string) => {
		const remaining = budget - used - header.length;
		if (remaining <= 200) {
			parts.push(`${header}[truncated: size budget exhausted]`);
			return false;
		}
		const chunk =
			body.length > remaining ? `${body.slice(0, remaining)}\n[truncated]` : body;
		parts.push(header + chunk);
		used += header.length + chunk.length;
		return true;
	};

	if (projectIndex != null) {
		if (!addPart(`--- project/MEMORY.md (${path.join(projectDir, "MEMORY.md")}) ---\n`, projectIndex)) {
			return `<pi-memory>\n${parts.join("\n\n")}\n</pi-memory>`;
		}
	}
	for (const f of projectFiles) {
		const body = safeRead(f.absPath);
		if (body == null) continue;
		if (!addPart(`--- ${f.id} (${f.absPath}) ---\n`, body)) {
			return `<pi-memory>\n${parts.join("\n\n")}\n</pi-memory>`;
		}
	}
	if (userIndex != null) {
		if (!addPart(`--- user/MEMORY.md (${path.join(userDir, "MEMORY.md")}) ---\n`, userIndex)) {
			return `<pi-memory>\n${parts.join("\n\n")}\n</pi-memory>`;
		}
	}
	for (const f of userFiles) {
		const body = safeRead(f.absPath);
		if (body == null) continue;
		if (!addPart(`--- ${f.id} (${f.absPath}) ---\n`, body)) {
			return `<pi-memory>\n${parts.join("\n\n")}\n</pi-memory>`;
		}
	}

	return `<pi-memory>\n${parts.join("\n\n")}\n</pi-memory>`;
}

function buildMemoryPrompt(
	projectDir: string,
	userDir: string,
	projectIndex: string | null,
	userIndex: string | null,
): string {
	const budget = maxIndexBytes();
	const projectBlock = projectIndex == null
		? "(empty — create `MEMORY.md` here when you save your first memory)"
		: truncateForPrompt(projectIndex, budget);
	const userBlock = userIndex == null
		? "(empty — create `MEMORY.md` here for cross-project facts like user role and preferences)"
		: truncateForPrompt(userIndex, budget);

	return `

# auto memory

You have a persistent, file-based memory system. Two directories exist and are writable with the \`write\` tool — do not run mkdir or check for their existence:

- Project-scoped memory: \`${projectDir}\` (scoped to this working directory)
- User-level memory: \`${userDir}\` (cross-project facts about the user)

You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.

If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry. Prefer project memory for project-specific facts, user memory for facts that apply across projects.

## Types of memory

There are four discrete types of memory you can store:

### user
Contains information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Aim to be helpful — avoid judgmental framing. **Save when:** you learn any details about the user's role, preferences, responsibilities, or knowledge. Usually belongs in *user-level* memory.

### feedback
Guidance the user has given you about how to approach work — both what to avoid AND what to keep doing. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated. **Save when:** the user corrects you ("no not that", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "keep doing that"). Lead with the rule, then **Why:** and **How to apply:** lines so you can judge edge cases later.

### project
Information about ongoing work, goals, initiatives, bugs, or incidents not derivable from the code or git history. **Save when:** you learn who is doing what, why, or by when. Always convert relative dates to absolute dates ("Thursday" → "2026-04-23"). Lead with the fact, then **Why:** and **How to apply:** lines. Usually belongs in *project* memory.

### reference
Pointers to where information can be found in external systems (Linear, Grafana, Slack, etc.). **Save when:** you learn about external resources and their purpose. Short, one line is usually enough.

## What NOT to save

- Code patterns, conventions, architecture, file paths, or project structure — can be derived by reading the code.
- Git history or who-changed-what — \`git log\` / \`git blame\` are authoritative.
- Debugging fix recipes — the fix is in the code; the commit has the context.
- Anything already documented in CLAUDE.md / AGENTS.md files.
- Ephemeral task details: in-progress work, current conversation context.

These exclusions apply even if the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that's the part worth keeping.

## How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own \`.md\` file in the appropriate directory (e.g., \`user_role.md\`, \`feedback_testing.md\`). Use this frontmatter format:

\`\`\`markdown
---
name: {memory name}
description: {one-line description — used to decide relevance later, be specific}
type: {user | feedback | project | reference}
---

{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}
\`\`\`

**Step 2** — add a one-line pointer in the same directory's \`MEMORY.md\` index:

\`- [Title](file.md) — one-line hook\`

\`MEMORY.md\` is an index, not a memory. Lines after ~150 are not guaranteed to survive injection, so keep each entry under 150 characters. Never write memory content directly into \`MEMORY.md\`.

Rules:
- Keep name/description/type in frontmatter in sync with the content.
- Organize by topic, not chronology.
- Update or remove memories that turn out wrong or stale.
- Do not write duplicate memories. Before creating one, check \`MEMORY.md\` for an existing file you can update instead.

## When to access memories

- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* memory: do not apply, cite, or mention memory content.
- Memories can become stale. Before acting on a memory that names a specific file, function, or flag, verify it still exists (grep / ls). "The memory said X exists" is not the same as "X exists now." Update or remove stale memories rather than acting on them.

---

## Current project MEMORY.md (\`${projectDir}/MEMORY.md\`)

\`\`\`
${projectBlock}
\`\`\`

## Current user MEMORY.md (\`${userDir}/MEMORY.md\`)

\`\`\`
${userBlock}
\`\`\`
`;
}

export default function piMemoriesExtension(pi: ExtensionAPI) {
	let projectDir = "";
	let userDir = userMemoryDir();
	let projectIndex: string | null = null;
	let userIndex: string | null = null;
	let projectFiles: MemoryFile[] = [];
	let userFiles: MemoryFile[] = [];
	let forceInjectNext = false;

	function refresh(cwd: string) {
		projectDir = projectMemoryDir(cwd);
		userDir = userMemoryDir();
		ensureDir(projectDir);
		ensureDir(userDir);
		projectIndex = safeRead(indexPath(projectDir));
		userIndex = safeRead(indexPath(userDir));
		projectFiles = listMemoryFiles(projectDir, "project");
		userFiles = listMemoryFiles(userDir, "user");
	}

	function reloadIndices() {
		projectIndex = safeRead(indexPath(projectDir));
		userIndex = safeRead(indexPath(userDir));
		projectFiles = listMemoryFiles(projectDir, "project");
		userFiles = listMemoryFiles(userDir, "user");
	}

	function allFiles(): MemoryFile[] {
		return [...projectFiles, ...userFiles];
	}

	function updateStatus(ctx: ExtensionContext) {
		const total = projectFiles.length + userFiles.length;
		const suffix = total === 0 ? "empty" : `${total} file(s)`;
		ctx.ui.setStatus(STATUS_ID, `${LABEL}: ${suffix}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		refresh(ctx.cwd);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!injectionEnabled()) return;
		reloadIndices();
		return {
			systemPrompt:
				event.systemPrompt +
				buildMemoryPrompt(projectDir, userDir, projectIndex, userIndex),
		};
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" };
		reloadIndices();
		const total = projectFiles.length + userFiles.length;
		if (total === 0 && !forceInjectNext) return { action: "continue" };

		const triggersOn = triggersEnabled();
		const { matched, stripped } = triggersOn
			? matchTrigger(event.text)
			: { matched: false, stripped: event.text };
		const shouldInject = matched || forceInjectNext;
		if (!shouldInject) return { action: "continue" };
		forceInjectNext = false;

		const injection = buildInjectionBlock(
			projectDir,
			userDir,
			projectIndex,
			userIndex,
			projectFiles,
			userFiles,
		);
		const remainder = (matched ? stripped : event.text).trim();
		const tail = remainder.length > 0 ? remainder : "(Please acknowledge the loaded pi memories.)";
		return {
			action: "transform",
			text: `${injection}\n\n${tail}`,
		};
	});

	pi.registerCommand("pi-memory-refresh", {
		description: "Rescan pi memory directories and reload indices",
		handler: async (_args, ctx) => {
			refresh(ctx.cwd);
			updateStatus(ctx);
			const total = projectFiles.length + userFiles.length;
			ctx.ui.notify(
				total === 0
					? "Pi memories: empty (no files yet)."
					: `Pi memories: ${projectFiles.length} project, ${userFiles.length} user.`,
				"info",
			);
		},
	});

	pi.registerCommand("pi-memory-list", {
		description: "List pi memory files (project + user scope)",
		handler: async (_args, ctx) => {
			reloadIndices();
			updateStatus(ctx);
			const files = allFiles();
			if (files.length === 0) {
				ctx.ui.notify(
					`No pi memories yet.\nProject dir: ${projectDir}\nUser dir:    ${userDir}`,
					"info",
				);
				return;
			}
			const lines = files.map(
				(f) => `${f.scope === "project" ? "[proj]" : "[user]"} ${f.id} — ${f.absPath}`,
			);
			ctx.ui.notify(`Pi memories:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("pi-memory-show", {
		description: "Print the contents of one pi memory file",
		getArgumentCompletions: (prefix) => {
			reloadIndices();
			const q = prefix.trim().toLowerCase();
			const items = allFiles()
				.map((f) => ({ value: f.id, label: `${f.id} — ${f.absPath}` }))
				.filter((item) => !q || item.value.toLowerCase().includes(q));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			reloadIndices();
			const files = allFiles();
			if (files.length === 0) {
				ctx.ui.notify("No pi memories found.", "warning");
				return;
			}
			let id = args.trim();
			if (!id) {
				const options = files.map((f) => `${f.id} — ${f.absPath}`);
				const selected = await ctx.ui.select("Choose a memory file", options);
				if (!selected) return;
				id = selected.split(" — ", 1)[0] ?? "";
			}
			const match = files.find((f) => f.id === id);
			if (!match) {
				ctx.ui.notify(`Not found: ${id}`, "error");
				return;
			}
			const body = safeRead(match.absPath);
			if (body == null) {
				ctx.ui.notify(`Could not read ${match.absPath}`, "error");
				return;
			}
			ctx.ui.notify(`${match.absPath}\n\n${body}`, "info");
		},
	});

	pi.registerCommand("pi-memory-load", {
		description: "Force-inject all pi memory contents into the next turn",
		handler: async (_args, ctx) => {
			reloadIndices();
			const total = projectFiles.length + userFiles.length;
			if (total === 0) {
				ctx.ui.notify("No pi memories to inject yet.", "warning");
				return;
			}
			forceInjectNext = true;
			ctx.ui.notify(
				`Will inject ${projectFiles.length} project + ${userFiles.length} user memory file(s) on the next turn.`,
				"info",
			);
		},
	});

	pi.registerCommand("pi-memory-debug", {
		description: "Print the exact system-prompt block pi-memories is injecting right now",
		handler: async (_args, ctx) => {
			reloadIndices();
			const block = buildMemoryPrompt(projectDir, userDir, projectIndex, userIndex);
			ctx.ui.notify(
				`Injection status: ${injectionEnabled() ? "ON" : "OFF"}\nTriggers: ${triggersEnabled() ? triggers().join(", ") : "disabled"}\nProject dir: ${projectDir}\nUser dir:    ${userDir}\n\n=== system-prompt addition ===\n${block}`,
				"info",
			);
		},
	});

	pi.registerCommand("pi-memory-clear", {
		description: "Delete all pi memory files in the current scope (asks for confirmation)",
		getArgumentCompletions: () => [
			{ value: "project", label: "project — only this project's memories" },
			{ value: "user", label: "user — only cross-project user memories" },
			{ value: "all", label: "all — both project and user scope" },
		],
		handler: async (args, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			let scope: "project" | "user" | "all";
			if (arg === "project" || arg === "user" || arg === "all") {
				scope = arg;
			} else {
				const selected = await ctx.ui.select("Clear which scope?", [
					"project",
					"user",
					"all",
				]);
				if (!selected) return;
				scope = selected as typeof scope;
			}
			const targets: string[] = [];
			if (scope === "project" || scope === "all") targets.push(projectDir);
			if (scope === "user" || scope === "all") targets.push(userDir);

			const confirmed = await ctx.ui.confirm(
				"Clear pi memories?",
				`This will delete every .md file in:\n${targets.join("\n")}\n\nContinue?`,
			);
			if (!confirmed) return;

			let removed = 0;
			for (const dir of targets) {
				try {
					const entries = fs.readdirSync(dir, { withFileTypes: true });
					for (const e of entries) {
						if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
							fs.unlinkSync(path.join(dir, e.name));
							removed++;
						}
					}
				} catch {
					/* dir may not exist yet */
				}
			}
			reloadIndices();
			updateStatus(ctx);
			ctx.ui.notify(`Removed ${removed} memory file(s).`, "info");
		},
	});
}
