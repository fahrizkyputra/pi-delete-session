/**
 * Command logic for /delete-session.
 *
 * Everything here works against an injected {@link DeleteSessionHost}, so the
 * behavior is testable without loading Pi or a terminal.
 */

import { basename } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { countFavorites, FAVORITE_MARKER, isFavoriteName, isFavoriteSession } from "./favorites.ts";
import {
	deleteSubagentData,
	findOrphanedSubagentData,
	findSubagentData,
	hasSubagentData,
	type SubagentData,
} from "./subagent-data.ts";
import { deleteOwnedShots, findOwnedShots, orphanedShotOwners, type OwnedShots, type ShotsLocations } from "./shots.ts";
import {
	deleteSessionFile,
	filterSessions,
	formatBytes,
	formatAge,
	isSamePath,
	sessionFileSize,
	sessionTitle,
	summarizeSessions,
} from "./session-files.ts";

export type SessionScope = "project" | "all";

export interface DeleteSessionUI {
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
}

export interface DeleteSessionHost {
	/** Pi run mode. Only "tui" gets the interactive multi-select checklist. */
	mode: "tui" | "rpc" | "json" | "print";
	/** Whether dialogs are available at all. */
	hasUI: boolean;
	ui: DeleteSessionUI;
	/** Path of the active session file, or undefined when it is not on disk yet. */
	currentSessionPath: string | undefined;
	/** Number of entries in the active session. */
	currentSessionEntryCount: number;
	/** Display name of the active session, marker included. */
	currentSessionName: string | undefined;
	listSessions(scope: SessionScope): Promise<SessionInfo[]>;
	/** Session directories to scan for orphaned subagent data: this project, or every project. */
	sessionDirectories(scope: SessionScope): string[];
	/**
	 * Start a replacement session and run `after` against a fresh host bound to
	 * it. Used before deleting the active session so Pi stops writing to the file.
	 */
	startNewSession(after: (fresh: DeleteSessionHost) => Promise<void>): Promise<{ cancelled: boolean }>;
	/** Where screenshots and their ownership records live; undefined disables photo cleanup. */
	shots?: ShotsLocations;
	/** Interactive multi-select picker. Only called in TUI mode. */
	pickSessions(
		sessions: SessionInfo[],
		options: { title: string; currentSessionPath?: string; initialQuery?: string },
	): Promise<string[] | undefined>;
}

export const HELP_TEXT = [
	"/delete-session — delete the current session",
	"/delete-session list — pick saved sessions to delete (type to search)",
	"/delete-session list --all — pick from every project",
	"/delete-session <query> — open the list with the search pre-filled",
	"/delete-session orphans [--all] — clean subagent data whose session is already gone",
	"",
	"In the list: tab switches between search and selection, space toggles a",
	"session, `a` toggles everything the search shows, enter deletes.",
	"",
	"Sessions marked ★ (favorites from pi-session-favorites) ask for a second",
	"confirmation before they are removed.",
	"",
	"Subagent sessions and artifacts that belong to a deleted session are removed",
	"with it (pi-subagents stores them next to the session file).",
	"",
	"Screenshots the session saved in ~/.agent-browser/shots go with it too, but only",
	"the ones recorded as made by that session, unchanged since, and not also made by",
	"a session you keep. Older photos and anything else in that folder are never touched.",
	"",
	"Deletion asks for confirmation first and moves files to the OS trash when",
	"the `trash` CLI is available. A new session starts when the active session",
	"is deleted.",
].join("\n");

export async function runDeleteSessionCommand(host: DeleteSessionHost, rawArgs: string): Promise<void> {
	const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
	const head = tokens[0]?.toLowerCase();

	if (head === "help" || head === "--help" || head === "-h") {
		host.ui.notify(HELP_TEXT, "info");
		return;
	}

	if (head === "list" || head === "--list" || head === "-l" || head === "pick") {
		const scope: SessionScope = tokens.includes("--all") || tokens.includes("-a") ? "all" : "project";
		const query = tokens
			.slice(1)
			.filter((token) => !token.startsWith("-"))
			.join(" ")
			.trim();
		await deleteSessionsWithPicker(host, { scope, query: query.length > 0 ? query : undefined });
		return;
	}

	if (head === "orphans" || head === "--orphans") {
		const scope: SessionScope = tokens.includes("--all") || tokens.includes("-a") ? "all" : "project";
		await deleteOrphanedSubagentData(host, scope);
		return;
	}

	// Any other argument is treated as a search query for the picker.
	if (tokens.length > 0) {
		await deleteSessionsWithPicker(host, { scope: "project", query: rawArgs.trim() });
		return;
	}

	await deleteCurrentSession(host);
}

