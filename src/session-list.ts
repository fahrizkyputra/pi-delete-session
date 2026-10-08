/**
 * Real session listing, backed by Pi's own SessionManager so the on-disk layout
 * and naming rules never drift from the built-in `/resume` picker.
 */

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface ListSessionsOptions {
	scope: "project" | "all";
	cwd: string;
	sessionDir: string;
	onProgress?: (loaded: number, total: number) => void;
}

export async function listSessions(options: ListSessionsOptions): Promise<SessionInfo[]> {
	const progress = options.onProgress
		? (loaded: number, total: number) => options.onProgress?.(loaded, total)
		: undefined;

	if (options.scope === "all") {
		return await SessionManager.listAll(progress);
	}
	return await SessionManager.list(options.cwd, options.sessionDir, progress);
}
