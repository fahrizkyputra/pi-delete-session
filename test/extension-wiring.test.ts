/**
 * Wiring test for the extension entry point.
 *
 * Pi invalidates a command context after `newSession()`. Any later call on the
 * old context throws "This extension ctx is stale after session replacement".
 * These tests use a context whose methods throw once replaced, so the wiring
 * fails loudly instead of shipping that bug.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import deleteSessionExtension from "../extensions/delete-session.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-delete-session-wiring-"));
	dirs.push(dir);
	return dir;
}

interface StaleState {
	stale: boolean;
}

interface CtxOptions {
	sessionPath?: string;
	sessionName?: string;
	sessionDir?: string;
	notifications: string[];
	confirms: string[];
}

function createCtx(state: StaleState, options: CtxOptions): any {
	const guard =
		<T extends (...args: any[]) => any>(name: string, fn: T): T =>
		((...args: any[]) => {
			if (state.stale) {
				throw new Error(
					`This extension ctx is stale after session replacement. (used ${name})`,
				);
			}
			return fn(...args);
		}) as T;

	const freshState: StaleState = { stale: false };

	return {
		mode: "tui",
		hasUI: true,
		cwd: "/private/tmp/pi-delete-session-wiring",
		ui: {
			confirm: guard("ui.confirm", async (title: string) => {
				options.confirms.push(title);
				return true;
			}),
			notify: guard("ui.notify", (message: string) => {
				options.notifications.push(message);
			}),
			select: guard("ui.select", async () => undefined),
			setStatus: guard("ui.setStatus", () => {}),
			custom: guard("ui.custom", async () => undefined),
		},
		sessionManager: {
			getSessionFile: guard("sessionManager.getSessionFile", () => options.sessionPath),
			getSessionName: guard("sessionManager.getSessionName", () => options.sessionName),
			getEntries: guard("sessionManager.getEntries", () => [{}, {}, {}]),
			getSessionDir: guard("sessionManager.getSessionDir", () => options.sessionDir ?? "/tmp"),
		},
		newSession: guard("newSession", async (newSessionOptions: { withSession?: (ctx: any) => Promise<void> }) => {
			state.stale = true;
			await newSessionOptions.withSession?.(createCtx(freshState, options));
			return { cancelled: false };
		}),
	};
}

function loadCommand(): { handler: (args: string, ctx: any) => Promise<void> } {
	let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
	const pi = {
		registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
			if (name === "delete-session") command = definition;
		},
	};
	deleteSessionExtension(pi as unknown as ExtensionAPI);
	assert.ok(command, "delete-session command must be registered");
	return command;
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("handler survives session replacement without touching the stale context", async () => {
	const dir = tempDir();
	const sessionPath = join(dir, "current.jsonl");
	writeFileSync(sessionPath, '{"type":"session"}\n');

	const notifications: string[] = [];
	const confirms: string[] = [];
	const ctx = createCtx({ stale: false }, { sessionPath, sessionDir: dir, notifications, confirms });

	const command = loadCommand();
	await command.handler("", ctx);

	assert.equal(existsSync(sessionPath), false, "the active session file must be deleted");
	assert.match(notifications.at(-1) ?? "", /new session is active/i);
	assert.equal(confirms.length, 1);
});

test("handler reports an unsaved session without starting a replacement", async () => {
	const notifications: string[] = [];
	const confirms: string[] = [];
	const ctx = createCtx({ stale: false }, { sessionPath: undefined, notifications, confirms });

	const command = loadCommand();
	await command.handler("", ctx);

	assert.match(notifications.at(-1) ?? "", /not saved to disk/);
	assert.equal(ctx.mode, "tui");
});

// ---- screenshots: recorded per tool call, removed with their session ----------------------------------

import { mkdirSync as mkdirSyncFs, utimesSync } from "node:fs";

function loadWithHooks(shotsDir: string, agentDir: string) {
	const previousShots = process.env.PI_DELETE_SESSION_SHOTS_DIR;
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_DELETE_SESSION_SHOTS_DIR = shotsDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const hooks: Record<string, ((event: any, ctx: any) => unknown)[]> = {};
	let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
	const pi = {
		on: (name: string, handler: (event: any, ctx: any) => unknown) => {
			(hooks[name] ??= []).push(handler);
		},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
			if (name === "delete-session") command = definition;
		},
	};
	deleteSessionExtension(pi as unknown as ExtensionAPI);
	const restore = () => {
		if (previousShots === undefined) delete process.env.PI_DELETE_SESSION_SHOTS_DIR;
		else process.env.PI_DELETE_SESSION_SHOTS_DIR = previousShots;
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
	};
	const run = async (name: string, event: any, ctx: any) => {
		for (const handler of hooks[name] ?? []) await handler(event, ctx);
	};
	return { hooks, command: command!, restore, run };
}

/** A tool call that saves `files` (relative to the shots folder) and mentions `text`. */
async function toolCall(run: (n: string, e: any, c: any) => Promise<void>, ctx: any, shotsDir: string, id: string, files: string[], text: string) {
	await run("tool_call", { toolCallId: id, toolName: "bash", input: { command: text } }, ctx);
	for (const file of files) {
		const path = join(shotsDir, file);
		mkdirSyncFs(join(path, ".."), { recursive: true });
		writeFileSync(path, `png ${id} ${file}`);
		utimesSync(path, new Date(), new Date(Date.now() + Math.random() * 1000));
	}
	await run("tool_result", { toolCallId: id, toolName: "bash", input: { command: text }, content: [{ type: "text", text: "ok" }], isError: false }, ctx);
}