export async function deleteCurrentSession(host: DeleteSessionHost): Promise<void> {
	const sessionPath = host.currentSessionPath;
	if (!sessionPath) {
		host.ui.notify("This session is not saved to disk yet, so there is nothing to delete.", "info");
		return;
	}
	if (!host.hasUI) {
		host.ui.notify("/delete-session needs an interactive confirmation. Run it in the TUI.", "warning");
		return;
	}

	const size = sessionFileSize(sessionPath);
	const subagents = findSubagentData(sessionPath);
	const shots = host.shots ? findOwnedShots(host.shots, [sessionPath]) : undefined;
	const detail = [
		basename(sessionPath),
		`${host.currentSessionEntryCount} entries${size === undefined ? "" : ` · ${formatBytes(size)}`}`,
		...(hasSubagentData(subagents) ? [describeSubagentData(subagents)] : []),
		...describeShots(shots),
		sessionPath,
		"",
		"A new session starts right away.",
		"Deleted files go to the OS trash when the `trash` CLI is available.",
	].join("\n");

	const confirmed = await host.ui.confirm("Delete this session?", detail);
	if (!confirmed) {
		host.ui.notify("Cancelled. Session kept.", "info");
		return;
	}

	if (isFavoriteName(host.currentSessionName)) {
		const favoritesConfirmed = await host.ui.confirm(
			"This session is a favorite (★)",
			[
				host.currentSessionName ?? FAVORITE_MARKER,
				"",
				"Favorites are the sessions you marked to come back to. Deleting it removes the ★ too.",
			].join("\n"),
		);
		if (!favoritesConfirmed) {
			host.ui.notify("Cancelled — the favorite is kept.", "info");
			return;
		}
	}

	const result = await host.startNewSession(async (fresh) => {
		const deletion = deleteSessionFile(sessionPath);
		if (deletion.ok) {
			const how = deletion.method === "trash" ? "moved to trash" : "deleted";
			const extra = hasSubagentData(subagents) ? subagentSuffix(deleteSubagentData(subagents)) : "";
			const photos = host.shots && shots ? shotsSuffix(deleteOwnedShots(host.shots, [sessionPath], shots)) : "";
			fresh.ui.notify(`Session ${how}${extra}${photos}. A new session is active.`, "info");
		} else {
			fresh.ui.notify(`A new session is active, but deleting the old file failed: ${deletion.error}`, "error");
		}
	});

	if (result.cancelled) {
		host.ui.notify("Session replacement was cancelled. Nothing was deleted.", "warning");
	}
}

export interface PickerOptions {
	scope: SessionScope;
	query?: string;
}

