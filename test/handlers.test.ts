import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	type DeleteSessionHost,
	HELP_TEXT,
	deleteCurrentSession,
	deleteSessionsWithPicker,
	runDeleteSessionCommand,
} from "../src/handlers.ts";
import { formatAge, sessionTitle } from "../src/session-files.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-delete-session-handlers-"));
	dirs.push(dir);
	return dir;
}

function makeSessionFile(dir: string, name: string): string {
	const path = join(dir, name);
	writeFileSync(path, '{"type":"session"}\n');
	return path;
}

function makeSession(path: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path,
		id: `id-${path}`,
		cwd: "/tmp/project",
		created: new Date("2026-03-01T10:00:00.000Z"),
		modified: new Date(),
		messageCount: 4,
		firstMessage: "hello world",
		allMessagesText: "hello world and more",
		...overrides,
	};
}

function selectLabel(session: SessionInfo): string {
	return `${sessionTitle(session, 60)} · ${formatAge(session.modified)} · ${session.messageCount} msg`;
}

interface MockOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	currentSessionPath?: string;
	sessions?: SessionInfo[];
	confirmReply?: boolean;
	selectReplies?: (string | undefined)[];
	picked?: string[] | undefined;
	cancelNewSession?: boolean;
}

function createHarness(options: MockOptions = {}) {
	const notifications: { message: string; type?: string }[] = [];
	const confirmTitles: string[] = [];
	const stats = { newSessionCalls: 0, fileExistedAtNewSession: undefined as boolean | undefined };
	const sessions = options.sessions ?? [];
	let selectIndex = 0;

	const host: DeleteSessionHost = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			confirm: async (title) => {
				confirmTitles.push(title);
				return options.confirmReply ?? true;
			},
			notify: (message, type) => {
				notifications.push({ message, type });
			},
			select: async () => {
				const replies = options.selectReplies ?? [];
				return replies[selectIndex++];
			},
		},
		currentSessionPath: options.currentSessionPath,
		currentSessionEntryCount: 7,
		listSessions: async () => sessions,
		startNewSession: async (after) => {
			stats.newSessionCalls++;
			stats.fileExistedAtNewSession = options.currentSessionPath
				? existsSync(options.currentSessionPath)
				: undefined;
			if (options.cancelNewSession) return { cancelled: true };
			await after({ ...host, currentSessionPath: undefined });
			return { cancelled: false };
		},
		pickSessions: async () => options.picked,
	};

	return { host, notifications, confirmTitles, stats };
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("deleteCurrentSession deletes the file after starting a new session", async () => {
	const dir = tempDir();
	const path = makeSessionFile(dir, "current.jsonl");
	const { host, notifications, stats } = createHarness({ currentSessionPath: path });

	await deleteCurrentSession(host);

	assert.equal(existsSync(path), false);
	assert.equal(stats.newSessionCalls, 1);
	assert.equal(stats.fileExistedAtNewSession, true, "file must survive until the new session is active");
	assert.match(notifications.at(-1)?.message ?? "", /A new session is active/);
	assert.equal(notifications.at(-1)?.type, "info");
});

test("deleteCurrentSession keeps the file when the user cancels", async () => {
	const dir = tempDir();
	const path = makeSessionFile(dir, "current.jsonl");
	const { host, notifications, stats } = createHarness({ currentSessionPath: path, confirmReply: false });

	await deleteCurrentSession(host);

	assert.equal(existsSync(path), true);
	assert.equal(stats.newSessionCalls, 0);
	assert.match(notifications.at(-1)?.message ?? "", /Cancelled/);
});

test("deleteCurrentSession reports an unsaved session and does nothing", async () => {
	const { host, notifications, stats } = createHarness({ currentSessionPath: undefined });

	await deleteCurrentSession(host);

	assert.equal(stats.newSessionCalls, 0);
	assert.match(notifications.at(-1)?.message ?? "", /not saved to disk/);
});

test("deleteCurrentSession refuses to run without a UI", async () => {
	const dir = tempDir();
	const path = makeSessionFile(dir, "current.jsonl");
	const { host, notifications, stats } = createHarness({ currentSessionPath: path, hasUI: false });

	await deleteCurrentSession(host);

	assert.equal(existsSync(path), true);
	assert.equal(stats.newSessionCalls, 0);
	assert.equal(notifications.at(-1)?.type, "warning");
});

test("deleteCurrentSession survives a cancelled session replacement", async () => {
	const dir = tempDir();
	const path = makeSessionFile(dir, "current.jsonl");
	const { host, notifications } = createHarness({ currentSessionPath: path, cancelNewSession: true });

	await deleteCurrentSession(host);

	assert.equal(existsSync(path), true, "the active session must not be deleted when replacement is cancelled");
	assert.match(notifications.at(-1)?.message ?? "", /cancelled/i);
});

test("deleteSessionsWithPicker deletes only the checked sessions", async () => {
	const dir = tempDir();
	const first = makeSessionFile(dir, "first.jsonl");
	const second = makeSessionFile(dir, "second.jsonl");
	const sessions = [makeSession(first), makeSession(second, { firstMessage: "other work" })];
	const { host, notifications, confirmTitles } = createHarness({ sessions, picked: [first] });

	await deleteSessionsWithPicker(host, { scope: "project" });

	assert.equal(existsSync(first), false);
	assert.equal(existsSync(second), true);
	assert.match(confirmTitles[0] ?? "", /Delete 1 session\?/);
	assert.match(notifications.at(-1)?.message ?? "", /1 session deleted/);
});

