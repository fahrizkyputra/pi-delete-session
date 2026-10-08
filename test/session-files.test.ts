import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	deleteSessionFile,
	describeSession,
	filterSessions,
	formatAge,
	formatBytes,
	isSamePath,
	sessionFileSize,
	sessionTitle,
	summarizeSessions,
} from "../src/session-files.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-delete-session-"));
	dirs.push(dir);
	return dir;
}

function makeSession(path: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path,
		id: "session-id",
		cwd: "/tmp/project",
		created: new Date("2026-03-01T10:00:00.000Z"),
		modified: new Date("2026-03-01T11:00:00.000Z"),
		messageCount: 4,
		firstMessage: "hello world",
		allMessagesText: "hello world and more",
		...overrides,
	};
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("deleteSessionFile removes the file with unlink when trash is disabled", () => {
	const path = join(tempDir(), "a.jsonl");
	writeFileSync(path, "{}\n");
	const result = deleteSessionFile(path, { useTrash: false });
	assert.equal(result.ok, true);
	assert.equal(result.method, "unlink");
	assert.equal(sessionFileSize(path), undefined);
});

test("deleteSessionFile reports success for an already missing file", () => {
	const result = deleteSessionFile(join(tempDir(), "nope.jsonl"), { useTrash: false });
	assert.equal(result.ok, true);
});

test("deleteSessionFile falls back to unlink when trash is unavailable", () => {
	const path = join(tempDir(), "b.jsonl");
	writeFileSync(path, "{}\n");
	const originalPath = process.env.PATH;
	process.env.PATH = "/nonexistent-bin";
	try {
		const result = deleteSessionFile(path);
		assert.equal(result.ok, true);
		assert.equal(result.method, "unlink");
		assert.equal(sessionFileSize(path), undefined);
	} finally {
		process.env.PATH = originalPath;
	}
});

test("deleteSessionFile fails cleanly when the path cannot be unlinked", () => {
	const dir = tempDir();
	const originalPath = process.env.PATH;
	process.env.PATH = "/nonexistent-bin";
	try {
		const result = deleteSessionFile(dir);
		assert.equal(result.ok, false);
		assert.equal(typeof result.error, "string");
	} finally {
		process.env.PATH = originalPath;
	}
});

test("isSamePath resolves symlinks", () => {
	const dir = tempDir();
	const path = join(dir, "session.jsonl");
	writeFileSync(path, "{}\n");
	const link = join(dir, "link.jsonl");
	symlinkSync(path, link);
	assert.equal(isSamePath(path, link), true);
	assert.equal(isSamePath(path, join(dir, "other.jsonl")), false);
});

test("formatBytes scales units", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(1024), "1.0 KB");
	assert.equal(formatBytes(1536), "1.5 KB");
	assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
	assert.equal(formatBytes(200 * 1024 * 1024), "200 MB");
});

test("formatAge renders coarse buckets", () => {
	const now = new Date("2026-03-01T12:00:00.000Z");
	assert.equal(formatAge(new Date("2026-03-01T11:59:40.000Z"), now), "just now");
	assert.equal(formatAge(new Date("2026-03-01T11:30:00.000Z"), now), "30m ago");
	assert.equal(formatAge(new Date("2026-03-01T06:00:00.000Z"), now), "6h ago");
	assert.equal(formatAge(new Date("2026-02-24T12:00:00.000Z"), now), "5d ago");
});

test("sessionTitle prefers the user-set name and collapses whitespace", () => {
	assert.equal(sessionTitle(makeSession("/x", { name: "Fix   auth", firstMessage: "hi" })), "Fix auth");
	assert.equal(sessionTitle(makeSession("/x", { name: undefined, firstMessage: "first   message" })), "first message");
	assert.equal(sessionTitle(makeSession("/x", { name: "   ", firstMessage: "  " })), "(untitled)");
	assert.equal(sessionTitle(makeSession("/x", { name: "abcdefghij" }), 5), "abcd…");
});

test("filterSessions matches name, first message, body text, and id", () => {
	const sessions = [
		makeSession("/a", { name: "Deploy script" }),
		makeSession("/b", { firstMessage: "fix login bug" }),
		makeSession("/c", { allMessagesText: "talks about kubernetes" }),
	];
	assert.deepEqual(filterSessions(sessions, "deploy").map((s) => s.path), ["/a"]);
	assert.deepEqual(filterSessions(sessions, "LOGIN").map((s) => s.path), ["/b"]);
	assert.deepEqual(filterSessions(sessions, "kubernetes").map((s) => s.path), ["/c"]);
	assert.equal(filterSessions(sessions, "").length, 3);
	assert.equal(filterSessions(sessions, "zzz").length, 0);
});

test("summarizeSessions lists entries and totals, then truncates", () => {
	const sessions = Array.from({ length: 15 }, (_, index) => makeSession(`/s/${index}.jsonl`));
	const summary = summarizeSessions(sessions);
	assert.match(summary, /15 sessions/);
	assert.match(summary, /and 3 more/);
	assert.match(summary, /OS trash/);
});

test("describeSession joins title, age, and message count", () => {
	const description = describeSession(makeSession("/x", { name: "Named", firstMessage: "original" }));
	assert.match(description, /^Named · "original" · /);
	assert.match(description, /4 msg$/);
});