export async function deleteSessionsWithPicker(host: DeleteSessionHost, options: PickerOptions): Promise<void> {
	if (!host.hasUI) {
		host.ui.notify("/delete-session list needs an interactive UI. Run it in the TUI.", "warning");
		return;
	}

	const sessions = await host.listSessions(options.scope);
	const query = options.query?.trim();

	if (sessions.length === 0) {
		host.ui.notify("No saved sessions found.", "info");
		return;
	}

	// In the TUI the checklist filters live, so it gets every candidate; other
	// modes narrow the list up front because their dialogs cannot search.
	const searchable = host.mode === "tui" ? sessions : query ? filterSessions(sessions, query) : sessions;
	if (searchable.length === 0) {
		host.ui.notify(`No sessions match "${query}".`, "info");
		return;
	}

	const picked =
		host.mode === "tui"
			? await host.pickSessions(searchable, {
					title:
						options.scope === "all" ? "All saved sessions" : "Sessions in this project",
					currentSessionPath: host.currentSessionPath,
					initialQuery: query,
				})
			: await pickOneByOne(host, searchable);

	if (!picked || picked.length === 0) {
		host.ui.notify("Nothing selected. No sessions deleted.", "info");
		return;
	}

	const selected = sessions.filter((session) => picked.some((path) => isSamePath(path, session.path)));
	if (selected.length === 0) {
		host.ui.notify("Nothing selected. No sessions deleted.", "info");
		return;
	}

	const subagentData = new Map(selected.map((session) => [session.path, findSubagentData(session.path)] as const));
	const withSubagents = [...subagentData.values()].filter(hasSubagentData);
	const subagentLine =
		withSubagents.length > 0
			? `\n${withSubagents.reduce((sum, data) => sum + data.runIds.length, 0)} subagent run(s) in ${withSubagents.length} of these sessions are removed too (${formatBytes(withSubagents.reduce((sum, data) => sum + data.bytes, 0))}).`
			: "";
	const shots = host.shots ? findOwnedShots(host.shots, selected.map((session) => session.path)) : undefined;
	const shotsLines = describeShots(shots);
	const confirmed = await host.ui.confirm(
		`Delete ${selected.length} session${selected.length === 1 ? "" : "s"}?`,
		`${summarizeSessions(selected)}${subagentLine}${shotsLines.length > 0 ? `\n${shotsLines.join("\n")}` : ""}`,
	);
	if (!confirmed) {
		host.ui.notify("Cancelled. No sessions deleted.", "info");
		return;
	}

	const favoriteCount = countFavorites(selected);
	if (favoriteCount > 0) {
		const favoritesConfirmed = await host.ui.confirm(
			`${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"} selected (★)`,
			[
				summarizeSessions(selected.filter(isFavoriteSession)),
				"",
				"Deleting these removes the markers you set to come back to.",
			].join("\n"),
		);
		if (!favoritesConfirmed) {
			host.ui.notify("Cancelled — favorites kept, nothing deleted.", "info");
			return;
		}
	}

	const currentPath = host.currentSessionPath;
	const includesCurrent =
		currentPath !== undefined && selected.some((session) => isSamePath(session.path, currentPath));

	const runDeletes = (): { deleted: number; failures: string[]; photos: string } => {
		let deleted = 0;
		const failures: string[] = [];
		const deletedPaths: string[] = [];
		for (const session of selected) {
			const result = deleteSessionFile(session.path);
			if (!result.ok) {
				failures.push(`${sessionTitle(session, 40)}: ${result.error}`);
				continue;
			}
			deleted++;
			deletedPaths.push(session.path);
			const data = subagentData.get(session.path);
			if (data && hasSubagentData(data)) {
				const removed = deleteSubagentData(data);
				if (!removed.ok) failures.push(`${sessionTitle(session, 40)} subagents: ${removed.failures.join(", ")}`);
			}
		}
		// Only photos of sessions that really went: a session whose file could not be removed keeps them.
		let photos = "";
		if (host.shots && shots && deletedPaths.length > 0) {
			const owned = deletedPaths.length === selected.length ? shots : findOwnedShots(host.shots, deletedPaths);
			photos = shotsSuffix(deleteOwnedShots(host.shots, deletedPaths, owned));
		}
		return { deleted, failures, photos };
	};

	if (includesCurrent) {
		const result = await host.startNewSession(async (fresh) => {
			const { deleted, failures, photos } = runDeletes();
			reportDeletions(fresh.ui, deleted, failures, true, photos);
		});
		if (result.cancelled) {
			host.ui.notify("Session replacement was cancelled. Nothing was deleted.", "warning");
		}
		return;
	}

	const { deleted, failures, photos } = runDeletes();
	reportDeletions(host.ui, deleted, failures, false, photos);
}

/** Non-TUI fallback: one session per dialog, repeat until the user stops. */
async function pickOneByOne(host: DeleteSessionHost, sessions: SessionInfo[]): Promise<string[]> {
	const remaining = [...sessions];
	const picked: string[] = [];
	const doneLabel = "Done — delete the selected sessions";

	while (remaining.length > 0) {
		const labels = remaining.map(
			(session) => `${sessionTitle(session, 60)} · ${formatAge(session.modified)} · ${session.messageCount} msg`,
		);
		const choice = await host.ui.select("Add a session to the delete list", [...labels, doneLabel]);
		if (!choice || choice === doneLabel) break;
		const index = labels.indexOf(choice);
		if (index < 0) continue;
		const pickedSession = remaining[index];
		if (!pickedSession) continue;
		picked.push(pickedSession.path);
		remaining.splice(index, 1);
	}

	return picked;
}

function reportDeletions(
	ui: DeleteSessionUI,
	deleted: number,
	failures: string[],
	includesCurrent: boolean,
	photos = "",
): void {
	const parts: string[] = [];
	if (deleted > 0) {
		const suffix = includesCurrent ? " (a new session is active)" : "";
		parts.push(`${deleted} session${deleted === 1 ? "" : "s"} deleted${photos}${suffix}`);
	} else {
		parts.push("No sessions deleted");
	}
	if (failures.length > 0) parts.push(`Failed: ${failures.join("; ")}`);

	const type = failures.length > 0 ? (deleted === 0 ? "error" : "warning") : "info";
	ui.notify(parts.join(". "), type);
}

function describeSubagentData(data: SubagentData): string {
	const runs = data.runIds.length;
	return `+ ${runs} subagent run${runs === 1 ? "" : "s"} (${formatBytes(data.bytes)}) — removed with the session`;
}

