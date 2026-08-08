import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { expandQueuedInput } from "../queued-input.ts";

function command(name: string, source: SlashCommandInfo["source"], path: string): SlashCommandInfo {
	return {
		name,
		source,
		sourceInfo: { path, source: "test", scope: "temporary", origin: "top-level" },
	};
}

test("expands prompt templates with Pi-compatible arguments", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-prompt-"));
	const path = join(dir, "review.md");
	writeFileSync(path, [
		"---",
		"description: Test prompt",
		"---",
		"$1|$2|$@|${3:-fallback}|${@:2:1}",
	].join("\n"));
	try {
		const review = command("review", "prompt", path);
		const expected = "first|two words|first two words|fallback|two words";
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
	const skill = command("skill:bro", "skill", path);
	const block = `<skill name="bro" location="${path}">\nReferences are relative to ${dir}.\n\nSpeak plainly.\n</skill>`;
	try {
		assert.equal(expandQueuedInput("/skill:bro", [skill]), block);
		assert.equal(expandQueuedInput("/bro simplify this", [skill]), `${block}\n\nsimplify this`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prompt templates take precedence over short skill aliases", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-collision-"));
	const promptPath = join(dir, "bro.md");
	const skillPath = join(dir, "SKILL.md");
	writeFileSync(promptPath, "Prompt wins: $@");
	writeFileSync(skillPath, "---\nname: bro\ndescription: Skill\n---\nSkill body");
	try {
		assert.equal(expandQueuedInput("/bro now", [
			command("bro", "prompt", promptPath),
			command("skill:bro", "skill", skillPath),
		]), "Prompt wins: now");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("does not let resources or short skill aliases shadow Pi built-ins", () => {
	const commands = [
		command("model", "prompt", "/missing/model.md"),
		command("skill:model", "skill", "/missing/SKILL.md"),
	];
	assert.equal(expandQueuedInput("/model", commands), "/model");
});

test("leaves messages and unknown slash input unchanged", () => {
	assert.equal(expandQueuedInput("continue", []), "continue");
	assert.equal(expandQueuedInput("/unknown with args", []), "/unknown with args");
});

test("rejects discovered extension commands", () => {
	const extension = command("deploy", "extension", "/extension.ts");
	assert.throws(
		() => expandQueuedInput("/deploy prod", [extension]),
		/extension command.*cannot be run from the queue/,
	);
});
