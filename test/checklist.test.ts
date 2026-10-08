/**
 * Checklist behavior: search filtering, focus switching, toggling, and confirm.
 * The component is a plain pi-tui Component, so it runs without a terminal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import { SessionChecklist } from "../src/pick-sessions.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

function makeSessions(): SessionInfo[] {
	const base = {
		id: "id",
		cwd: "/tmp/project",
		created: new Date("2026-03-01T10:00:00.000Z"),
		modified: new Date(),
		messageCount: 4,
		allMessagesText: "",
	};
	return [
		{ ...base, path: "/s/deploy.jsonl", id: "id-deploy", name: "Deploy script", firstMessage: "deploy the api" },
		{ ...base, path: "/s/auth.jsonl", id: "id-auth", firstMessage: "fix login bug" },
		{ ...base, path: "/s/kubernetes.jsonl", id: "id-k8s", firstMessage: "cluster work", allMessagesText: "talks about kubernetes" },
	];
}

interface Harness {
	checklist: SessionChecklist;
	results: (string[] | undefined)[];
	text(): string;
}

function createHarness(options: { initialQuery?: string; currentSessionPath?: string } = {}): Harness {
	const sessions = makeSessions();
	const results: (string[] | undefined)[] = [];
	const checklist = new SessionChecklist({
		title: "Sessions in this project",
		sessions,
		theme,
		currentSessionPath: options.currentSessionPath,
		initialQuery: options.initialQuery,
		requestRender: () => {},
		finish: (result) => results.push(result),
	});
	return {
		checklist,
		results,
		text: () => checklist.render(120).join("\n"),
	};
}

function type(checklist: SessionChecklist, input: string): void {
	for (const char of input) checklist.handleInput(char);
}

test("shows every candidate before searching", () => {
	const { checklist, text } = createHarness();
	assert.equal(checklist.getVisibleSessions().length, 3);
	assert.match(text(), /Deploy script/);
	assert.match(text(), /fix login bug/);
	assert.match(text(), /0 selected/);
	assert.match(text(), /searching/);
});

test("typing filters the list and reports how many are shown", () => {
	const { checklist, text } = createHarness();
	type(checklist, "login");

	assert.deepEqual(
		checklist.getVisibleSessions().map((session) => session.path),
		["/s/auth.jsonl"],
	);
	assert.match(text(), /1 of 3 shown/);
	assert.doesNotMatch(text(), /Deploy script/);
});

test("backspace widens the search again", () => {
	const { checklist } = createHarness();
	type(checklist, "deploy");
	assert.equal(checklist.getQuery(), "deploy");
	assert.equal(checklist.getVisibleSessions().length, 1);

	for (let i = 0; i < 6; i++) checklist.handleInput("\x7f");
	assert.equal(checklist.getQuery(), "", "six backspaces clear six characters");
	assert.equal(checklist.getVisibleSessions().length, 3);
});

test("space types a space while searching instead of toggling", () => {
	const { checklist, text } = createHarness();
	type(checklist, "cluster work");
	assert.equal(checklist.getQuery(), "cluster work");
	assert.match(text(), /0 selected/);
});

test("tab switches to list mode where space toggles the highlighted session", () => {
	const { checklist, text, results } = createHarness();
	checklist.handleInput("\t");
	assert.equal(checklist.getFocus(), "list");
	assert.match(text(), /\[list\]/);

	checklist.handleInput(" ");
	assert.match(text(), /1 selected/);
	checklist.handleInput("\x1b[B"); // down
	checklist.handleInput(" ");
	assert.match(text(), /2 selected/);
	checklist.handleInput("\x1b[A"); // back up
	checklist.handleInput(" ");
	assert.match(text(), /1 selected/, "toggling the same row again deselects it");

	checklist.handleInput("\r");
	assert.deepEqual(results.at(-1), ["/s/auth.jsonl"]);
});

test("`a` selects everything the search shows, and only in list mode", () => {
	const { checklist, text, results } = createHarness();
	type(checklist, "deploy");
	assert.equal(checklist.getQuery(), "deploy", "`a` in search mode belongs to the query");

	checklist.handleInput("\t");
	checklist.handleInput("a");
	assert.match(text(), /1 selected/);
	assert.deepEqual(checklist.getVisibleSessions().map((session) => session.path), ["/s/deploy.jsonl"]);

	checklist.handleInput("a"); // toggles the shown selection back off
	assert.match(text(), /0 selected/);
	checklist.handleInput("a");
	checklist.handleInput("\r");
	assert.deepEqual(results.at(-1), ["/s/deploy.jsonl"]);
});

test("selection survives narrowing the search", () => {
	const { checklist, text, results } = createHarness();
	checklist.handleInput("\t");
	checklist.handleInput(" ");
	assert.match(text(), /1 selected/, "first row selected");

	checklist.handleInput("\t");
	type(checklist, "kubernetes");
	assert.match(text(), /1 selected/, "hidden selection is still selected");
	assert.equal(checklist.getVisibleSessions().length, 1);

	checklist.handleInput("\r");
	assert.deepEqual(results.at(-1), ["/s/deploy.jsonl", "/s/kubernetes.jsonl"].slice(0, 1));
});

test("escape clears the search first, then cancels", () => {
	const { checklist, results } = createHarness();
	type(checklist, "deploy");
	checklist.handleInput("\x1b");
	assert.equal(checklist.getQuery(), "");
	assert.equal(checklist.getVisibleSessions().length, 3);
	assert.equal(results.length, 0);

	checklist.handleInput("\x1b");
	assert.deepEqual(results.at(-1), undefined);
});

test("the CLI query pre-fills the search field", () => {
	const { checklist, text } = createHarness({ initialQuery: "kubernetes" });
	assert.equal(checklist.getQuery(), "kubernetes");
	assert.deepEqual(
		checklist.getVisibleSessions().map((session) => session.path),
		["/s/kubernetes.jsonl"],
	);
	assert.match(text(), /1 of 3 shown/);
});

test("an unmatched search renders a hint instead of an empty list", () => {
	const { checklist, text } = createHarness();
	type(checklist, "zzzz");
	assert.equal(checklist.getVisibleSessions().length, 0);
	assert.match(text(), /no sessions match "zzzz"/);

	// Toggling with nothing visible must not crash or fake a selection.
	checklist.handleInput("\t");
	checklist.handleInput(" ");
	checklist.handleInput("a");
	assert.match(text(), /0 selected/);
});

test("the current session is marked", () => {
	const { text } = createHarness({ currentSessionPath: "/s/auth.jsonl" });
	assert.match(text(), /\(current\)/);
});