function describeShots(shots: OwnedShots | undefined): string[] {
	if (!shots) return [];
	const lines: string[] = [];
	const count = shots.files.length;
	if (count > 0) lines.push(`+ ${count} photo${count === 1 ? "" : "s"} in ~/.agent-browser/shots (${formatBytes(shots.bytes)}) — made by this session, removed with it`);
	const kept = shots.keptShared + shots.keptChanged;
	if (kept > 0) {
		const why = [
			shots.keptShared > 0 ? `${shots.keptShared} also made by a session you keep` : "",
			shots.keptChanged > 0 ? `${shots.keptChanged} changed since` : "",
		].filter(Boolean);
		lines.push(`  ${kept} other photo${kept === 1 ? "" : "s"} stay (${why.join(", ")})`);
	}
	return lines;
}

function shotsSuffix(result: { removed: number; failures: string[] }): string {
	if (result.failures.length > 0) return `, but ${result.failures.length} photo(s) could not be removed (${result.failures.join("; ")})`;
	return result.removed > 0 ? `, ${result.removed} photo${result.removed === 1 ? "" : "s"}` : "";
}

function subagentSuffix(result: { ok: boolean; removedRuns: number; failures: string[] }): string {
	if (!result.ok) return `, but some subagent data could not be removed (${result.failures.join("; ")})`;
	return result.removedRuns > 0 ? ` with ${result.removedRuns} subagent run${result.removedRuns === 1 ? "" : "s"}` : "";
}

/** Subagent folders left behind by sessions deleted before this cleanup existed. */
export async function deleteOrphanedSubagentData(host: DeleteSessionHost, scope: SessionScope): Promise<void> {
	if (!host.hasUI) {
		host.ui.notify("/delete-session orphans needs an interactive confirmation. Run it in the TUI.", "warning");
		return;
	}
	const orphans = findOrphanedSubagentData(host.sessionDirectories(scope));
	// Photos recorded by sessions whose file is already gone (deleted with another tool, or
	// before this cleanup ran). Scoped like the subagent data: this project, or every project.
	const directories = host.sessionDirectories(scope);
	const goneOwners = host.shots
		? orphanedShotOwners(host.shots).filter((owner) => scope === "all" || directories.some((dir) => owner.startsWith(dir)))
		: [];
	const orphanShots = host.shots && goneOwners.length > 0 ? findOwnedShots(host.shots, goneOwners) : undefined;
	if (orphans.length === 0 && !orphanShots?.files.length) {
		host.ui.notify("No orphaned subagent data or photos found.", "info");
		return;
	}
	const runs = orphans.reduce((sum, orphan) => sum + orphan.runIds.length, 0);
	const bytes = orphans.reduce((sum, orphan) => sum + orphan.bytes, 0);
	const lines = orphans.slice(0, 10).map((orphan) => `• ${basename(orphan.missingSession)} — ${orphan.runIds.length} run(s), ${formatBytes(orphan.bytes)}`);
	if (orphans.length > 10) lines.push(`… and ${orphans.length - 10} more`);
	const confirmed = await host.ui.confirm(
		orphans.length > 0
			? `Remove subagent data of ${orphans.length} deleted session${orphans.length === 1 ? "" : "s"}?`
			: "Remove photos of deleted sessions?",
		[
			...lines,
			...(orphans.length > 0 ? ["", `${runs} subagent run(s), ${formatBytes(bytes)}. Their parent sessions no longer exist.`] : []),
			...describeShots(orphanShots),
			"Files go to the OS trash when the `trash` CLI is available.",
		].join("\n"),
	);
	if (!confirmed) {
		host.ui.notify("Cancelled. Nothing removed.", "info");
		return;
	}
	const failures: string[] = [];
	for (const orphan of orphans) {
		const result = deleteSubagentData(orphan);
		if (!result.ok) failures.push(...result.failures);
	}
	let photos = "";
	if (host.shots && orphanShots) {
		const result = deleteOwnedShots(host.shots, goneOwners, orphanShots);
		failures.push(...result.failures);
		photos = result.removed > 0 ? `, ${result.removed} photo${result.removed === 1 ? "" : "s"}` : "";
	}
	host.ui.notify(
		failures.length === 0
			? `Removed subagent data of ${orphans.length} deleted session${orphans.length === 1 ? "" : "s"} (${runs} runs, ${formatBytes(bytes)})${photos}.`
			: `Removed with errors: ${failures.join("; ")}`,
		failures.length === 0 ? "info" : "warning",
	);
}
