/**
 * Interactive multi-select checklist for choosing sessions to delete, with a
 * live search field. TUI only; other modes fall back to one-by-one dialogs in
 * handlers.ts.
 *
 * Key handling mirrors Pi's built-in session picker: printable keys go to the
 * search input, arrows move the selection, Enter confirms. Multi-select adds a
 * Tab-switched "list" focus where Space toggles and `a` toggles everything the
 * current search shows.
 */

import type { ExtensionCommandContext, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { filterSessions, formatAge, isSamePath, sessionTitle } from "./session-files.ts";

export interface PickSessionsOptions {
	title: string;
	currentSessionPath?: string;
	/** Pre-fills the search field, for example from `/delete-session <query>`. */
	initialQuery?: string;
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
			initialQuery: options.initialQuery,
			requestRender: () => tui.requestRender(),
			finish: done,
		});
	});
}

export interface ChecklistInit {
	title: string;
	sessions: SessionInfo[];
	theme: Theme;
	currentSessionPath?: string;
	initialQuery?: string;
	requestRender: () => void;
	finish: (result: string[] | undefined) => void;
}

type ChecklistFocus = "search" | "list";

export class SessionChecklist implements Component, Focusable {
	private title: string;
	private sessions: SessionInfo[];
	private theme: Theme;
	private currentSessionPath?: string;
	private requestRender: () => void;
	private finish: (result: string[] | undefined) => void;
	private searchInput: Input;
	private filtered: SessionInfo[];
	private selected = new Set<string>();
	private index = 0;
	private maxVisible = 12;
	private focus: ChecklistFocus = "search";
	private _focused = false;

	constructor(init: ChecklistInit) {
		this.title = init.title;
		this.sessions = init.sessions;
		this.theme = init.theme;
		this.currentSessionPath = init.currentSessionPath;
		this.requestRender = init.requestRender;
		this.finish = init.finish;
		this.searchInput = new Input({ prompt: "⌕ ", placeholder: "type to search sessions" });
		this.filtered = init.sessions;
		if (init.initialQuery && init.initialQuery.trim().length > 0) {
			this.searchInput.setValue(init.initialQuery);
			this.refilter();
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.focus === "search";
	}

	/** Current search text, exposed for tests. */
	getQuery(): string {
		return this.searchInput.getValue();
	}

	/** Visible sessions after filtering, exposed for tests. */
	getVisibleSessions(): SessionInfo[] {
		return this.filtered;
	}

	getFocus(): ChecklistFocus {
		return this.focus;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const push = (line: string) => lines.push(truncateToWidth(line, width));

		push(theme.fg("accent", theme.bold(this.title)));
		for (const line of this.searchInput.render(width)) push(line);
		push(theme.fg("muted", "─".repeat(Math.max(1, Math.min(width, 40)))));

		const total = this.filtered.length;
		const allCount = this.sessions.length;

		if (total === 0) {
			push(theme.fg("warning", `  no sessions match "${this.searchInput.getValue()}"`));
		} else {
			const visible = Math.max(1, Math.min(this.maxVisible, total));
			const start = Math.max(0, Math.min(this.index - Math.floor(visible / 2), total - visible));
			const end = Math.min(total, start + visible);

			if (start > 0) push(theme.fg("muted", `  ↑ ${start} more`));

			for (let i = start; i < end; i++) {
				const session = this.filtered[i];
				if (!session) continue;
				const isCursor = i === this.index;
				const isSelected = this.selected.has(session.path);
				const isCurrent =
					this.currentSessionPath !== undefined && isSamePath(session.path, this.currentSessionPath);

				const cursor = isCursor ? theme.fg("accent", this.focus === "list" ? "❯ " : "→ ") : "  ";
				const box = isSelected ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const label = isCursor ? theme.bold(sessionTitle(session, 70)) : sessionTitle(session, 70);
				const currentTag = isCurrent ? theme.fg("warning", " (current)") : "";
				const meta = theme.fg("muted", ` — ${formatAge(session.modified)} · ${session.messageCount} msg`);
				const marker = isSelected && !isCursor ? theme.fg("success", " •") : "";
				push(`${cursor}${box} ${label}${currentTag}${meta}${marker}`);
			}

			if (end < total) push(theme.fg("muted", `  ↓ ${total - end} more`));
			if (this.searchInput.getValue().trim().length > 0) {
				push(theme.fg("muted", `  ${total} of ${allCount} shown`));
			}
		}

		push("");
		const selectedCount = this.selected.size;
		const deleteHint = selectedCount === 0 ? "enter: nothing selected" : `enter: delete ${selectedCount}`;
		const hints =
			this.focus === "search"
				? `searching · ↑↓ move · tab: select mode · ${deleteHint} · esc: clear`
				: `[list] ↑↓ move · space toggle · a all shown · tab: search · ${deleteHint} · esc: back`;
		push(theme.fg("muted", `${selectedCount} selected · ${hints}`));

		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab)) {
			this.setFocus(this.focus === "search" ? "list" : "search");
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.focus === "list") {
				this.setFocus("search");
				return;
			}
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.setValue("");
				this.refilter();
				return;
			}
			this.finish(undefined);
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.finish([...this.selected]);
			return;
		}

		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.pageUp)) return this.move(-10);
		if (matchesKey(data, Key.pageDown)) return this.move(10);

		if (this.focus === "list") {
			if (matchesKey(data, Key.space)) return this.toggleCurrent();
			if (data === "a") return this.toggleAllShown();
			if (data === "j") return this.move(1);
			if (data === "k") return this.move(-1);
			return;
		}

		// Search focus: the input owns every other key, including space.
		this.searchInput.handleInput(data);
		this.refilter();
	}

	private setFocus(focus: ChecklistFocus): void {
		this.focus = focus;
		this.searchInput.focused = this._focused && focus === "search";
		this.requestRender();
	}

	private refilter(): void {
		const query = this.searchInput.getValue();
		this.filtered = query.trim().length > 0 ? filterSessions(this.sessions, query) : this.sessions;
		this.index = Math.max(0, Math.min(this.index, Math.max(0, this.filtered.length - 1)));
		this.requestRender();
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.index = Math.max(0, Math.min(this.filtered.length - 1, this.index + delta));
		this.requestRender();
	}

	private toggleCurrent(): void {
		const session = this.filtered[this.index];
		if (!session) return;
		if (this.selected.has(session.path)) this.selected.delete(session.path);
		else this.selected.add(session.path);
		this.requestRender();
	}

	private toggleAllShown(): void {
		const allShownSelected =
			this.filtered.length > 0 && this.filtered.every((session) => this.selected.has(session.path));
		if (allShownSelected) for (const session of this.filtered) this.selected.delete(session.path);
		else for (const session of this.filtered) this.selected.add(session.path);
		this.requestRender();
	}
}
