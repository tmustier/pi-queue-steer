import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	parseFrontmatter,
	stripFrontmatter,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

interface SlashInvocation {
	name: string;
	args: string;
}

// pi.getCommands() intentionally omits built-ins. Keep them ahead of resource
// commands so a short skill alias can never turn /model, /settings, etc. into a
// different prompt. /compact and /reload are handled separately by queue-steer.
const PI_BUILTIN_COMMANDS = new Set([
	"settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session",
	"changelog", "hotkeys", "fork", "clone", "tree", "trust", "login", "logout", "new", "compact",
	"resume", "reload", "quit", "debug", "arminsayshi", "dementedelves",
]);

function parsePromptInvocation(text: string): SlashInvocation | undefined {
	if (!text.startsWith("/")) return undefined;
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match?.[1]) return undefined;
	return { name: match[1], args: match[2] ?? "" };
}

function parseCommandInvocation(text: string): SlashInvocation | undefined {
	if (!text.startsWith("/")) return undefined;
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	if (!name) return undefined;
	return { name, args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1) };
}

/** Parse template arguments with the same quote handling as Pi. */
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

/** Apply Pi prompt-template positional, default and slice substitutions. */
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

function matchingCommand(
	text: string,
	commands: readonly SlashCommandInfo[],
): { command: SlashCommandInfo; invocation: SlashInvocation } | undefined {
	const commandInvocation = parseCommandInvocation(text);
	const promptInvocation = parsePromptInvocation(text);
	if (!commandInvocation || !promptInvocation || PI_BUILTIN_COMMANDS.has(commandInvocation.name)) return undefined;

	const commandExact = commands.filter((command) => command.name === commandInvocation.name);
	const extension = commandExact.find((command) => command.source === "extension");
	if (extension) return { command: extension, invocation: commandInvocation };
	if (commandInvocation.name.startsWith("skill:")) {
		const skill = commandExact.find((command) => command.source === "skill");
		if (skill) return { command: skill, invocation: commandInvocation };
	}

	const prompt = commands.find(
		(command) => command.source === "prompt" && command.name === promptInvocation.name,
	);
	if (prompt) return { command: prompt, invocation: promptInvocation };

	// Pi names Agent Skill commands /skill:name. The shorter /name form is a
	// queue-steer convenience when it cannot shadow an exact command.
	const skillAliases = commands.filter(
		(command) => command.source === "skill" && command.name === `skill:${commandInvocation.name}`,
	);
	return skillAliases.length === 1
		? { command: skillAliases[0], invocation: commandInvocation }
		: undefined;
}

/**
 * Resolve resource-backed slash input immediately before queue delivery.
 *
 * Rows stay raw while queued so they remain concise and editable. Unknown slash
 * input remains ordinary user text, matching Pi. Extension commands are rejected
 * because Pi exposes discovery but no public command invocation API.
 */
export function expandQueuedInput(text: string, commands: readonly SlashCommandInfo[]): string {
	const match = matchingCommand(text, commands);
	if (!match) return text;
	const { command, invocation } = match;

	if (command.source === "extension") {
		throw new Error(`/${invocation.name} is an extension command and cannot be run from the queue`);
	}

	const source = readFileSync(command.sourceInfo.path, "utf8");
	if (command.source === "prompt") {
		const { body } = parseFrontmatter(source);
		return substituteArgs(body, parseCommandArgs(invocation.args));
	}

	const skillName = command.name.slice("skill:".length);
	const baseDir = dirname(command.sourceInfo.path);
	const body = stripFrontmatter(source).trim();
	const skillBlock = `<skill name="${skillName}" location="${command.sourceInfo.path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
	const args = invocation.args.trim();
	return args ? `${skillBlock}\n\n${args}` : skillBlock;
}
