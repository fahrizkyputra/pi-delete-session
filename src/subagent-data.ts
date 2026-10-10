/**
 * Subagent data that belongs to a session.
 *
 * pi-subagents stores a child run's data next to the parent session file:
 *
 *   <dir>/<session>.jsonl                                  the parent session
 *   <dir>/<session>/<runId>/run-N/session.jsonl            child sessions
 *   <dir>/subagent-artifacts/<runId>_<agent>_<n>_*.{md,json,jsonl}
 *                                                          prompts, output, transcripts
 *
 * The artifacts folder is shared by every session of the project, so only the
 * files whose run id appears under this session's folder belong to it.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deleteSessionFile, type DeleteSessionFileOptions } from "./session-files.ts";

export const ARTIFACTS_DIR_NAME = "subagent-artifacts";

export interface SubagentData {
	/** `<dir>/<session>/`, when it exists. */
	sessionDir?: string;
	/** Run ids found under the session folder. */
	runIds: string[];
	/** Artifact files in the shared folder that belong to those runs. */
	artifacts: string[];
	/** Total bytes of everything above. */
	bytes: number;
}

export function subagentDirFor(sessionPath: string): string {
	return join(dirname(sessionPath), basename(sessionPath, ".jsonl"));
}

function sizeOf(path: string): number {
	try {
		const stats = statSync(path);
		if (!stats.isDirectory()) return stats.size;
		let total = 0;
		for (const entry of readdirSync(path)) total += sizeOf(join(path, entry));
		return total;
	} catch {
		return 0;
	}
}

function artifactsFor(dir: string, runIds: ReadonlySet<string>): string[] {
	const folder = join(dir, ARTIFACTS_DIR_NAME);
	if (runIds.size === 0 || !existsSync(folder)) return [];
	try {
		return readdirSync(folder)
			.filter((file) => runIds.has(file.split("_")[0] ?? ""))
			.map((file) => join(folder, file));
	} catch {
		return [];
	}
}

/** Everything pi-subagents stored for this session. Empty when it never ran a subagent. */
export function findSubagentData(sessionPath: string): SubagentData {
	const sessionDir = subagentDirFor(sessionPath);
	if (!existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) {
		return { runIds: [], artifacts: [], bytes: 0 };
	}
	let runIds: string[] = [];
	try {
		runIds = readdirSync(sessionDir).filter((entry) => {
			try {
				return statSync(join(sessionDir, entry)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		runIds = [];
	}
	const artifacts = artifactsFor(dirname(sessionPath), new Set(runIds));
	const bytes = sizeOf(sessionDir) + artifacts.reduce((sum, file) => sum + sizeOf(file), 0);
	return { sessionDir, runIds, artifacts, bytes };
}

export function hasSubagentData(data: SubagentData): boolean {
	return data.sessionDir !== undefined || data.artifacts.length > 0;
}

export interface SubagentDeleteResult {
	ok: boolean;
	removedRuns: number;
	failures: string[];
}

/** Move a session's subagent data to the trash (or unlink it). */
export function deleteSubagentData(data: SubagentData, options: DeleteSessionFileOptions = {}): SubagentDeleteResult {
	const failures: string[] = [];
	for (const file of data.artifacts) {
		const result = deleteSessionFile(file, options);
		if (!result.ok) failures.push(`${basename(file)}: ${result.error}`);
	}
	if (data.sessionDir) {
		const result = deleteSessionFile(data.sessionDir, options);
		if (!result.ok) failures.push(`${basename(data.sessionDir)}/: ${result.error}`);
	}
	return { ok: failures.length === 0, removedRuns: data.runIds.length, failures };
}

export interface OrphanedSubagentData extends SubagentData {
	/** The parent session file that no longer exists. */
	missingSession: string;
	sessionDir: string;
}

/**
 * Subagent folders whose parent session file is gone, typically sessions deleted
 * before subagent cleanup existed. Scans one session directory (a project) or
 * every project under the sessions root.
 */
export function findOrphanedSubagentData(directories: readonly string[]): OrphanedSubagentData[] {
	const orphans: OrphanedSubagentData[] = [];
	for (const directory of directories) {
		let entries: string[];
		try {
			entries = readdirSync(directory);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry === ARTIFACTS_DIR_NAME) continue;
			const candidate = join(directory, entry);
			try {
				if (!statSync(candidate).isDirectory()) continue;
			} catch {
				continue;
			}
			const sessionPath = `${candidate}.jsonl`;
			if (existsSync(sessionPath)) continue;
			// Only folders that look like pi-subagents run folders: `<runId>/run-N/`.
			const runIds = readdirSync(candidate).filter((run) => {
				try {
					const runDir = join(candidate, run);
					return statSync(runDir).isDirectory() && readdirSync(runDir).some((child) => /^run-\d+$/.test(child));
				} catch {
					return false;
				}
			});
			if (runIds.length === 0) continue;
			const data = findSubagentData(sessionPath);
			orphans.push({ ...data, sessionDir: candidate, missingSession: sessionPath, runIds });
		}
	}
	return orphans;
}
