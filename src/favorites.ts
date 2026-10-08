/**
 * The favorite-marker contract, shared with `pi-session-favorites`.
 *
 * A favorite session carries "★ " at the front of its display name. Both
 * packages read this prefix; if it ever changes, both need a release.
 */

import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export const FAVORITE_MARKER = "★";

export function isFavoriteName(name: string | undefined | null): boolean {
	if (typeof name !== "string") return false;
	return name.trimStart().startsWith(FAVORITE_MARKER);
}

export function isFavoriteSession(session: SessionInfo): boolean {
	return isFavoriteName(session.name);
}

export function countFavorites(sessions: readonly SessionInfo[]): number {
	return sessions.filter(isFavoriteSession).length;
}
