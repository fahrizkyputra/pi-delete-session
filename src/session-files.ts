/**
 * Filesystem and formatting helpers for session deletion.
 *
 * This module intentionally depends on nothing but Node built-ins (plus erased
 * type imports) so it can be unit tested without Pi installed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export type DeleteMethod = "trash" | "unlink";

export interface DeleteSessionResult {
	ok: boolean;
	method: DeleteMethod;
	error?: string;
}

export interface DeleteSessionFileOptions {
	/**
	 * Prefer the `trash` CLI when it is available (default true). Set to false to
	 * delete immediately with unlink.
	 */
	useTrash?: boolean;
}

/**
 * Delete one session file. Tries `trash` first so the file can be recovered from
 * the OS trash, then falls back to unlink. Same behavior as Pi's built-in
 * `/resume` picker.
 */
export function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): DeleteSessionResult {
	if (!existsSync(sessionPath)) {
		return { ok: true, method: "unlink" };
	}

	const useTrash = options.useTrash ?? true;
	let trashError: string | undefined;

	if (useTrash) {
		const args = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
		const trashed = spawnSync("trash", args, { encoding: "utf-8" });
		if (trashed.status === 0 || !existsSync(sessionPath)) {
			return { ok: true, method: "trash" };
		}
		const stderr = trashed.stderr?.trim();
		trashError = trashed.error?.message ?? (stderr && stderr.length > 0 ? stderr : undefined);
	}

	try {
		unlinkSync(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			method: "unlink",
			error: trashError ? `${message} (trash: ${trashError})` : message,
		};
	}
}

export function sessionFileSize(sessionPath: string): number | undefined {
	try {
		return statSync(sessionPath).size;
	} catch {
		return undefined;
	}
}

/** Resolve symlinks when possible so two paths to one file compare equal. */
export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function isSamePath(a: string, b: string): boolean {
	return canonicalPath(a) === canonicalPath(b);
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

export function formatAge(date: Date, now: Date = new Date()): string {
	const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.round(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.round(months / 12)}y ago`;
}

/** Display name for a session: user-set name, else the first message, else a placeholder. */
export function sessionTitle(session: SessionInfo, maxLength = 80): string {
	const raw = session.name?.trim() || session.firstMessage?.trim() || "(untitled)";
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function describeSession(session: SessionInfo, options: { showCwd?: boolean } = {}): string {
	const parts = [sessionTitle(session), `${formatAge(session.modified)}`, `${session.messageCount} msg`];
	if (session.name && session.firstMessage) {
		parts.splice(1, 0, `"${session.firstMessage.replace(/\s+/g, " ").trim().slice(0, 60)}"`);
	}
	if (options.showCwd && session.cwd) parts.push(session.cwd);
	return parts.join(" · ");
}

/** Multi-line list used in the confirmation dialog. */
export function summarizeSessions(sessions: SessionInfo[], limit = 12): string {
	const shown = sessions.slice(0, limit).map((session) => `• ${describeSession(session)}`);
	if (sessions.length > limit) shown.push(`… and ${sessions.length - limit} more`);
	const totalBytes = sessions.reduce((sum, session) => sum + (sessionFileSize(session.path) ?? 0), 0);
	shown.push("");
	shown.push(`${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)} on disk`);
	shown.push("This cannot be undone. Files go to the OS trash when the `trash` CLI is available.");
	return shown.join("\n");
}

/** Case-insensitive match on session name, first message, or any message text. */
export function filterSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return sessions;
	return sessions.filter((session) => {
		const haystack = [session.name, session.firstMessage, session.allMessagesText, session.cwd, session.id]
			.filter((value): value is string => typeof value === "string")
			.join("\n")
			.toLowerCase();
		return haystack.includes(needle);
	});
}
