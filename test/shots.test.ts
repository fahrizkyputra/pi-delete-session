import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	changedShots,
	deleteOwnedShots,
	findOwnedShots,
	namedByCall,
	orphanedShotOwners,
	recordShots,
	snapshotShots,
	type ShotsLocations,
} from "../src/shots.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-delete-session-shots-"));
	dirs.push(root);
	const locations: ShotsLocations = { shotsDir: join(root, "shots"), ledgerDir: join(root, "ledger") };
	mkdirSync(locations.shotsDir, { recursive: true });
	const sessions = join(root, "sessions");
	mkdirSync(sessions, { recursive: true });
	const session = (name: string) => {
		const path = join(sessions, `${name}.jsonl`);
		writeFileSync(path, "{}\n");
		return path;
	};
	const shot = (rel: string, content = "png") => {
		const path = join(locations.shotsDir, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
		return path;
	};
	return { root, locations, session, shot };
}

const NO_TRASH = { useTrash: false };

test("snapshot and diff: only images that appeared or changed during a call", () => {
	const { locations, shot } = setup();
	const old = shot("old/keep.png");
	const before = snapshotShots(locations.shotsDir);
	const fresh = shot("app-login/shot.png");
	shot("app-login/mock.html"); // not an image
	writeFileSync(old, "png changed");
	utimesSync(old, new Date(), new Date(Date.now() + 5000));
	const changed = changedShots(before, snapshotShots(locations.shotsDir)).sort();
	assert.deepEqual(changed, [fresh, old].sort());
});

test("a call claims only the images it names", () => {
	const { locations, shot } = setup();
	const mine = shot("app-login/shot.png");
	const theirs = shot("other-project/shot.png");
	const flat = shot("tfl-q1.png");
	const call = 'M=~/.agent-browser/shots/app-login; agent-browser screenshot $M/shot.png && echo "saved tfl-q1.png"';
	assert.deepEqual(namedByCall([mine, theirs, flat], locations.shotsDir, call).sort(), [flat, mine].sort());
	assert.deepEqual(namedByCall([theirs], locations.shotsDir, "agent-browser screenshot shot.png"), [], "a bare name in another folder is not enough");
});

test("deleting a session takes its recorded photos, and only those", () => {
	const { locations, session, shot } = setup();
	const a = session("a");
	const b = session("b");
	const aShot = shot("a-ui/shot.png");
	const bShot = shot("b-ui/shot.png");
	const untracked = shot("made-before-the-feature.png");
	recordShots(locations, a, [aShot]);
	recordShots(locations, b, [bShot]);

	const owned = findOwnedShots(locations, [a]);
	assert.deepEqual(owned.files.map((file) => file.path), [aShot]);
	assert.equal(owned.bytes, 3);

	const result = deleteOwnedShots(locations, [a], owned, NO_TRASH);
	assert.deepEqual(result, { removed: 1, failures: [] });
	assert.equal(existsSync(aShot), false);
	assert.equal(existsSync(join(locations.shotsDir, "a-ui")), false, "the emptied folder goes too");
	assert.equal(existsSync(bShot), true, "another session's photo stays");
	assert.equal(existsSync(untracked), true, "a photo nobody recorded stays");
	assert.equal(existsSync(locations.shotsDir), true, "the shots folder itself stays");
	assert.deepEqual(findOwnedShots(locations, [b]).files.map((file) => file.path), [bShot], "b's ledger is intact");
});

test("a shared photo waits for its last owner", () => {
	const { locations, session, shot } = setup();
	const a = session("a");
	const b = session("b");
	const shared = shot("shared/shot.png");
	recordShots(locations, a, [shared]);
	recordShots(locations, b, [shared]);

	const onlyA = findOwnedShots(locations, [a]);
	assert.equal(onlyA.files.length, 0);
	assert.equal(onlyA.keptShared, 1);
	deleteOwnedShots(locations, [a], onlyA, NO_TRASH);
	assert.equal(existsSync(shared), true);

	const thenB = findOwnedShots(locations, [b]);
	assert.deepEqual(thenB.files.map((file) => file.path), [shared], "b is the last owner now");
	assert.deepEqual(findOwnedShots(setup().locations, []).files, []);
});

test("deleting both owners at once takes a shared photo", () => {
	const { locations, session, shot } = setup();
	const a = session("a");
	const b = session("b");
	const shared = shot("shared/shot.png");
	recordShots(locations, a, [shared]);
	recordShots(locations, b, [shared]);
	assert.equal(findOwnedShots(locations, [a, b]).files.length, 1);
});

test("a photo changed after it was recorded is no longer provably the session's", () => {
	const { locations, session, shot } = setup();
	const a = session("a");
	const file = shot("a-ui/shot.png");
	recordShots(locations, a, [file]);
	writeFileSync(file, "overwritten by something else");
	const owned = findOwnedShots(locations, [a]);
	assert.equal(owned.files.length, 0);
	assert.equal(owned.keptChanged, 1);
});

test("a re-take by the same session updates the record", () => {
	const { locations, session, shot } = setup();
	const a = session("a");
	const file = shot("a-ui/shot.png");
	recordShots(locations, a, [file]);
	writeFileSync(file, "second take");
	utimesSync(file, new Date(), new Date(Date.now() + 5000));
	recordShots(locations, a, [file]);
	assert.equal(findOwnedShots(locations, [a]).files.length, 1);
});

test("a subagent run of the session counts as the session", () => {
	const { root, locations, session, shot } = setup();
	const a = session("a");
	const child = join(root, "sessions", "a", "run-id", "run-0", "session.jsonl");
	const file = shot("child/shot.png");
	recordShots(locations, child, [file]);
	assert.equal(findOwnedShots(locations, [a]).files.length, 1);
});

test("never follows a link out of the shots folder, and never deletes a non-image", () => {
	const { root, locations, session, shot } = setup();
	const a = session("a");
	const outside = join(root, "precious.png");
	writeFileSync(outside, "keep me");
	const link = join(locations.shotsDir, "link.png");
	symlinkSync(outside, link);
	const note = shot("a-ui/notes.md", "text");
	recordShots(locations, a, [link, note, outside]);
	const owned = findOwnedShots(locations, [a]);
	assert.deepEqual(owned.files, []);
	deleteOwnedShots(locations, [a], owned, NO_TRASH);
	assert.equal(existsSync(outside), true);
	assert.equal(existsSync(note), true);
});

test("no shots folder, no ledger: nothing to do", () => {
	const { locations, session } = setup();
	rmSync(locations.shotsDir, { recursive: true });
	assert.deepEqual(findOwnedShots(locations, [session("a")]), { files: [], bytes: 0, keptShared: 0, keptChanged: 0 });
});

test("ledgers of sessions that are gone are found for /delete-session orphans", () => {
	const { locations, session, shot } = setup();
	const a = session("a");
	recordShots(locations, a, [shot("a-ui/shot.png")]);
	rmSync(a);
	assert.deepEqual(orphanedShotOwners(locations), [a]);
});
