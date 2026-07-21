import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	keyText,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type EditorComponent } from "@earendil-works/pi-tui";
import { extractInlineEditorLines } from "./editor-render.ts";
import {
	DeliveryQueue,
	parseQueuedCommand,
	QueueEditSession,
	type QueuedCommand,
	type QueuedMessage,
	type QueueLane,
} from "./queue-state.ts";

const WIDGET_ID = "queue-steer.timeline";
const EDITOR_FEATURES = Symbol.for("@tmustier/pi-editor-features");
const QUEUE_STEER_FEATURE = "queue-steer";
const NEXT_ROW_KEY = "alt+down";
const RELOAD_STASH_KEY = "@tmustier/pi-queue-steer.reload-stash";
const SUBMIT_GUARD = Symbol.for("@tmustier/pi-queue-steer.submit-guard");

/** Rows surviving a queued /reload, parked on globalThis across the runtime swap. */
interface ReloadStashRow {
	lane: QueueLane;
	text: string;
	images: ImageContent[];
}
interface ReloadStash {
	at: number;
	rows: ReloadStashRow[];
}
const globalStore = globalThis as unknown as Record<string, unknown>;
const REMOVE_ROW_KEY = "alt+x";
const TOGGLE_LANE_KEY = "alt+t";

type QueueMode = "all" | "one-at-a-time";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type ComposedEditorFactory = EditorFactory & { [EDITOR_FEATURES]?: ReadonlySet<string> };
type InlineEditorRenderer = (width: number) => string[];

function editorFeatures(factory: EditorFactory | undefined): ReadonlySet<string> {
	return (factory as ComposedEditorFactory | undefined)?.[EDITOR_FEATURES] ?? new Set();
}

function laneLabel(lane: QueueLane): string {
	return lane === "steer" ? "steer" : "follow-up";
}

function laneColor(lane: QueueLane): ThemeColor {
	return lane === "steer" ? "accent" : "warning";
}

function compactText(item: QueuedMessage<ImageContent>): string {
	const text = item.text.replace(/\s+/g, " ").trim();
	const imageNote = item.images.length > 0 ? ` [${item.images.length} image${item.images.length === 1 ? "" : "s"}]` : "";
	return `${text || `[image ${laneLabel(item.lane)}]`}${imageNote}`;
}

