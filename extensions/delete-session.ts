/**
 * pi-delete-session — `/delete-session` for the Pi coding agent.
 *
 * Deletes the active session (starting a fresh one in its place), or opens a
 * multi-select checklist of saved sessions. Files go to the OS trash when the
 * `trash` CLI is available.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type DeleteSessionHost, runDeleteSessionCommand } from "../src/handlers.ts";
import { pickSessionsChecklist } from "../src/pick-sessions.ts";
import { listSessions } from "../src/session-list.ts";
import { type Snapshot, changedShots, defaultShotsLocations, namedByCall, recordShots, snapshotShots } from "../src/shots.ts";

const STATUS_KEY = "delete-session";

function clearStatus(ctx: ExtensionCommandContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

/**
 * Wrap a command context as a host.
 *
 * Everything the host does runs against the ctx it was built from. After
 * `newSession()` that ctx is stale, so any post-replacement work must go
 * through the host built from the ctx that `withSession` hands back.
 */
function hostFromContext(ctx: ExtensionCommandContext): DeleteSessionHost {
	return {
		mode: ctx.mode,
		hasUI: ctx.hasUI,
		ui: {
			confirm: (title, message) => ctx.ui.confirm(title, message),
			notify: (message, type) => ctx.ui.notify(message, type),
			select: (title, options) => ctx.ui.select(title, options),
		},
		currentSessionPath: ctx.sessionManager.getSessionFile(),
		currentSessionEntryCount: ctx.sessionManager.getEntries().length,
		currentSessionName: ctx.sessionManager.getSessionName(),
		sessionDirectories: (scope) => {
			const projectDir = ctx.sessionManager.getSessionDir();
			if (scope === "project") return [projectDir];
			const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
			const root = join(agentDir, "sessions");
			const candidates = new Set<string>([projectDir]);
			for (const base of [root, dirname(projectDir)]) {
				if (!existsSync(base)) continue;
				for (const entry of readdirSync(base)) {
					const path = join(base, entry);
					try {
						if (statSync(path).isDirectory()) candidates.add(path);
					} catch {
						// unreadable entries are skipped
					}
				}
			}
			return [...candidates];
		},
		listSessions: async (scope) => {
			try {
				return await listSessions({
					scope,
					cwd: ctx.cwd,
					sessionDir: ctx.sessionManager.getSessionDir(),
					onProgress: (loaded, total) => ctx.ui.setStatus(STATUS_KEY, `Loading sessions ${loaded}/${total}`),
				});
			} finally {
				clearStatus(ctx);
			}
		},
		startNewSession: async (after) => {
			const result = await ctx.newSession({
				withSession: async (freshCtx) => {
					clearStatus(freshCtx);
					await after(hostFromContext(freshCtx));
				},
			});
			// Cancelled means no replacement happened, so this ctx is still live.
			if (result.cancelled) clearStatus(ctx);
			return { cancelled: result.cancelled };
		},
		pickSessions: async (sessions, options) => await pickSessionsChecklist(ctx, sessions, options),
		shots: defaultShotsLocations(),
	};
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text ?? "") : "")).join("\n");
	return "";
}

export default function deleteSessionExtension(pi: ExtensionAPI) {
	// Record which session made each screenshot: the shots folder before a tool call, and the
	// images that appeared or changed by its end, when the call itself names them.
	const shots = defaultShotsLocations();
	const before = new Map<string, Snapshot>();

	pi.on?.("tool_call", (event) => {
		try {
			before.set(event.toolCallId, snapshotShots(shots.shotsDir));
		} catch {
			// recording is best effort; it must never get in the way of a tool
		}
		return undefined;
	});

	pi.on?.("tool_result", (event, ctx) => {
		const snapshot = before.get(event.toolCallId);
		before.delete(event.toolCallId);
		if (!snapshot) return undefined;
		try {
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (!sessionPath) return undefined;
			const changed = changedShots(snapshot, snapshotShots(shots.shotsDir));
			if (changed.length === 0) return undefined;
			const callText = `${JSON.stringify(event.input ?? {})}\n${textOf(event.content)}`;
			recordShots(shots, sessionPath, namedByCall(changed, shots.shotsDir, callText));
		} catch {
			// best effort, see above
		}
		return undefined;
	});

	pi.on?.("session_shutdown", () => {
		before.clear();
	});

	pi.registerCommand("delete-session", {
		description: "Delete the current session, or pick saved sessions to delete",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "list", label: "list — pick saved sessions to delete" },
				{ value: "list --all", label: "list --all — pick from every project" },
				{ value: "orphans", label: "orphans — clean subagent data left by deleted sessions" },
				{ value: "orphans --all", label: "orphans --all — same, across every project" },
				{ value: "help", label: "help — usage" },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			// Do not add cleanup that runs after runDeleteSessionCommand: deleting the
			// active session replaces the context and makes this ctx stale.
			await runDeleteSessionCommand(hostFromContext(ctx), args);
		},
	});
}