test("photos a session saved go with it; other sessions' photos and untracked files stay", async () => {
	const dir = tempDir();
	const shotsDir = join(dir, "shots");
	mkdirSyncFs(shotsDir, { recursive: true });
	const sessionDir = join(dir, "sessions");
	mkdirSyncFs(sessionDir, { recursive: true });
	const current = join(sessionDir, "current.jsonl");
	const other = join(sessionDir, "other.jsonl");
	writeFileSync(current, '{"type":"session"}\n');
	writeFileSync(other, '{"type":"session"}\n');
	const untracked = join(shotsDir, "made-before.png");
	writeFileSync(untracked, "old");

	const { command, restore, run } = loadWithHooks(shotsDir, join(dir, "agent"));
	try {
		const notifications: string[] = [];
		const confirms: string[] = [];
		const otherCtx = createCtx({ stale: false }, { sessionPath: other, sessionDir, notifications: [], confirms: [] });
		await toolCall(run, otherCtx, shotsDir, "o1", ["other-ui/shot.png"], "M=~/.agent-browser/shots/other-ui; agent-browser screenshot $M/shot.png");

		const ctx = createCtx({ stale: false }, { sessionPath: current, sessionDir, notifications, confirms, confirmBodies: [] } as any);
		await toolCall(run, ctx, shotsDir, "c1", ["app-login/shot.png", "app-login/shot-dark.png"], "M=~/.agent-browser/shots/app-login; agent-browser screenshot $M/shot.png; agent-browser screenshot $M/shot-dark.png");
		// A photo another process saved during this session's call, which the call never names.
		await run("tool_call", { toolCallId: "c2", toolName: "bash", input: { command: "sleep 1" } }, ctx);
		writeFileSync(join(shotsDir, "someone-else.png"), "x");
		await run("tool_result", { toolCallId: "c2", toolName: "bash", input: { command: "sleep 1" }, content: [], isError: false }, ctx);

		await command.handler("", ctx);

		assert.equal(existsSync(current), false);
		assert.equal(existsSync(join(shotsDir, "app-login")), false, "the session's photos and their folder are gone");
		assert.equal(existsSync(join(shotsDir, "other-ui", "shot.png")), true, "another session's photo stays");
		assert.equal(existsSync(join(shotsDir, "someone-else.png")), true, "a photo the call did not name stays");
		assert.equal(existsSync(untracked), true, "a photo nobody recorded stays");
		assert.match(notifications.at(-1) ?? "", /2 photos/);
	} finally {
		restore();
	}
});

test("recording never breaks a tool call, even with an unreadable shots folder", async () => {
	const dir = tempDir();
	const { restore, run } = loadWithHooks(join(dir, "does-not-exist"), join(dir, "agent"));
	try {
		const ctx = createCtx({ stale: false }, { sessionPath: join(dir, "s.jsonl"), notifications: [], confirms: [] });
		await assert.doesNotReject(run("tool_call", { toolCallId: "x", toolName: "bash", input: {} }, ctx));
		await assert.doesNotReject(run("tool_result", { toolCallId: "x", toolName: "bash", input: {}, content: [], isError: false }, ctx));
	} finally {
		restore();
	}
});