function fitCell(content: string, width: number): string {
	const clipped = truncateToWidth(content, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function nextRowKeyText(): string {
	const previous = keyText("app.message.dequeue");
	return /up$/i.test(previous) ? previous.replace(/up$/i, "down") : "alt+down";
}

interface QueueModes {
	steer: QueueMode;
	followUp: QueueMode;
}

/** A queue row with session drafts applied for display and navigation. */
interface TimelineItem extends QueuedMessage<ImageContent> {
	removed: boolean;
	movedLane: boolean;
	held: boolean;
	command: QueuedCommand | undefined;
}

class QueueTimelineWidget implements Component {
	private readonly items: TimelineItem[];
	private readonly editingId: string | undefined;
	private readonly renderInlineEditor: InlineEditorRenderer | undefined;
	private readonly paused: boolean;
	private readonly modes: QueueModes;
	private readonly theme: Theme;

	constructor(options: {
		items: TimelineItem[];
		editingId: string | undefined;
		renderInlineEditor: InlineEditorRenderer | undefined;
		paused: boolean;
		modes: QueueModes;
		theme: Theme;
	}) {
		this.items = options.items;
		this.editingId = options.editingId;
		this.renderInlineEditor = options.renderInlineEditor;
		this.paused = options.paused;
		this.modes = options.modes;
		this.theme = options.theme;
	}

	render(width: number): string[] {
		const steering = this.items.filter((item) => item.lane === "steer");
		const followUps = this.items.filter((item) => item.lane === "followUp");
		if (width < 28) {
			const counts = [
				this.theme.fg("accent", `S${steering.length}`),
				this.theme.fg("warning", `F${followUps.length}`),
			].join(" ");
			const summary = `queued ${counts}${this.paused ? " paused" : ""}`;
			return [truncateToWidth(summary, width, "")];
		}

		const lines: string[] = [];
		if (steering.length > 0) this.renderLaneBox(lines, "steer", steering, width);
		if (followUps.length > 0) this.renderLaneBox(lines, "followUp", followUps, width);
		return lines;
	}

	private renderLaneBox(
		lines: string[],
		lane: QueueLane,
		items: TimelineItem[],
		width: number,
	): void {
		const color = laneColor(lane);
		const border = (text: string) => this.theme.fg(color, text);
		const laneHeld = items.some((item) => item.held);
		const stage = lane === "steer" ? "next turn" : "after this run";
		const state = this.paused ? "paused" : laneHeld ? "held while editing" : stage;
		const name = lane === "steer" ? "steering queue" : "follow-ups";
		const fullTitle = ` ${name} (${items.length}) · ${state} `;
		const shortTitle = ` ${name} (${items.length}) `;
		const title = visibleWidth(fullTitle) + 2 <= width ? fullTitle : shortTitle;
		const topFill = "─".repeat(Math.max(0, width - visibleWidth(title) - 2));
		lines.push(border(`┌${title}${topFill}┐`));
		const cellWidth = width - 4;

		for (const item of items) this.renderItem(lines, item, items, cellWidth, border);

		const dequeue = keyText("app.message.dequeue");
		const followUp = keyText("app.message.followUp");
		const submit = keyText("tui.input.submit");
		const interrupt = keyText("app.interrupt");
		const selectedHere = items.some((item) => item.id === this.editingId);
		const help = this.editingId
			? selectedHere
				? `${dequeue}/${nextRowKeyText()} move · ${REMOVE_ROW_KEY} remove · ${TOGGLE_LANE_KEY} lane · ${submit} save · ${interrupt} cancel`
				: `${dequeue}/${nextRowKeyText()} move here · ${interrupt} cancel`
			: this.paused
				? `${submit} resume · ${dequeue} edit · ${interrupt} keep paused`
				: lane === "steer"
					? `${submit} steer/send next · ${dequeue} edit`
					: `${followUp} add follow-up · ${submit} send next · ${dequeue} edit`;
		lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", help), cellWidth)} ${border("│")}`);
		lines.push(border(`└${"─".repeat(width - 2)}┘`));
	}

	private renderItem(
		lines: string[],
		item: TimelineItem,
		laneItems: TimelineItem[],
		cellWidth: number,
		border: (text: string) => string,
	): void {
		const selected = item.id === this.editingId;
		const head = laneItems[0]?.id === item.id;
		const armed = this.modes[item.lane] === "all" || head;
		const color = laneColor(item.lane);

		if (!selected) {
			if (item.removed) {
				const prefix = this.theme.fg("error", "✕ ");
				const body = this.theme.fg("dim", `${compactText(item)} · removed on save`);
				lines.push(`${border("│")} ${fitCell(`${prefix}${body}`, cellWidth)} ${border("│")}`);
				return;
			}
			const marker = item.held || (this.paused && armed)
				? "⏸"
				: item.command
					? "⚙"
					: item.lane === "followUp"
						? "○"
						: armed
							? "▶"
							: "»";
			const prefix = this.theme.fg(color, `${marker} `);
			const moved = item.movedLane ? this.theme.fg("dim", " · moves here on save") : "";
			const commandNote = item.command && !item.movedLane ? this.theme.fg("dim", " · runs when idle") : "";
			const body = this.theme.fg("muted", compactText(item));
			lines.push(`${border("│")} ${fitCell(`${prefix}${body}${commandNote}${moved}`, cellWidth)} ${border("│")}`);
			return;
		}

		const prefixText = "› ";
		const prefixWidth = visibleWidth(prefixText);
		const editorWidth = Math.max(1, cellWidth - prefixWidth);
		const editorLines = this.renderInlineEditor?.(editorWidth) ?? [item.text];
		for (const [index, editorLine] of editorLines.entries()) {
			const prefix = index === 0 ? this.theme.fg(color, prefixText) : " ".repeat(prefixWidth);
			lines.push(`${border("│")} ${fitCell(`${prefix}${editorLine}`, cellWidth)} ${border("│")}`);
		}
		const notes: string[] = [];
		if (item.removed) notes.push(`removed on save · ${REMOVE_ROW_KEY} undoes`);
		else if (item.movedLane) notes.push(`moves here on save · ${TOGGLE_LANE_KEY} undoes`);
		if (item.command && !item.removed) notes.push(`command row · runs when idle`);
		if (item.images.length > 0) {
			notes.push(`${item.images.length} image${item.images.length === 1 ? "" : "s"} preserved`);
		}
		for (const note of notes) {
			lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", `${" ".repeat(prefixWidth)}↳ ${note}`), cellWidth)} ${border("│")}`);
		}
	}

	invalidate(): void {}
}

function userContent(item: QueuedMessage<ImageContent>): string | (TextContent | ImageContent)[] {
	if (item.images.length === 0) return item.text;
	return [{ type: "text", text: item.text }, ...item.images];
}

export default function queueSteerExtension(pi: ExtensionAPI) {
	const queue = new DeliveryQueue<ImageContent>();
	let editSession: QueueEditSession<ImageContent> | undefined;
	let activeContext: ExtensionContext | undefined;
	let renderInlineEditor: InlineEditorRenderer | undefined;
	let editorInstallTimer: ReturnType<typeof setTimeout> | undefined;
	let renderingInline = false;
	let paused = false;
	let settingsManager: SettingsManager | undefined;
	// True while a queued /compact (or a just-dispatched /reload) is executing;
	// suspends all lane dispatch until the command completes.
	let commandRunning = false;
	// Pi's own editor submit handler, captured by the submit guard. Replaying text
	// through it is the only public route to the built-in /reload.
	let tuiSubmit: ((text: string) => void) | undefined;

	const queueModes = (): QueueModes => ({
		steer: settingsManager?.getSteeringMode() ?? "one-at-a-time",
		followUp: settingsManager?.getFollowUpMode() ?? "one-at-a-time",
	});

	const laneIsHeld = (lane: QueueLane): boolean => {
		if (!editSession) return false;
		const mode = queueModes()[lane];
		if (mode === "all") return editSession.touchesLane(queue, lane);
		const head = queue.peek(lane);
		return !!head && editSession.touches(head.id);
	};

	/**
	 * Queue rows with session drafts applied, in visual timeline order.
	 *
	 * Rows keep their FIFO position; rows re-laned in the current session
	 * preview at their destination lane's tail, matching where commit puts
	 * them. Held flags follow dispatch truth: they reflect each row's
	 * *committed* lane, so an uncommitted lane draft never changes delivery.
	 */
	const timelineItems = (): TimelineItem[] => {
		const modes = queueModes();
		const heldLane: Record<QueueLane, boolean> = {
			steer: laneIsHeld("steer"),
			followUp: laneIsHeld("followUp"),
		};
		const heads: Record<QueueLane, string | undefined> = {
			steer: queue.peek("steer")?.id,
			followUp: queue.peek("followUp")?.id,
		};
		const decorated = queue.snapshot().map((item): TimelineItem => {
			const lane = editSession?.laneFor(item.id) ?? item.lane;
			const text = editSession?.textFor(item.id) ?? item.text;
			return {
				...item,
				text,
				images: editSession?.imagesFor(item.id) ?? item.images,
				lane,
				removed: editSession?.isRemoved(item.id) ?? false,
				movedLane: lane !== item.lane,
				held: heldLane[item.lane] && (modes[item.lane] === "all" || heads[item.lane] === item.id),
				command: parseQueuedCommand(text),
			};
		});
		return [
			...decorated.filter((item) => item.lane === "steer" && !item.movedLane),
			...decorated.filter((item) => item.lane === "steer" && item.movedLane),
			...decorated.filter((item) => item.lane === "followUp" && !item.movedLane),
			...decorated.filter((item) => item.lane === "followUp" && item.movedLane),
		];
	};

	const renderQueue = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		if (queue.length === 0) paused = false;
		if (ctx.mode !== "tui" || queue.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		const items = timelineItems();
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => new QueueTimelineWidget({
				items,
				editingId: editSession?.selectedId,
				renderInlineEditor,
				paused,
				modes: queueModes(),
				theme,
			}),
		);
	};

	// Message rows only; command rows never dispatch at active-run boundaries.
	// A command row at the lane head holds everything behind it (FIFO) until the
	// agent settles and dispatchFromIdle executes it.
	const takeLaneBatch = (lane: QueueLane): QueuedMessage<ImageContent>[] => {
		if (paused || commandRunning || queue.laneLength(lane) === 0 || laneIsHeld(lane)) return [];
		const isMessage = (item: QueuedMessage<ImageContent>) => parseQueuedCommand(item.text) === undefined;
		if (queueModes()[lane] === "all") return queue.shiftWhile(lane, isMessage);
		const head = queue.peek(lane);
		if (!head || !isMessage(head)) return [];
		const item = queue.shift(lane);
		return item ? [item] : [];
	};

	const deliverBatchToNativeQueue = async (
		ctx: ExtensionContext,
		lane: QueueLane,
		items: QueuedMessage<ImageContent>[],
	): Promise<boolean> => {
		if (items.length === 0) return false;
		const pendingBefore = ctx.hasPendingMessages();
		renderQueue(ctx);
		try {
			for (const item of items) {
				pi.sendUserMessage(userContent(item), { deliverAs: lane });
			}
			// sendUserMessage is fire-and-forget. Keep the awaited boundary
			// handler open until async input preflight reaches Pi's native queue.
			for (let attempt = 0; attempt < 5 && !ctx.hasPendingMessages(); attempt += 1) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
			if (!pendingBefore && !ctx.hasPendingMessages()) {
				throw new Error("Pi did not accept the queued message at this delivery boundary");
			}
			return true;
		} catch (error) {
			queue.prependMany(items);
			renderQueue(ctx);
			ctx.ui.notify(
				`Could not deliver queued ${laneLabel(lane)}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	};

	const dispatchLaneAtBoundary = async (ctx: ExtensionContext, lane: QueueLane): Promise<boolean> => {
		activeContext = ctx;
		const items = takeLaneBatch(lane);
		if (items.length === 0) {
			renderQueue(ctx);
			return false;
		}
		return deliverBatchToNativeQueue(ctx, lane, items);
	};

	// Execute the command row at the lane head. Only called when the agent is idle.
	const executeCommandRow = (ctx: ExtensionContext, lane: QueueLane): boolean => {
		const next = queue.shift(lane);
		if (!next) return false;
		const command = parseQueuedCommand(next.text);
		if (!command) {
			queue.prepend(next);
			return false;
		}
		paused = false;
		renderQueue(ctx);
		if (command.kind === "compact") {
			commandRunning = true;
			ctx.ui.notify(`Running queued /compact${command.instructions ? ` (${command.instructions})` : ""}`, "info");
			const resume = () => {
				commandRunning = false;
				const current = activeContext ?? ctx;
				renderQueue(current);
				if (!paused && !editSession && queue.length > 0 && current.isIdle()) dispatchFromIdle(current);
			};
			ctx.compact({
				customInstructions: command.instructions,
				onComplete: resume,
				onError: (error) => {
					(activeContext ?? ctx).ui.notify(`Queued /compact failed: ${error.message}`, "error");
					resume();
				},
			});
			return true;
		}
		const submit = tuiSubmit;
		if (!submit) {
			ctx.ui.notify("Queued /reload dropped: no interactive editor to run it through", "error");
			renderQueue(ctx);
			return false;
		}
		if (queue.length > 0) {
			const stash: ReloadStash = {
				at: Date.now(),
				rows: queue.snapshot().map((item) => ({ lane: item.lane, text: item.text, images: item.images })),
			};
			globalStore[RELOAD_STASH_KEY] = stash;
		}
		commandRunning = true;
		// Defer so the extension runtime is never torn down from inside this handler.
		setTimeout(() => submit("/reload"), 0);
		return true;
	};

	const dispatchFromIdle = (ctx: ExtensionContext): boolean => {
		activeContext = ctx;
		if (commandRunning) {
			renderQueue(ctx);
			return false;
		}
		const lane: QueueLane | undefined = queue.laneLength("steer") > 0
			? "steer"
			: queue.laneLength("followUp") > 0
				? "followUp"
				: undefined;
		if (!lane || laneIsHeld(lane)) {
			renderQueue(ctx);
			return false;
		}
		const head = queue.peek(lane);
		if (head && parseQueuedCommand(head.text)) return executeCommandRow(ctx, lane);
		const next = queue.shift(lane);
		if (!next) return false;
		paused = false;
		renderQueue(ctx);
		try {
			pi.sendUserMessage(userContent(next));
			return true;
		} catch (error) {
			queue.prepend(next);
			renderQueue(ctx);
			ctx.ui.notify(
				`Could not send queued ${laneLabel(lane)}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	};

	const sendFollowUpNow = (ctx: ExtensionContext): boolean => {
		const head = queue.peek("followUp");
		if (!head) return false;
		const headCommand = parseQueuedCommand(head.text);
		if (headCommand) {
			if (commandRunning || !ctx.isIdle()) {
				ctx.ui.notify(`Queued /${headCommand.kind} runs when the agent is idle`, "info");
				return false;
			}
			return executeCommandRow(ctx, "followUp");
		}
		const next = queue.shift("followUp");
		if (!next) return false;
		renderQueue(ctx);
		try {
			pi.sendUserMessage(userContent(next), ctx.isIdle() ? undefined : { deliverAs: "steer" });
			return true;
		} catch (error) {
			queue.prepend(next);
			renderQueue(ctx);
			ctx.ui.notify(
				`Could not send queued follow-up: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	};

	const finishEditing = (
		ctx: ExtensionContext,
		save: boolean,
		text = ctx.ui.getEditorText(),
		images?: readonly ImageContent[],
	): void => {
		const session = editSession;
		if (!session) return;
		const result = save ? session.commit(queue, text, images) : undefined;

		editSession = undefined;
		ctx.ui.setEditorText(session.composerDraft);
		if (result?.removed) {
			ctx.ui.notify(`Removed ${result.removed} queued message${result.removed === 1 ? "" : "s"}`, "info");
		}
		if (result?.moved) {
			ctx.ui.notify(`Moved ${result.moved} queued message${result.moved === 1 ? "" : "s"} to the other lane`, "info");
		}
		renderQueue(ctx);

		// A pinned head may have let the agent settle while it was edited.
		if (ctx.isIdle() && !paused) dispatchFromIdle(ctx);
	};

	const selectQueueItem = (ctx: ExtensionContext, direction: "previous" | "next"): void => {
		activeContext = ctx;
		if (queue.length === 0) {
			ctx.ui.notify("No queued messages to edit", "info");
			return;
		}

		if (!editSession) {
			const composerDraft = ctx.ui.getEditorText();
			const selectedId = queue.mostRecentId();
			const selected = selectedId ? queue.get(selectedId) : undefined;
			if (!selected) return;
			editSession = new QueueEditSession(selected, composerDraft);
			ctx.ui.setEditorText(selected.text);
			renderQueue(ctx);
			return;
		}

		// Navigate the visual timeline so movement matches what is on screen
		// even while a lane draft previews a row inside the other box.
		const session = editSession;
		const ordered = timelineItems();
		const currentText = ctx.ui.getEditorText();
		const index = ordered.findIndex((item) => item.id === session.selectedId);
		const selectedId = direction === "previous"
			? index <= 0
				? ordered.at(-1)?.id
				: ordered[index - 1]?.id
			: index === -1 || index === ordered.length - 1
				? ordered[0]?.id
				: ordered[index + 1]?.id;
		const selected = selectedId ? queue.get(selectedId) : undefined;
		if (!selected) return;
		const selectedText = session.select(selected, currentText);
		ctx.ui.setEditorText(selectedText);
		renderQueue(ctx);
	};

	const installEditor = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;

		const previousFactory = ctx.ui.getEditorComponent();
		const features = editorFeatures(previousFactory);
		if (features.has(QUEUE_STEER_FEATURE)) return;

		const factory = ((tui, theme, keybindings) => {
			const editor = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			installSubmitGuard(editor, ctx);
			const handleInput = editor.handleInput.bind(editor);
			const renderEditor = editor.render.bind(editor);
			const isShowingAutocomplete = (): boolean => {
				const candidate = editor as typeof editor & { isShowingAutocomplete?: () => boolean };
				return candidate.isShowingAutocomplete?.() ?? false;
			};

			renderInlineEditor = (width: number): string[] => {
				renderingInline = true;
				try {
					const candidate = editor as typeof editor & { getPaddingX?: () => number };
					const paddingX = candidate.getPaddingX?.() ?? 0;
					return extractInlineEditorLines(renderEditor(width), paddingX);
				} finally {
					renderingInline = false;
				}
			};

			editor.render = (width: number): string[] => {
				if (editSession && !renderingInline) return [];
				return renderEditor(width);
			};

			editor.handleInput = (data: string): void => {
				if (editSession) {
					if (keybindings.matches(data, "app.message.dequeue")) {
						selectQueueItem(ctx, "previous");
						return;
					}
					if (matchesKey(data, NEXT_ROW_KEY)) {
						selectQueueItem(ctx, "next");
						return;
					}
					if (matchesKey(data, REMOVE_ROW_KEY)) {
						editSession.toggleRemoved(editSession.selectedId);
						renderQueue(ctx);
						return;
					}
					if (matchesKey(data, TOGGLE_LANE_KEY)) {
						editSession.toggleLane(editSession.selectedId);
						renderQueue(ctx);
						return;
					}
					if (keybindings.matches(data, "app.interrupt") && !isShowingAutocomplete()) {
						finishEditing(ctx, false);
						return;
					}
					if (keybindings.matches(data, "app.message.followUp")) {
						finishEditing(ctx, true);
						return;
					}
					if (keybindings.matches(data, "tui.input.submit") && !isShowingAutocomplete()) {
						finishEditing(ctx, true);
						return;
					}
				}

				if (queue.length > 0 && keybindings.matches(data, "app.message.dequeue")) {
					selectQueueItem(ctx, "previous");
					return;
				}
				if (
					queue.length > 0 &&
					!ctx.isIdle() &&
					keybindings.matches(data, "app.interrupt") &&
					!isShowingAutocomplete()
				) {
					paused = true;
					ctx.abort();
					renderQueue(ctx);
					return;
				}
				if (
					queue.length > 0 &&
					!editor.getText().trim() &&
					keybindings.matches(data, "tui.input.submit")
				) {
					if (paused) {
						paused = false;
						if (ctx.isIdle()) dispatchFromIdle(ctx);
						else renderQueue(ctx);
						return;
					}
					if (queue.laneLength("followUp") > 0) {
						sendFollowUpNow(ctx);
						return;
					}
				}
				handleInput(data);
			};
			return editor;
		}) as ComposedEditorFactory;
		factory[EDITOR_FEATURES] = new Set([...features, QUEUE_STEER_FEATURE]);
		ctx.ui.setEditorComponent(factory);
		renderQueue(ctx);
	};

	/**
	 * Guard the semantic submit point against built-in command dispatch while the
	 * agent is busy: Pi's own submit handler runs built-in /compact immediately,
	 * aborting the active run. Wrapping onSubmit (after autocomplete resolution)
	 * is the only interception point that reliably sees the final submitted text.
	 */
	const installSubmitGuard = (editor: EditorComponent, ctx: ExtensionContext): void => {
		const guarded = editor as EditorComponent & { [SUBMIT_GUARD]?: boolean };
		if (guarded[SUBMIT_GUARD]) return;
		guarded[SUBMIT_GUARD] = true;
		let innerSubmit = editor.onSubmit;
		if (innerSubmit) tuiSubmit = innerSubmit;
		const wrappedSubmit = (text: string) => {
			const command = parseQueuedCommand(text);
			if (command && !editSession && (commandRunning || !ctx.isIdle())) {
				ctx.ui.notify(
					`Agent is busy — ${keyText("app.message.followUp")} queues /${command.kind} to run in follow-up order`,
					"info",
				);
				setTimeout(() => ctx.ui.setEditorText(text), 0);
				return;
			}
			innerSubmit?.(text);
		};
		Object.defineProperty(editor, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () => wrappedSubmit,
			set: (fn: ((text: string) => void) | undefined) => {
				innerSubmit = fn;
				if (fn) tuiSubmit = fn;
			},
		});
	};

	const scheduleEditorInstall = (ctx: ExtensionContext): void => {
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		editorInstallTimer = setTimeout(() => {
			editorInstallTimer = undefined;
			installEditor(ctx);
		}, 0);
	};

	pi.on("session_start", (event, ctx) => {
		activeContext = ctx;
		settingsManager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		ctx.ui.setWidget(WIDGET_ID, undefined);
		restoreReloadStash(event.reason, ctx);
		installEditor(ctx);
		scheduleEditorInstall(ctx);
		renderQueue(ctx);
	});

	// Recompose after late-installed editor chrome, such as pi-session-hud.
	pi.on("agent_start", async (_event, ctx) => {
		installEditor(ctx);
		scheduleEditorInstall(ctx);
		await settingsManager?.reload();
		renderQueue(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		activeContext = ctx;

		// Safety net for editor wrappers installed after ours: an editing submit
		// always saves in place and never changes the row's delivery lane.
		if (editSession) {
			finishEditing(ctx, true, event.text, event.images);
			return { action: "handled" };
		}

		if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
			queue.enqueue(event.streamingBehavior, event.text, event.images);
			paused = false;
			renderQueue(ctx);
			return { action: "handled" };
		}

		// Idle command submissions (e.g. alt+enter bypasses Pi's built-in dispatch)
		// would otherwise reach the LLM as text. Route them through the queue; when
		// nothing is running they execute immediately.
		if (event.streamingBehavior === undefined && parseQueuedCommand(event.text) && (ctx.isIdle() || commandRunning)) {
			queue.enqueue("followUp", event.text, event.images ?? []);
			paused = false;
			renderQueue(ctx);
			if (!commandRunning && ctx.isIdle()) dispatchFromIdle(ctx);
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	pi.on("turn_end", async (event, ctx) => {
		activeContext = ctx;
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
			if (queue.length > 0) paused = true;
			renderQueue(ctx);
			return;
		}
		if (paused) return;
		await dispatchLaneAtBoundary(ctx, "steer");
	});

	// Pi checks its native queues again after extension agent_end handlers.
	// Feeding one item (or an all-mode batch) here preserves native follow-up
	// continuation semantics without relinquishing later editable rows early.
	pi.on("agent_end", async (_event, ctx) => {
		activeContext = ctx;
		if (paused) return;
		if (queue.laneLength("steer") > 0) {
			await dispatchLaneAtBoundary(ctx, "steer");
			return;
		}
		await dispatchLaneAtBoundary(ctx, "followUp");
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeContext = ctx;
		renderQueue(ctx);
		if (!paused && !editSession && queue.length > 0 && ctx.isIdle()) dispatchFromIdle(ctx);
	});

	pi.on("session_shutdown", () => {
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		if (activeContext?.hasUI) activeContext.ui.setWidget(WIDGET_ID, undefined);
		activeContext = undefined;
		renderInlineEditor = undefined;
		editorInstallTimer = undefined;
		editSession = undefined;
		settingsManager = undefined;
		paused = false;
		commandRunning = false;
		tuiSubmit = undefined;
		queue.clear();
	});

	/** Re-adopt rows that a queued /reload parked across the runtime swap. */
	function restoreReloadStash(reason: string, ctx: ExtensionContext): void {
		const stash = globalStore[RELOAD_STASH_KEY] as ReloadStash | undefined;
		delete globalStore[RELOAD_STASH_KEY];
		if (!stash || reason !== "reload" || Date.now() - stash.at > 30_000 || stash.rows.length === 0) return;
		for (const row of stash.rows) queue.enqueue(row.lane, row.text, row.images);
		ctx.ui.notify(`Restored ${stash.rows.length} queued row${stash.rows.length === 1 ? "" : "s"} after reload`, "info");
		setTimeout(() => {
			const current = activeContext;
			if (current && !paused && !editSession && queue.length > 0 && current.isIdle()) {
				dispatchFromIdle(current);
			}
		}, 0);
	}
}
