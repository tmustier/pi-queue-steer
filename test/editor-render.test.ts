import assert from "node:assert/strict";
import test from "node:test";
import { extractInlineEditorLines, stripAnsi } from "../editor-render.ts";

test("removes the stock editor frame without disturbing its cursor", () => {
	const cursorMarker = "\x1b_pi:c\x07";
	const lines = [
		"\x1b[33m────────────\x1b[39m",
		`draft${cursorMarker}\x1b[7m \x1b[0m      `,
		"\x1b[33m────────────\x1b[39m",
	];

	const extracted = extractInlineEditorLines(lines);
	assert.equal(extracted.length, 1);
	assert.match(extracted[0]!, /pi:c/);
	assert.equal(stripAnsi(extracted[0]!).trim(), "draft");
});

test("unwraps composed editor side borders and padding", () => {
	const lines = [
		"\x1b[33m╭──── model ─╮\x1b[39m",
		"\x1b[33m│\x1b[39m draft\x1b_pi:c\x07\x1b[7m \x1b[0m      \x1b[33m│\x1b[39m",
		"\x1b[33m╰──── 90% ───╯\x1b[39m",
	];

	const extracted = extractInlineEditorLines(lines, 1);
	assert.equal(extracted.length, 1);
	assert.equal(stripAnsi(extracted[0]!).trim(), "draft");
	assert.doesNotMatch(stripAnsi(extracted[0]!), /[│╭╮╰╯]/);
});

test("unwraps nested side frames even when a composer pads outside them", () => {
	const extracted = extractInlineEditorLines([
		"╭────────────╮",
		"  │ │ draft       │ │  ",
		"╰────────────╯",
	], 1);

	assert.equal(stripAnsi(extracted[0]!).trim(), "draft");
	assert.doesNotMatch(stripAnsi(extracted[0]!), /[│┃]/);
});

test("keeps autocomplete rows below the editor body", () => {
	const extracted = extractInlineEditorLines([
		"────────────",
		"@iss        ",
		"────────────",
		"#123 issue  ",
		"#456 issue  ",
	]);

	assert.deepEqual(extracted.map((line) => stripAnsi(line).trim()), ["@iss", "#123 issue", "#456 issue"]);
});

test("does not mistake short horizontal user text for the bottom frame", () => {
	const extracted = extractInlineEditorLines([
		"────────────",
		"---         ",
		"────────────",
	]);

	assert.equal(stripAnsi(extracted[0]!).trim(), "---");
});

test("leaves frameless custom editor output intact", () => {
	assert.deepEqual(extractInlineEditorLines(["custom editor"]), ["custom editor"]);
});
