import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { expandQueuedInput } from "../queued-input.ts";

function command(
	name: string,
	source: SlashCommandInfo["source"],
	path: string,
	baseDir?: string,
): SlashCommandInfo {
	return {
		name,
		source,
		sourceInfo: { path, source: "test", scope: "temporary", origin: "top-level", baseDir },
	};
}

test("expands prompt templates with Pi-compatible arguments", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-prompt-"));
	const path = join(dir, "review.md");
	writeFileSync(path, [
		"---",
		"description: Test prompt",
		"---",
		"$1|$2|$@|${1:-fallback}|${3:-fallback}|${@:2}|${@:2:1}|$ARGUMENTS|${@:-fallback}",
	].join("\n"));
	try {
		const review = command("review", "prompt", path);
		const expected = "first|two words|first two words|first|fallback|two words|two words|first two words|${@:-fallback}";
		assert.equal(expandQueuedInput('/review first "two words"', [review]), expected);
		assert.equal(expandQueuedInput('/review first\n"two words"', [review]), expected);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("expands native and short Agent Skill invocations", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-skill-"));
	const path = join(dir, "SKILL.md");
	writeFileSync(path, "---\nname: bro\ndescription: Speak plainly\n---\nSpeak plainly.");
	const skill = command("skill:bro", "skill", path, "/wrong/provenance/base");
	const block = `<skill name="bro" location="${path}">\nReferences are relative to ${dir}.\n\nSpeak plainly.\n</skill>`;
	try {
		assert.equal(expandQueuedInput("/skill:bro", [skill]), block);
		assert.equal(expandQueuedInput("/bro simplify this", [skill]), `${block}\n\nsimplify this`);
		assert.equal(expandQueuedInput("/skill:bro\tbe direct", [skill]), "/skill:bro\tbe direct");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("exact commands take precedence over short skill aliases", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-collision-"));
	const promptPath = join(dir, "bro.md");
	const skillPath = join(dir, "SKILL.md");
	writeFileSync(promptPath, "Prompt wins: $@");
	writeFileSync(skillPath, "---\nname: bro\ndescription: Skill\n---\nSkill body");
	try {
		const skill = command("skill:bro", "skill", skillPath, dir);
		assert.equal(expandQueuedInput("/bro now", [
			command("bro", "prompt", promptPath),
			skill,
		]), "Prompt wins: now");
		const nativeCollision = command("skill:bro", "prompt", promptPath);
		assert.match(expandQueuedInput("/skill:bro", [nativeCollision, skill]), /<skill name="bro"/);
		assert.equal(expandQueuedInput("/skill:bro\nnow", [nativeCollision, skill]), "Prompt wins: now");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("does not guess when a short skill alias is ambiguous", () => {
	const commands = [
		command("skill:bro", "skill", "/one/SKILL.md", "/one"),
		command("skill:bro", "skill", "/two/SKILL.md", "/two"),
	];
	assert.equal(expandQueuedInput("/bro", commands), "/bro");
});

test("does not let resources or short skill aliases shadow Pi built-ins", () => {
	const commands = [
		command("model", "prompt", "/missing/model.md"),
		command("skill:model", "skill", "/missing/SKILL.md"),
		command("skill:debug", "skill", "/missing/debug/SKILL.md"),
	];
	assert.equal(expandQueuedInput("/model", commands), "/model");
	assert.equal(expandQueuedInput("/debug", commands), "/debug");
});

test("leaves messages and unknown slash input unchanged", () => {
	assert.equal(expandQueuedInput("continue", []), "continue");
	assert.equal(expandQueuedInput("/unknown with args", []), "/unknown with args");
	assert.equal(expandQueuedInput(" /skill:bro", []), " /skill:bro");
});

test("rejects discovered extension commands", () => {
	const extension = command("deploy", "extension", "/extension.ts");
	assert.throws(
		() => expandQueuedInput("/deploy prod", [extension]),
		/extension command.*cannot be run from the queue/,
	);
	assert.equal(expandQueuedInput("/deploy\nprod", [extension]), "/deploy\nprod");
});
