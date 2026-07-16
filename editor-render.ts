const ESC = "\x1b";
const BEL = "\x07";

type AnsiToken = {
	text: string;
	visible: boolean;
};

/** Split a rendered TUI line without disturbing ANSI, OSC, or APC sequences. */
function tokenizeAnsi(line: string): AnsiToken[] {
	const tokens: AnsiToken[] = [];

	for (let index = 0; index < line.length;) {
		if (line[index] !== ESC) {
			const codePoint = line.codePointAt(index);
			if (codePoint === undefined) break;
			const text = String.fromCodePoint(codePoint);
			tokens.push({ text, visible: true });
			index += text.length;
			continue;
		}

		const start = index;
		index += 1;
		const kind = line[index];
		if (kind === "[") {
			index += 1;
			while (index < line.length) {
				const code = line.charCodeAt(index++);
				if (code >= 0x40 && code <= 0x7e) break;
			}
		} else if (kind === "]") {
			index += 1;
			while (index < line.length) {
				if (line[index] === BEL) {
					index += 1;
					break;
				}
				if (line[index] === ESC && line[index + 1] === "\\") {
					index += 2;
					break;
				}
				index += 1;
			}
		} else if (kind === "_" || kind === "P" || kind === "^") {
			index += 1;
			while (index < line.length) {
				if (line[index] === BEL) {
					index += 1;
					break;
				}
				if (line[index] === ESC && line[index + 1] === "\\") {
					index += 2;
					break;
				}
				index += 1;
			}
		} else {
			index += kind === undefined ? 0 : 1;
		}
		tokens.push({ text: line.slice(start, index), visible: false });
	}

	return tokens;
}

export function stripAnsi(line: string): string {
	return tokenizeAnsi(line)
		.filter((token) => token.visible)
		.map((token) => token.text)
		.join("");
}

function isEditorFrame(line: string): boolean {
	const plain = stripAnsi(line);
	const trimmed = plain.trim();
	if (!trimmed) return false;
	if (/^[╭┌╰└].*[╮┐╯┘]$/.test(trimmed)) return true;
	const horizontalCount = [...plain].filter((character) => character === "─").length;
	return horizontalCount >= 3 && horizontalCount >= Math.floor(plain.length * 0.5);
}

function stripOuterFrameAndPadding(line: string, paddingX: number): string {
	const tokens = tokenizeAnsi(line);
	const visibleIndices = (): number[] => tokens
		.map((token, index) => token.visible ? index : -1)
		.filter((index) => index >= 0);

	let visible = visibleIndices();
	for (let layer = 0; layer < 3; layer += 1) {
		visible = visibleIndices().filter((index) => tokens[index]!.text !== "");
		const firstContentPosition = visible.findIndex((index) => tokens[index]!.text !== " ");
		let lastContentPosition = -1;
		for (let index = visible.length - 1; index >= 0; index -= 1) {
			if (tokens[visible[index]!]!.text !== " ") {
				lastContentPosition = index;
				break;
			}
		}
		if (firstContentPosition === -1 || lastContentPosition === -1) break;
		const firstIndex = visible[firstContentPosition]!;
		const lastIndex = visible[lastContentPosition]!;
		const first = tokens[firstIndex]!.text;
		const last = tokens[lastIndex]!.text;
		if ((first !== "│" && first !== "┃") || (last !== "│" && last !== "┃")) break;

		for (const index of visible.slice(0, firstContentPosition)) tokens[index]!.text = "";
		for (const index of visible.slice(lastContentPosition + 1)) tokens[index]!.text = "";
		tokens[firstIndex]!.text = "";
		tokens[lastIndex]!.text = "";
	}

	for (let count = 0; count < paddingX; count += 1) {
		visible = visibleIndices().filter((index) => tokens[index]!.text !== "");
		const firstIndex = visible[0];
		if (firstIndex !== undefined && tokens[firstIndex]!.text === " ") tokens[firstIndex]!.text = "";
		const lastIndex = visible.at(-1);
		if (lastIndex !== undefined && tokens[lastIndex]!.text === " ") tokens[lastIndex]!.text = "";
	}

	return tokens.map((token) => token.text).join("");
}

/**
 * Reduce a composed Pi editor render to its text and autocomplete rows.
 *
 * Pi's editor renders its own horizontal frame, while editor extensions may
 * add side borders and padding. The queue already provides that frame, so an
 * active row should inherit only the live editor content and cursor.
 */
export function extractInlineEditorLines(lines: readonly string[], paddingX = 0): string[] {
	if (lines.length === 0) return [""];
	if (!isEditorFrame(lines[0] ?? "")) return [...lines];

	let bottomFrameIndex = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (isEditorFrame(lines[index] ?? "")) {
			bottomFrameIndex = index;
			break;
		}
	}
	if (bottomFrameIndex === -1) return [...lines];

	const editorBody = lines
		.slice(1, bottomFrameIndex)
		.map((line) => stripOuterFrameAndPadding(line, Math.max(0, paddingX)));
	const auxiliary = lines.slice(bottomFrameIndex + 1);
	return [...editorBody, ...auxiliary].length > 0 ? [...editorBody, ...auxiliary] : [""];
}