test("deleteSessionsWithPicker starts a new session when the active session is selected", async () => {
	const dir = tempDir();
	const current = makeSessionFile(dir, "current.jsonl");
	const other = makeSessionFile(dir, "other.jsonl");
	const sessions = [makeSession(current), makeSession(other, { firstMessage: "other" })];
	const { host, notifications, stats } = createHarness({
		currentSessionPath: current,
		sessions,
		picked: [current, other],
	});

	await deleteSessionsWithPicker(host, { scope: "project" });

	assert.equal(stats.newSessionCalls, 1);
	assert.equal(stats.fileExistedAtNewSession, true);
	assert.equal(existsSync(current), false);
	assert.equal(existsSync(other), false);
	assert.match(notifications.at(-1)?.message ?? "", /2 sessions deleted \(a new session is active\)/);
});

test("deleteSessionsWithPicker reports an empty query match outside the TUI", async () => {
	const dir = tempDir();
	const path = makeSessionFile(dir, "one.jsonl");
	const { host, notifications } = createHarness({
		mode: "json",
		sessions: [makeSession(path, { name: "alpha" })],
	});

	await deleteSessionsWithPicker(host, { scope: "project", query: "zzz" });

	assert.equal(existsSync(path), true);
	assert.match(notifications.at(-1)?.message ?? "", /No sessions match/);
});

test("deleteSessionsWithPicker hands the TUI every session plus the search text", async () => {
	const dir = tempDir();
	const first = makeSessionFile(dir, "first.jsonl");
	const second = makeSessionFile(dir, "second.jsonl");
	const sessions = [makeSession(first, { name: "alpha" }), makeSession(second, { name: "beta" })];
	const seen: { count: number; query?: string } = { count: -1 };
	const { host } = createHarness({ sessions });
	host.pickSessions = async (candidates, options) => {
		seen.count = candidates.length;
		seen.query = options.initialQuery;
		return [second];
	};

	await deleteSessionsWithPicker(host, { scope: "project", query: "beta" });

	assert.equal(seen.count, 2, "the checklist filters live, so it receives unfiltered candidates");
	assert.equal(seen.query, "beta");
	assert.equal(existsSync(second), false);
	assert.equal(existsSync(first), true);
});

test("deleteSessionsWithPicker reports nothing selected", async () => {
	const dir = tempDir();
	const path = makeSessionFile(dir, "one.jsonl");
	const { host, notifications } = createHarness({ sessions: [makeSession(path)], picked: [] });

	await deleteSessionsWithPicker(host, { scope: "project" });

	assert.equal(existsSync(path), true);
	assert.match(notifications.at(-1)?.message ?? "", /Nothing selected/);
});

test("deleteSessionsWithPicker falls back to one-by-one dialogs outside the TUI", async () => {
	const dir = tempDir();
	const first = makeSessionFile(dir, "first.jsonl");
	const second = makeSessionFile(dir, "second.jsonl");
	const firstSession = makeSession(first, { name: "first" });
	const secondSession = makeSession(second, { name: "second" });
	const { host, notifications } = createHarness({
		mode: "json",
		sessions: [firstSession, secondSession],
		selectReplies: [selectLabel(secondSession), "Done — delete the selected sessions"],
	});

	await deleteSessionsWithPicker(host, { scope: "project" });

	assert.equal(existsSync(first), true);
	assert.equal(existsSync(second), false);
	assert.match(notifications.at(-1)?.message ?? "", /1 session deleted/);
});

test("deleteSessionsWithPicker surfaces deletion failures", async () => {
	const dir = tempDir();
	const doomed = join(dir, "not-a-file");
	mkdirSync(doomed);
	const { host, notifications } = createHarness({
		sessions: [makeSession(doomed, { name: "doomed" })],
		picked: [doomed],
	});

	const originalPath = process.env.PATH;
	process.env.PATH = "/nonexistent-bin";
	try {
		await deleteSessionsWithPicker(host, { scope: "project" });
	} finally {
		process.env.PATH = originalPath;
	}

	assert.equal(notifications.at(-1)?.type, "error");
	assert.match(notifications.at(-1)?.message ?? "", /Failed: doomed/);
});

test("runDeleteSessionCommand routes arguments", async () => {
	const dir = tempDir();
	const listed = makeSessionFile(dir, "listed.jsonl");
	const listedSession = makeSession(listed, { name: "listed" });

	const help = createHarness();
	await runDeleteSessionCommand(help.host, "help");
	assert.equal(help.notifications.at(-1)?.message, HELP_TEXT);

	const listHarness = createHarness({ sessions: [listedSession], picked: [listed] });
	await runDeleteSessionCommand(listHarness.host, "list");
	assert.equal(existsSync(listed), false);

	const queried = makeSessionFile(dir, "queried.jsonl");
	const queriedSession = makeSession(queried, { name: "queried" });
	const queryHarness = createHarness({ sessions: [queriedSession], picked: [queried] });
	await runDeleteSessionCommand(queryHarness.host, "queried");
	assert.match(queryHarness.confirmTitles[0] ?? "", /Delete 1 session\?/);
	assert.equal(existsSync(queried), false);
});

test("runDeleteSessionCommand with no arguments targets the current session", async () => {
	const dir = tempDir();
	const current = makeSessionFile(dir, "current.jsonl");
	const { host, confirmTitles } = createHarness({ currentSessionPath: current });

	await runDeleteSessionCommand(host, "   ");

	assert.match(confirmTitles[0] ?? "", /Delete this session\?/);
	assert.equal(existsSync(current), false);
});
