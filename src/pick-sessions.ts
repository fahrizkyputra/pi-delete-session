/**
 * Interactive multi-select checklist for choosing sessions to delete.
 * TUI only; other modes fall back to one-by-one dialogs in handlers.ts.
 */

import type { ExtensionCommandContext, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatAge, isSamePath, sessionTitle } from "./session-files.ts";

export interface PickSessionsOptions {
	title: string;
	currentSessionPath?: string;
}

export async function pickSessionsChecklist(
	ctx: ExtensionCommandContext,
	sessions: SessionInfo[],
	options: PickSessionsOptions,
): Promise<string[] | undefined> {
	if (sessions.length === 0) return undefined;

	return await ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
		return new SessionChecklist({
			title: options.title,
			sessions,
			theme,
			currentSessionPath: options.currentSessionPath,
			requestRender: () => tui.requestRender(),
			finish: done,
		});
	});
}

interface ChecklistInit {
	title: string;
	sessions: SessionInfo[];
	theme: Theme;
	currentSessionPath?: string;
	requestRender: () => void;
	finish: (result: string[] | undefined) => void;
}

class SessionChecklist implements Component, Focusable {
	private title: string;
	private sessions: SessionInfo[];
	private theme: Theme;
	private currentSessionPath?: string;
	private requestRender: () => void;
	private finish: (result: string[] | undefined) => void;
	private index = 0;
	private selected = new Set<string>();
	private maxVisible = 12;
	private _focused = false;

	constructor(init: ChecklistInit) {
		this.title = init.title;
		this.sessions = init.sessions;
		this.theme = init.theme;
		this.currentSessionPath = init.currentSessionPath;
		this.requestRender = init.requestRender;
		this.finish = init.finish;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {
		// Rendering is computed from live state, so nothing is cached.
	}

	render(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const push = (line: string) => lines.push(truncateToWidth(line, width));

		push(theme.fg("accent", theme.bold(this.title)));
		push("");

		const total = this.sessions.length;
		const visible = Math.max(1, Math.min(this.maxVisible, total));
		const start = Math.max(0, Math.min(this.index - Math.floor(visible / 2), total - visible));
		const end = Math.min(total, start + visible);

		if (start > 0) push(theme.fg("muted", `  ↑ ${start} more`));

		for (let i = start; i < end; i++) {
			const session = this.sessions[i];
			if (!session) continue;
			const isCursor = i === this.index;
			const isSelected = this.selected.has(session.path);
			const isCurrent = this.currentSessionPath !== undefined && isSamePath(session.path, this.currentSessionPath);

			const cursor = isCursor ? theme.fg("accent", "❯ ") : "  ";
			const box = isSelected ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
			const label = isCursor ? theme.bold(sessionTitle(session, 70)) : sessionTitle(session, 70);
			const currentTag = isCurrent ? theme.fg("warning", " (current)") : "";
			const meta = theme.fg("muted", ` — ${formatAge(session.modified)} · ${session.messageCount} msg`);
			push(`${cursor}${box} ${label}${currentTag}${meta}`);
		}

		if (end < total) push(theme.fg("muted", `  ↓ ${total - end} more`));

		push("");
		const count = this.selected.size;
		push(
			theme.fg(
				"muted",
				`${count} selected of ${total} · space toggle · a all · enter delete · esc cancel`,
			),
		);

		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.finish(undefined);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.finish([...this.selected]);
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.move(-10);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.move(10);
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.toggleCurrent();
			return;
		}
		if (data === "a") {
			this.toggleAll();
		}
	}

	private move(delta: number): void {
		if (this.sessions.length === 0) return;
		const next = this.index + delta;
		this.index = Math.max(0, Math.min(this.sessions.length - 1, next));
		this.requestRender();
	}

	private toggleCurrent(): void {
		const session = this.sessions[this.index];
		if (!session) return;
		if (this.selected.has(session.path)) this.selected.delete(session.path);
		else this.selected.add(session.path);
		this.requestRender();
	}

	private toggleAll(): void {
		if (this.selected.size === this.sessions.length) this.selected.clear();
		else for (const session of this.sessions) this.selected.add(session.path);
		this.requestRender();
	}
}
