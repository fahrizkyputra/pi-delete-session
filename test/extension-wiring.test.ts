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
