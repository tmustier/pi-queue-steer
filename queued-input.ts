import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	parseFrontmatter,
	stripFrontmatter,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

// getCommands() omits built-ins, which still take precedence over skill aliases.
const PI_BUILTIN_COMMANDS = new Set([
	"settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session",
	"changelog", "hotkeys", "fork", "clone", "tree", "trust", "login", "logout", "new", "compact",
	"resume", "reload", "quit",
]);

// Pi does not export its prompt argument parser or substitution helper.
function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: "\"" | "'" | undefined;
	for (const character of argsString) {
		if (inQuote) {
			if (character === inQuote) inQuote = undefined;
			else current += character;
		} else if (character === "\"" || character === "'") {
			inQuote = character;
		} else if (/\s/.test(character)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += character;
		}
	}
	if (current) args.push(current);
	return args;
}

function substituteArgs(content: string, args: readonly string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple: string | undefined) => {
			if (defaultTarget) {
				return args[Number.parseInt(defaultTarget, 10) - 1] || defaultValue;
			}
			if (sliceStart) {
				const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
				if (sliceLength) {
					return args.slice(start, start + Number.parseInt(sliceLength, 10)).join(" ");
				}
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			return args[Number.parseInt(simple ?? "", 10) - 1] ?? "";
		},
	);
}

export function expandQueuedInput(text: string, commands: readonly SlashCommandInfo[]): string {
	const invocation = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	const name = invocation?.[1];
	if (!name || PI_BUILTIN_COMMANDS.has(name)) return text;

	const command = commands.find((candidate) => candidate.name === name)
		?? commands.find((candidate) => candidate.source === "skill" && candidate.name === `skill:${name}`);
	if (!command) return text;
	if (command.source === "extension") {
		throw new Error(`/${name} is an extension command and cannot be run from the queue`);
	}

	const source = readFileSync(command.sourceInfo.path, "utf8");
	const args = invocation[2] ?? "";
	if (command.source === "prompt") {
		const { body } = parseFrontmatter(source);
		return substituteArgs(body, parseCommandArgs(args));
	}

	const skillName = command.name.slice("skill:".length);
	const baseDir = dirname(command.sourceInfo.path);
	const body = stripFrontmatter(source).trim();
	const skillBlock = `<skill name="${skillName}" location="${command.sourceInfo.path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
	const skillArgs = args.trim();
	return skillArgs ? `${skillBlock}\n\n${skillArgs}` : skillBlock;
}
