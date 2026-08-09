import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
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
import { expandQueuedInput, queuesDuringCompaction } from "./queued-input.ts";
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
const SUBMIT_GUARD = Symbol.for("@tmustier/pi-queue-steer.submit-guard");

/** Queue state parked on globalThis across Pi's in-process runtime swap. */
interface ReloadStash {
	paused: boolean;
	rows: QueuedMessage<ImageContent>[];
}
declare global {
	var __tmustierPiQueueSteerReloadStash: ReloadStash | undefined;
}
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

function itemCommand(item: Pick<QueuedMessage<ImageContent>, "text" | "images">): QueuedCommand | undefined {
	if (item.images.length > 0) return undefined;
	return parseQueuedCommand(item.text);
}

export default function queueSteerExtension(pi: ExtensionAPI) {
	const queue = new DeliveryQueue<ImageContent>();
	let editSession: QueueEditSession<ImageContent> | undefined;
	let activeContext: ExtensionContext | undefined;
	let renderInlineEditor: InlineEditorRenderer | undefined;
	let editorInstallTimer: ReturnType<typeof setTimeout> | undefined;
	let baseEditorFactory: EditorFactory | undefined;
	let baseEditorFactoryCaptured = false;
	let reloadSubmitTimer: ReturnType<typeof setTimeout> | undefined;
	let renderingInline = false;
	let paused = false;
	let settingsManager: SettingsManager | undefined;
	let blockingActivity: "compact" | "auto-compact" | "reload" | undefined;
	let compactionFinishTimer: ReturnType<typeof setTimeout> | undefined;
	let nativeCompactionInputQueued = false;
	let nativeCompactionTurnStarted = false;
	const isCompacting = (): boolean => blockingActivity === "compact" || blockingActivity === "auto-compact";
	const trackNativeCompactionSubmission = (
		text: string,
		behavior: "submit" | "followUp" = "submit",
	): void => {
		if (isCompacting() && queuesDuringCompaction(text, pi.getCommands(), behavior)) {
			nativeCompactionInputQueued = true;
		}
	};
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
			const images = editSession?.imagesFor(item.id) ?? item.images;
			return {
				...item,
				text,
				images,
				lane,
				removed: editSession?.isRemoved(item.id) ?? false,
				movedLane: lane !== item.lane,
				held: heldLane[item.lane] && (modes[item.lane] === "all" || heads[item.lane] === item.id),
				command: itemCommand({ text, images }),
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
		if (paused || blockingActivity || laneIsHeld(lane)) return [];
		const isMessage = (item: QueuedMessage<ImageContent>) => itemCommand(item) === undefined;
		if (queueModes()[lane] === "all") return queue.shiftWhile(lane, isMessage);
		const head = queue.peek(lane);
		if (!head || !isMessage(head)) return [];
		const item = queue.shift(lane);
		return item ? [item] : [];
	};

	const deliverMessages = (
		ctx: ExtensionContext,
		lane: QueueLane,
		items: readonly QueuedMessage<ImageContent>[],
		deliverAs?: QueueLane,
	): void => {
		let prepared: QueuedMessage<ImageContent>[];
		try {
			const commands = pi.getCommands();
			prepared = items.map((item) => ({ ...item, text: expandQueuedInput(item.text, commands) }));
		} catch (error) {
			queue.prependMany(items);
			paused = true;
			renderQueue(ctx);
			ctx.ui.notify(
				`Could not prepare queued ${laneLabel(lane)}; queue paused: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		renderQueue(ctx);
		for (const item of prepared) {
			pi.sendUserMessage(userContent(item), deliverAs ? { deliverAs } : undefined);
		}
	};

	const dispatchLaneAtBoundary = (ctx: ExtensionContext, lane: QueueLane): void => {
		activeContext = ctx;
		const items = takeLaneBatch(lane);
		if (items.length === 0) {
			renderQueue(ctx);
			return;
		}
		deliverMessages(ctx, lane, items, lane);
	};

	// Execute the command row at the lane head. Only called when the agent is idle.
	const executeCommandRow = (ctx: ExtensionContext, lane: QueueLane): void => {
		const next = queue.peek(lane);
		if (!next) return;
		const command = itemCommand(next);
		if (!command) return;
		const submit = tuiSubmit;
		if (command.kind === "reload" && !submit) {
			paused = true;
			renderQueue(ctx);
			ctx.ui.notify("Could not run queued /reload; queue paused because no interactive submit handler is available", "error");
			return;
		}
		queue.shift(lane);
		paused = false;
		renderQueue(ctx);
		if (command.kind === "compact") {
			startCompaction(ctx, command.instructions);
			return;
		}
		blockingActivity = "reload";
		// Defer so the extension runtime is never torn down from inside this handler.
		reloadSubmitTimer = setTimeout(() => {
			reloadSubmitTimer = undefined;
			submit?.("/reload");
		}, 0);
	};

	const sendHeadMessage = (ctx: ExtensionContext, lane: QueueLane, deliverAs?: QueueLane): void => {
		const head = queue.shift(lane);
		if (!head) return;
		paused = false;
		deliverMessages(ctx, lane, [head], deliverAs);
	};

	const dispatchFromIdle = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		if (blockingActivity) {
			renderQueue(ctx);
			return;
		}
		const lane: QueueLane | undefined = queue.laneLength("steer") > 0
			? "steer"
			: queue.laneLength("followUp") > 0
				? "followUp"
				: undefined;
		if (!lane || laneIsHeld(lane)) {
			renderQueue(ctx);
			return;
		}
		const head = queue.peek(lane);
		if (head && itemCommand(head)) {
			executeCommandRow(ctx, lane);
			return;
		}
		sendHeadMessage(ctx, lane);
	};

	const deferCompactionFinish = (
		ctx: ExtensionContext,
		activity: "compact" | "auto-compact",
	): void => {
		compactionFinishTimer = setTimeout(() => {
			compactionFinishTimer = undefined;
			if (blockingActivity !== activity) return;
			// Pi flushes ordinary TUI submissions after compaction without
			// awaiting prompt preflight. Keep command rows behind that native run.
			if (nativeCompactionInputQueued) {
				renderQueue(activeContext ?? ctx);
				return;
			}
			blockingActivity = undefined;
			nativeCompactionInputQueued = false;
			nativeCompactionTurnStarted = false;
			const current = activeContext ?? ctx;
			renderQueue(current);
			if (!paused && !editSession && queue.length > 0 && current.isIdle()) dispatchFromIdle(current);
		}, 0);
	};

	const startCompaction = (ctx: ExtensionContext, instructions: string | undefined): void => {
		blockingActivity = "compact";
		nativeCompactionInputQueued = false;
		nativeCompactionTurnStarted = false;
		ctx.compact({
			customInstructions: instructions,
			onComplete: () => {
				if (!nativeCompactionInputQueued) deferCompactionFinish(ctx, "compact");
			},
			onError: () => {
				if (!nativeCompactionInputQueued) deferCompactionFinish(ctx, "compact");
			},
		});
	};

	const deferCommand = (ctx: ExtensionContext, text: string): void => {
		queue.enqueue("followUp", text);
		paused = false;
		renderQueue(ctx);
	};

	const sendFollowUpNow = (ctx: ExtensionContext): void => {
		const head = queue.peek("followUp");
		if (!head) return;
		const headCommand = itemCommand(head);
		if (headCommand) {
			if (blockingActivity === "reload" || !ctx.isIdle()) {
				ctx.ui.notify(`Queued /${headCommand.kind} runs when the agent is idle`, "info");
				return;
			}
			executeCommandRow(ctx, "followUp");
			return;
		}
		sendHeadMessage(ctx, "followUp", ctx.isIdle() ? undefined : "steer");
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
		if (ctx.isIdle() && !paused && !blockingActivity) dispatchFromIdle(ctx);
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

				if (keybindings.matches(data, "app.message.followUp")) {
					const text = (editor.getExpandedText?.() ?? editor.getText()).trim();
					if (isCompacting() && parseQueuedCommand(text)) {
						deferCommand(ctx, text);
						editor.addToHistory?.(text);
						editor.setText("");
						return;
					}
					trackNativeCompactionSubmission(text, "followUp");
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
					if (isCompacting()) {
						ctx.ui.notify("Queued messages will run after compaction finishes", "info");
						return;
					}
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
		// Preserve the factory from before this runtime's first wrapper. A later
		// unmarked composer may itself close over our wrapper; restoring that on
		// reload would carry stale submit guards into the replacement runtime.
		if (!baseEditorFactoryCaptured) {
			baseEditorFactory = previousFactory;
			baseEditorFactoryCaptured = true;
		}
		ctx.ui.setEditorComponent(factory);
		renderQueue(ctx);
	};

	const installSubmitGuard = (editor: EditorComponent, ctx: ExtensionContext): void => {
		const guarded = editor as EditorComponent & { [SUBMIT_GUARD]?: boolean };
		if (guarded[SUBMIT_GUARD]) return;
		guarded[SUBMIT_GUARD] = true;
		let innerSubmit = editor.onSubmit;
		if (innerSubmit) tuiSubmit = innerSubmit;
		const wrappedSubmit = (text: string) => {
			const command = parseQueuedCommand(text);
			if (!editSession && command && isCompacting()) {
				deferCommand(ctx, text);
				editor.addToHistory?.(text);
				editor.setText("");
				return;
			}
			if (command?.kind === "compact" && !editSession) {
				editor.addToHistory?.(text);
				editor.setText("");
				startCompaction(ctx, command.instructions);
				return;
			}
			if (command?.kind === "reload" && !editSession && (blockingActivity === "reload" || !ctx.isIdle())) {
				queue.enqueue("followUp", text, []);
				paused = false;
				renderQueue(ctx);
				return;
			}
			if (!editSession) trackNativeCompactionSubmission(text);
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
		if (ctx.mode !== "tui" || event.source !== "interactive") return { action: "continue" };
		activeContext = ctx;

		// Safety net for editor wrappers installed after ours: an editing submit
		// always saves in place and never changes the row's delivery lane.
		if (editSession) {
			finishEditing(ctx, true, event.text, event.images);
			return { action: "handled" };
		}

		const command = parseQueuedCommand(event.text);
		if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
			queue.enqueue(event.streamingBehavior, event.text, event.images);
			paused = false;
			renderQueue(ctx);
			return { action: "handled" };
		}

		// Alt+Enter can bypass Pi's built-in command dispatch while idle.
		if (event.streamingBehavior === undefined && command && (event.images?.length ?? 0) === 0 && ctx.isIdle()) {
			queue.enqueue("followUp", event.text, event.images ?? []);
			paused = false;
			renderQueue(ctx);
			dispatchFromIdle(ctx);
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	pi.on("session_before_compact", (event, ctx) => {
		activeContext = ctx;
		if (blockingActivity || event.reason === "manual") return;
		blockingActivity = "auto-compact";
		nativeCompactionInputQueued = false;
		nativeCompactionTurnStarted = false;
		renderQueue(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		activeContext = ctx;
		if (isCompacting() && nativeCompactionInputQueued) nativeCompactionTurnStarted = true;
	});

	pi.on("turn_end", (event, ctx) => {
		activeContext = ctx;
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
			if (queue.length > 0 && blockingActivity !== "compact") paused = true;
			renderQueue(ctx);
			return;
		}
		if (paused) return;
		dispatchLaneAtBoundary(ctx, "steer");
	});

	// Pi checks its native queues again after extension agent_end handlers.
	// Feeding one item (or an all-mode batch) here preserves native follow-up
	// continuation semantics without relinquishing later editable rows early.
	pi.on("agent_end", (event, ctx) => {
		activeContext = ctx;
		if (paused) return;
		const lastMessage = event.messages.at(-1);
		if (
			lastMessage?.role === "assistant"
			&& (
				lastMessage.stopReason === "length"
				|| lastMessage.stopReason === "error"
				|| isContextOverflow(lastMessage, ctx.model?.contextWindow ?? 0)
			)
		) {
			// Pi decides whether to retry or auto-compact only after agent_end.
			// Injecting a follow-up here would start it first and hide that signal.
			return;
		}
		if (queue.laneLength("steer") > 0) {
			dispatchLaneAtBoundary(ctx, "steer");
			return;
		}
		dispatchLaneAtBoundary(ctx, "followUp");
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeContext = ctx;
		if (blockingActivity === "compact" || blockingActivity === "auto-compact") {
			const activity = blockingActivity;
			if (nativeCompactionInputQueued && !nativeCompactionTurnStarted) {
				renderQueue(ctx);
				return;
			}
			// The ordinary post-compaction turn, if any, is now fully settled.
			nativeCompactionInputQueued = false;
			deferCompactionFinish(ctx, activity);
			return;
		}
		renderQueue(ctx);
		if (!paused && !editSession && queue.length > 0 && ctx.isIdle() && !blockingActivity) dispatchFromIdle(ctx);
	});

	pi.on("session_shutdown", (event) => {
		if (event.reason === "reload" && queue.length > 0) {
			const stash: ReloadStash = { paused, rows: queue.snapshot() };
			globalThis.__tmustierPiQueueSteerReloadStash = stash;
		} else {
			globalThis.__tmustierPiQueueSteerReloadStash = undefined;
		}
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		if (reloadSubmitTimer) clearTimeout(reloadSubmitTimer);
		if (compactionFinishTimer) clearTimeout(compactionFinishTimer);
		if (activeContext?.hasUI) {
			const currentFactory = activeContext.ui.getEditorComponent();
			if (
				baseEditorFactoryCaptured
				&& currentFactory
				&& editorFeatures(currentFactory).has(QUEUE_STEER_FEATURE)
			) {
				activeContext.ui.setEditorComponent(baseEditorFactory);
			}
			activeContext.ui.setWidget(WIDGET_ID, undefined);
		}
		activeContext = undefined;
		renderInlineEditor = undefined;
		editorInstallTimer = undefined;
		baseEditorFactory = undefined;
		baseEditorFactoryCaptured = false;
		reloadSubmitTimer = undefined;
		compactionFinishTimer = undefined;
		editSession = undefined;
		settingsManager = undefined;
		paused = false;
		blockingActivity = undefined;
		nativeCompactionInputQueued = false;
		nativeCompactionTurnStarted = false;
		tuiSubmit = undefined;
		queue.clear();
	});

	/** Re-adopt committed queue state after Pi's in-process runtime swap. */
	function restoreReloadStash(reason: string, ctx: ExtensionContext): void {
		const stash = globalThis.__tmustierPiQueueSteerReloadStash;
		globalThis.__tmustierPiQueueSteerReloadStash = undefined;
		if (!stash || reason !== "reload" || stash.rows.length === 0) return;
		queue.restore(stash.rows);
		paused = stash.paused;
		ctx.ui.notify(`Restored ${stash.rows.length} queued row${stash.rows.length === 1 ? "" : "s"} after reload`, "info");
		setTimeout(() => {
			const current = activeContext;
			if (current && !paused && !editSession && queue.length > 0 && current.isIdle()) {
				dispatchFromIdle(current);
			}
		}, 0);
	}
}
