/**
 * Screenshots a session made in `~/.agent-browser/shots`, so they can go with the session.
 *
 * Ownership is recorded when a photo is made, never guessed later: before each tool call the
 * shots folder is snapshotted, and after it every image that appeared or changed during the call
 * — and whose name the call itself mentions — is recorded for the session that ran it. One small
 * ledger file per session (`<ledgerDir>/<hash>.json`), so parallel sessions never write the
 * same file.
 *
 * A photo is deleted with a session only when
 *   - it is an image under the shots folder (a regular file, not a link out of it),
 *   - every session that recorded it is being deleted (a shared photo waits for its last owner),
 *   - and it is unchanged since it was last recorded (size and mtime): anything else may have
 *     written it since, so it is no longer provably the session's.
 * Files that were never recorded (made before this feature, or by another tool) are never touched.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { deleteSessionFile, type DeleteSessionFileOptions } from "./session-files.ts";

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

export interface ShotsLocations {
	/** The folder screenshots are saved to (`~/.agent-browser/shots`). */
	shotsDir: string;
	/** Where ownership is recorded (`<agent dir>/delete-session/shots`). */
	ledgerDir: string;
}

export function defaultShotsLocations(): ShotsLocations {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return {
		shotsDir: process.env.PI_DELETE_SESSION_SHOTS_DIR?.trim() || join(homedir(), ".agent-browser", "shots"),
		ledgerDir: join(agentDir, "delete-session", "shots"),
	};
}

export interface FileStamp {
	size: number;
	mtimeMs: number;
}

export type Snapshot = Map<string, FileStamp>;

/** Every image under the shots folder, by path. Links and unreadable entries are skipped. */
export function snapshotShots(shotsDir: string): Snapshot {
	const result: Snapshot = new Map();
	if (!existsSync(shotsDir)) return result;
	const walk = (dir: string, depth: number) => {
		if (depth > 6) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const path = join(dir, name);
			let stats;
			try {
				stats = lstatSync(path);
			} catch {
				continue;
			}
			if (stats.isSymbolicLink()) continue;
			if (stats.isDirectory()) walk(path, depth + 1);
			else if (stats.isFile() && IMAGE_EXTENSIONS.test(name)) result.set(path, { size: stats.size, mtimeMs: stats.mtimeMs });
		}
	};
	walk(shotsDir, 0);
	return result;
}

/** Images that appeared, or changed, between two snapshots. */
export function changedShots(before: Snapshot, after: Snapshot): string[] {
	const changed: string[] = [];
	for (const [path, stamp] of after) {
		const old = before.get(path);
		if (!old || old.size !== stamp.size || old.mtimeMs !== stamp.mtimeMs) changed.push(path);
	}
	return changed;
}

/**
 * Keep only the images the tool call itself names, so a photo another session happened to save
 * at the same moment is never claimed. Named means its path relative to the shots folder appears
 * in the call's input or output, or its file name and its folder name both do
 * (`M=~/.agent-browser/shots/app-login; agent-browser screenshot $M/shot.png`).
 */
export function namedByCall(paths: readonly string[], shotsDir: string, callText: string): string[] {
	return paths.filter((path) => {
		const rel = relative(shotsDir, path).split(sep).join("/");
		if (callText.includes(rel)) return true;
		const name = basename(path);
		if (!callText.includes(name)) return false;
		const folder = dirname(rel);
		return folder === "." || callText.includes(folder);
	});
}

// ---- ledger -------------------------------------------------------------------------------

interface LedgerFile {
	session: string;
	files: Record<string, FileStamp>;
}

function ledgerPathFor(ledgerDir: string, sessionPath: string): string {
	const id = createHash("sha256").update(sessionPath).digest("hex").slice(0, 32);
	return join(ledgerDir, `${id}.json`);
}

function readLedger(path: string): LedgerFile | undefined {
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<LedgerFile>;
		if (typeof data.session !== "string" || !data.files || typeof data.files !== "object") return undefined;
		return { session: data.session, files: data.files as Record<string, FileStamp> };
	} catch {
		return undefined;
	}
}

/** Record images a session's tool call made. Later records of the same file replace its stamp. */
export function recordShots(locations: ShotsLocations, sessionPath: string, paths: readonly string[]): void {
	if (paths.length === 0) return;
	const path = ledgerPathFor(locations.ledgerDir, sessionPath);
	const ledger = readLedger(path) ?? { session: sessionPath, files: {} };
	for (const file of paths) {
		try {
			const stats = statSync(file);
			ledger.files[file] = { size: stats.size, mtimeMs: stats.mtimeMs };
		} catch {
			// gone again before it could be recorded
		}
	}
	mkdirSync(locations.ledgerDir, { recursive: true });
	// Write then rename: a reader sees the old or the new ledger, never half of one.
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(ledger));
	renameSync(temporary, path);
}

