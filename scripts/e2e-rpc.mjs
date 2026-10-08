#!/usr/bin/env node
/**
 * End-to-end check for /delete-session against a real Pi process.
 *
 * Runs Pi in RPC mode, loads this package's extension, submits
 * `/delete-session`, answers the confirmation dialog over the wire, and then
 * asserts that the session file is gone and that no stale-context error was
 * reported.
 *
 * Usage:  npm run e2e           (requires the `pi` binary on PATH)
 *         node scripts/e2e-rpc.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 60_000;
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "delete-session.ts");

const root = mkdtempSync(join(tmpdir(), "pi-delete-session-e2e-"));
const agentDir = join(root, "agent");
const workDir = join(root, "work");
const sessionDir = join(root, "sessions");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

const sessionFile = join(sessionDir, "2026-01-01T00-00-00_e2e0001.jsonl");
writeFileSync(
	sessionFile,
	[
		JSON.stringify({
			type: "session",
			version: 3,
			id: "e2e0001",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: workDir,
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "e2e fixture message" }] },
		}),
	].join("\n") + "\n",
);

const notifications = [];
const errors = [];
const extensionErrors = [];
let confirmed = false;
let promptHandled = false;

const child = spawn(
	"pi",
	["--mode", "rpc", "--session", sessionFile, "-e", extensionPath],
	{
		cwd: workDir,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_SESSION_DIR: sessionDir,
		},
		stdio: ["pipe", "pipe", "pipe"],
	},
);

child.stderr.on("data", (chunk) => {
	errors.push(chunk.toString());
});

let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (line.length > 0) handleLine(line);
	}
});

function handleLine(line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}

	if (event.type === "extension_error") {
		extensionErrors.push(String(event.error ?? event.message ?? JSON.stringify(event)));
		return;
	}

	if (event.type === "extension_ui_request") {
		if (event.method === "confirm") {
			confirmed = true;
			reply({ type: "extension_ui_response", id: event.id, confirmed: true });
		} else if (event.method === "notify") {
			notifications.push(String(event.message ?? ""));
		}
		return;
	}

	if (event.type === "response" && event.command === "prompt") {
		if (event.data?.disposition === "handled") promptHandled = true;
		else {
			promptFailure = `prompt disposition was ${event.data?.disposition ?? "unknown"}`;
			finish();
		}
	}
}

let promptFailure = null;
let finished = false;

function reply(payload) {
	child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function fail(message) {
	console.error(`FAIL: ${message}`);
	finish(1);
}

function finish(code = 0) {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	child.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
	if (code === 0) console.log("e2e ok: /delete-session removed the active session through the real Pi runtime");
	process.exit(code);
}

const timer = setTimeout(() => fail("timed out"), TIMEOUT_MS);

// Give Pi a moment to load extensions, then submit the command.
setTimeout(() => {
	reply({ id: "p1", type: "prompt", message: "/delete-session" });
}, 3000);

setTimeout(() => {
	const staleError = [...errors, ...extensionErrors, ...notifications].find((text) =>
		text.includes("stale after session replacement"),
	);
	if (staleError) fail(`stale context error surfaced: ${staleError.trim().slice(0, 160)}`);
	if (extensionErrors.length > 0) fail(`extension error: ${extensionErrors.join(" ").slice(0, 200)}`);
	if (promptFailure) fail(promptFailure);
	if (!confirmed) fail("the confirmation dialog never appeared");
	if (!promptHandled) fail("the prompt was not handled as an extension command");
	if (existsSync(sessionFile)) fail(`session file still exists: ${sessionFile}`);
	if (!notifications.some((text) => /new session is active/i.test(text))) {
		fail(`no success notification, got: ${notifications.join(" | ")}`);
	}
	if (errors.some((text) => text.includes("Extension error"))) {
		fail(`extension error: ${errors.join(" ").trim().slice(0, 200)}`);
	}
	finish(0);
}, 12_000);
