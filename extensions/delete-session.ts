/**
 * pi-delete-session — `/delete-session` for the Pi coding agent.
 *
 * Deletes the active session (starting a fresh one in its place), or opens a
 * multi-select checklist of saved sessions. Files go to the OS trash when the
 * `trash` CLI is available.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type DeleteSessionHost, runDeleteSessionCommand } from "../src/handlers.ts";
import { pickSessionsChecklist } from "../src/pick-sessions.ts";
import { listSessions } from "../src/session-list.ts";

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
		listSessions: async (scope) =>
			await listSessions({
				scope,
				cwd: ctx.cwd,
				sessionDir: ctx.sessionManager.getSessionDir(),
				onProgress: (loaded, total) => ctx.ui.setStatus("delete-session", `Loading sessions ${loaded}/${total}`),
			}),
		startNewSession: async (after) => {
			const result = await ctx.newSession({
				withSession: async (freshCtx) => {
					await after(hostFromContext(freshCtx));
				},
			});
			ctx.ui.setStatus("delete-session", undefined);
			return { cancelled: result.cancelled };
		},
		pickSessions: async (sessions, options) => await pickSessionsChecklist(ctx, sessions, options),
	};
}

export default function deleteSessionExtension(pi: ExtensionAPI) {
	pi.registerCommand("delete-session", {
		description: "Delete the current session, or pick saved sessions to delete",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "list", label: "list — pick saved sessions to delete" },
				{ value: "list --all", label: "list --all — pick from every project" },
				{ value: "help", label: "help — usage" },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			try {
				await runDeleteSessionCommand(hostFromContext(ctx), args);
			} finally {
				ctx.ui.setStatus("delete-session", undefined);
			}
		},
	});
}