function allLedgers(ledgerDir: string): { path: string; ledger: LedgerFile }[] {
	if (!existsSync(ledgerDir)) return [];
	const out: { path: string; ledger: LedgerFile }[] = [];
	for (const name of readdirSync(ledgerDir)) {
		if (!name.endsWith(".json")) continue;
		const path = join(ledgerDir, name);
		const ledger = readLedger(path);
		if (ledger) out.push({ path, ledger });
	}
	return out;
}

/** A session file being deleted, or a subagent session stored under one (`<session>/<runId>/run-N/…`). */
function coveredBy(owner: string, deleted: readonly string[]): boolean {
	return deleted.some((session) => owner === session || owner.startsWith(`${session.replace(/\.jsonl$/, "")}${sep}`));
}

export interface OwnedShots {
	/** Photos that go with the deleted sessions. */
	files: { path: string; size: number }[];
	bytes: number;
	/** Recorded by a deleted session, but also by a session that stays. */
	keptShared: number;
	/** Recorded by a deleted session, but changed since: no longer provably its own. */
	keptChanged: number;
}

/** The photos that belong only to these sessions and are still exactly as they recorded them. */
export function findOwnedShots(locations: ShotsLocations, deletedSessions: readonly string[]): OwnedShots {
	let shotsRoot: string;
	try {
		shotsRoot = realpathSync(locations.shotsDir);
	} catch {
		return { files: [], bytes: 0, keptShared: 0, keptChanged: 0 };
	}
	const owners = new Map<string, { sessions: string[]; latest: FileStamp }>();
	for (const { ledger } of allLedgers(locations.ledgerDir)) {
		for (const [file, stamp] of Object.entries(ledger.files)) {
			const entry = owners.get(file) ?? { sessions: [], latest: stamp };
			entry.sessions.push(ledger.session);
			if (stamp.mtimeMs >= entry.latest.mtimeMs) entry.latest = stamp;
			owners.set(file, entry);
		}
	}
	const result: OwnedShots = { files: [], bytes: 0, keptShared: 0, keptChanged: 0 };
	for (const [file, { sessions, latest }] of owners) {
		if (!sessions.some((owner) => coveredBy(owner, deletedSessions))) continue;
		if (!sessions.every((owner) => coveredBy(owner, deletedSessions))) {
			result.keptShared++;
			continue;
		}
		let stats;
		try {
			stats = lstatSync(file);
		} catch {
			continue; // already gone
		}
		if (!stats.isFile() || !IMAGE_EXTENSIONS.test(file)) continue;
		// The real location must be inside the shots folder, so a link or a renamed path never
		// points a deletion somewhere else.
		let real: string;
		try {
			real = realpathSync(file);
		} catch {
			continue;
		}
		if (!real.startsWith(shotsRoot + sep)) continue;
		if (stats.size !== latest.size || stats.mtimeMs !== latest.mtimeMs) {
			result.keptChanged++;
			continue;
		}
		result.files.push({ path: file, size: stats.size });
		result.bytes += stats.size;
	}
	result.files.sort((a, b) => a.path.localeCompare(b.path));
	return result;
}

export interface ShotsDeleteResult {
	removed: number;
	failures: string[];
}

/**
 * Move the photos to the trash, drop the deleted sessions' ledgers, and remove folders under
 * the shots folder that only held those photos. The shots folder itself always stays.
 */
export function deleteOwnedShots(
	locations: ShotsLocations,
	deletedSessions: readonly string[],
	owned: OwnedShots,
	options: DeleteSessionFileOptions = {},
): ShotsDeleteResult {
	const failures: string[] = [];
	let removed = 0;
	for (const { path } of owned.files) {
		const result = deleteSessionFile(path, options);
		if (result.ok) removed++;
		else failures.push(`${basename(path)}: ${result.error}`);
	}
	for (const folder of new Set(owned.files.map((file) => dirname(file.path)))) removeEmptyFolders(folder, locations.shotsDir);
	for (const { path, ledger } of allLedgers(locations.ledgerDir)) {
		if (!coveredBy(ledger.session, deletedSessions)) continue;
		try {
			unlinkSync(path);
		} catch {
			// already gone
		}
	}
	return { removed, failures };
}

function removeEmptyFolders(folder: string, shotsDir: string): void {
	let current = folder;
	while (current.startsWith(shotsDir + sep) && current !== shotsDir) {
		try {
			if (readdirSync(current).length > 0) return;
			rmdirSync(current);
		} catch {
			return;
		}
		current = dirname(current);
	}
}

/** Sessions with a ledger whose session file no longer exists, for `/delete-session orphans`. */
export function orphanedShotOwners(locations: ShotsLocations): string[] {
	return allLedgers(locations.ledgerDir)
		.map(({ ledger }) => ledger.session)
		.filter((session) => !existsSync(session));
}
