#!/usr/bin/env node
/**
 * End-to-end check that /delete-session removes the screenshots its session made, and only those,
 * against a real Pi process whose model really calls the bash tool to take screenshots.
 *
 * The scripted model, in session A, runs (through Pi's bash tool):
 *     M=<shots>/a-ui; mkdir -p $M; agent-browser screenshot $M/shot.png
 * where `agent-browser` is a stand-in script that writes a PNG. A second Pi process (session B)
 * takes its own screenshot. A file nobody recorded is also in the folder. Then session A runs
 * /delete-session and confirms: A's photo goes, B's photo and the untracked file stay.
 *
 * Usage:  node scripts/e2e-shots.mjs
 *         PI_DELETE_SESSION_EXTENSION=npm:@fahrizkyputra/pi-delete-session node scripts/e2e-shots.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionSpec =
	process.env.PI_DELETE_SESSION_EXTENSION ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "delete-session.ts");
const root = mkdtempSync(join(tmpdir(), "pi-delete-session-e2e-shots-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const shotsDir = join(root, "shots");
const binDir = join(root, "bin");
const work = join(root, "work");
for (const dir of [agentDir, sessionDir, shotsDir, binDir, work]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
// A stand-in for agent-browser: `agent-browser screenshot <path>` writes a small PNG there.
writeFileSync(join(binDir, "agent-browser"), '#!/bin/sh\n[ "$1" = screenshot ] && printf "\\x89PNG fake $(date +%s%N)" > "$2"\n');
chmodSync(join(binDir, "agent-browser"), 0o755);
const untracked = join(shotsDir, "made-before-the-feature.png");
writeFileSync(untracked, "old");

// ---- scripted model: each session takes one screenshot in its own folder ------------------------
const sse = (delta, finish) =>
	`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`;
const server = createServer((request, response) => {
	let raw = "";
	request.on("data", (chunk) => (raw += chunk));
	request.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const messages = Array.isArray(body.messages) ? body.messages : [];
		response.writeHead(200, { "content-type": "text/event-stream" });
		const last = messages.at(-1);
		const user = JSON.stringify([...messages].reverse().find((m) => m.role === "user") ?? "");
		const folder = user.includes("SESSION-A") ? "a-ui" : user.includes("SESSION-B") ? "b-ui" : undefined;
		if (folder && last?.role === "user") {
			const command = `M=${shotsDir}/${folder}; mkdir -p $M; agent-browser screenshot $M/shot.png`;
			response.write(sse({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${folder}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, null));
			response.write(sse({}, "tool_calls"));
		} else {
			response.write(sse({ role: "assistant", content: "screenshot saved" }, null));
			response.write(sse({}, "stop"));
		}
		response.end("data: [DONE]\n\n");
	});
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const stub = join(root, "stub.ts");
writeFileSync(
	stub,
	`export default function (pi) { pi.registerProvider("stub", { baseUrl: "http://127.0.0.1:${server.address().port}/v1", apiKey: "k", api: "openai-completions", models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] }); }\n`,
);

// ---- a Pi process ------------------------------------------------------------------------------
function startPi(label) {
	const child = spawn("pi", ["--mode", "rpc", "-e", stub, "-e", extensionSpec], {
		cwd: work,
		env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_DELETE_SESSION_SHOTS_DIR: shotsDir },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const state = { label, child, settled: 0, notices: [], errors: [], responses: new Map(), confirms: 0 };
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line) continue;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event.type === "agent_settled") state.settled++;
			if (event.type === "extension_error") state.errors.push(line.slice(0, 300));
			if (event.type === "response" && event.id) state.responses.set(event.id, event);
			if (event.type === "extension_ui_request" && event.method === "notify") state.notices.push(String(event.message));
			if (event.type === "extension_ui_request" && event.method === "confirm") {
				state.confirms++;
				state.lastConfirm = `${event.title}\n${event.message}`;
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed: true })}\n`);
			}
		}
	});
	state.send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
	return state;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, ms = 30_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}
async function screenshotIn(pi, marker) {
	pi.send({ id: `m-${marker}`, type: "set_model", provider: "stub", modelId: "m" });
	await until(() => pi.responses.has(`m-${marker}`), "set_model");
	const before = pi.settled;
	pi.send({ id: `p-${marker}`, type: "prompt", message: `${marker}: take a screenshot` });
	await until(() => pi.settled > before, `${marker} to settle`);
}

let a;
let b;
let exitCode = 1;
try {
	a = startPi("A");
	b = startPi("B");
	await sleep(3000);
	await screenshotIn(a, "SESSION-A");
	await screenshotIn(b, "SESSION-B");
	const aShot = join(shotsDir, "a-ui", "shot.png");
	const bShot = join(shotsDir, "b-ui", "shot.png");
	if (!existsSync(aShot) || !existsSync(bShot)) throw new Error("the screenshots were not taken");

	a.send({ id: "del", type: "prompt", message: "/delete-session" });
	await until(() => a.notices.some((notice) => /new session is active/i.test(notice)), "the deletion notice", 30_000);

	if (!/1 photo in ~\/\.agent-browser\/shots/.test(a.lastConfirm ?? "")) throw new Error(`the dialog did not list the photo:\n${a.lastConfirm}`);
	if (existsSync(aShot)) throw new Error("session A's photo is still there");
	if (existsSync(join(shotsDir, "a-ui"))) throw new Error("session A's emptied folder is still there");
	if (!existsSync(bShot)) throw new Error("session B's photo was deleted");
	if (!existsSync(untracked)) throw new Error("a photo nobody recorded was deleted");
	if (!a.notices.some((notice) => /1 photo/.test(notice))) throw new Error(`no photo count in the notice: ${a.notices.join(" | ")}`);
	if (a.errors.length || b.errors.length) throw new Error(`extension errors: ${[...a.errors, ...b.errors].join(" | ")}`);
	console.log(
		`e2e ok: real bash screenshot recorded per session → /delete-session in A listed and removed A's photo (folder too) → B's photo and an untracked file stayed (left: ${readdirSync(shotsDir).sort().join(", ")})`,
	);
	exitCode = 0;
} catch (error) {
	console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
	for (const pi of [a, b].filter(Boolean)) console.error(`  ${pi.label} notices: ${pi.notices.join(" | ")}`);
} finally {
	a?.child.kill("SIGKILL");
	b?.child.kill("SIGKILL");
	server.close();
	rmSync(root, { recursive: true, force: true });
	process.exit(exitCode);
}
