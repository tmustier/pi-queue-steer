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
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { extractInlineEditorLines } from "./editor-render.ts";
import {
	DeliveryQueue,
	QueueEditSession,
	type QueuedMessage,
	type QueueLane,
} from "./queue-state.ts";

const WIDGET_ID = "queue-steer.timeline";
const EDITOR_FEATURES = Symbol.for("@tmustier/pi-editor-features");
const QUEUE_STEER_FEATURE = "queue-steer";
const NEXT_ROW_KEY = "alt+down";

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

class QueueTimelineWidget implements Component {
	private readonly items: QueuedMessage<ImageContent>[];
	private readonly editingId: string | undefined;
	private readonly touchedIds: ReadonlySet<string>;
	private readonly renderInlineEditor: InlineEditorRenderer | undefined;
	private readonly paused: boolean;
	private readonly modes: QueueModes;
	private readonly theme: Theme;

	constructor(options: {
		items: QueuedMessage<ImageContent>[];
		editingId: string | undefined;
		touchedIds: ReadonlySet<string>;
		renderInlineEditor: InlineEditorRenderer | undefined;
		paused: boolean;
		modes: QueueModes;
		theme: Theme;
	}) {
		this.items = options.items;
		this.editingId = options.editingId;
		this.touchedIds = options.touchedIds;
		this.renderInlineEditor = options.renderInlineEditor;
		this.paused = options.paused;
		this.modes = options.modes;
		this.theme = options.theme;
	}

	render(width: number): string[] {
		const steering = this.items.filter((item) => item.lane === "steer");
		const followUps = this.items.filter((item) => item.lane === "followUp");
		if (width < 28) {
			const summary = `queued S${steering.length} F${followUps.length}${this.paused ? " paused" : ""}`;
			return [truncateToWidth(this.theme.fg("borderMuted", summary), width, "")];
		}

		const border = (text: string) => this.theme.fg("borderMuted", text);
		const counts = `${steering.length} steering · ${followUps.length} follow-up`;
		const fullTitle = ` queued (${counts})${this.paused ? " · paused" : ""} `;
		const shortTitle = ` queued S${steering.length} F${followUps.length}${this.paused ? " paused" : ""} `;
		const title = visibleWidth(fullTitle) + 2 <= width ? fullTitle : shortTitle;
		const topFill = "─".repeat(Math.max(0, width - visibleWidth(title) - 2));
		const lines = [border(`┌${title}${topFill}┐`)];
		const cellWidth = width - 4;

		for (const item of steering) this.renderItem(lines, item, steering, cellWidth, border);
		if (steering.length > 0 && followUps.length > 0) {
			lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", "─ after this run ─"), cellWidth)} ${border("│")}`);
		}
		for (const item of followUps) this.renderItem(lines, item, followUps, cellWidth, border);

		const dequeue = keyText("app.message.dequeue");
		const followUp = keyText("app.message.followUp");
		const submit = keyText("tui.input.submit");
		const interrupt = keyText("app.interrupt");
		const help = this.editingId
			? `${dequeue}/${nextRowKeyText()} move · ${submit}/${followUp} save · ${interrupt} cancel`
			: this.paused
				? `${submit} resume · ${dequeue} edit · ${interrupt} keep paused`
				: `${submit} steer/send next · ${followUp} follow-up · ${dequeue} edit`;
		lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", help), cellWidth)} ${border("│")}`);
		lines.push(border(`└${"─".repeat(width - 2)}┘`));
		return lines;
	}

	private renderItem(
		lines: string[],
		item: QueuedMessage<ImageContent>,
		laneItems: QueuedMessage<ImageContent>[],
		cellWidth: number,
		border: (text: string) => string,
	): void {
		const selected = item.id === this.editingId;
		const head = laneItems[0]?.id === item.id;
		const laneTouched = laneItems.some((candidate) => this.touchedIds.has(candidate.id));
		const held = this.modes[item.lane] === "all" ? laneTouched : head && this.touchedIds.has(item.id);
		const armed = this.modes[item.lane] === "all" || head;
		const status = held ? " [held]" : this.paused && armed ? " [paused]" : "";
		const label = `${laneLabel(item.lane)}${status}`;
		const color = laneColor(item.lane);

		if (!selected) {
			const marker = held || (this.paused && armed)
				? "⏸"
				: item.lane === "followUp"
					? "○"
					: armed
						? "▶"
						: "»";
			const prefix = `${marker} ${label.padEnd(12)} `;
			const raw = `${this.theme.fg(color, prefix)}${compactText(item)}`;
			lines.push(`${border("│")} ${fitCell(raw, cellWidth)} ${border("│")}`);
			return;
		}

		const prefixText = `› ${label} `;
		const prefixWidth = visibleWidth(prefixText);
		const editorWidth = Math.max(1, cellWidth - prefixWidth);
		const editorLines = this.renderInlineEditor?.(editorWidth) ?? [item.text];
		for (const [index, editorLine] of editorLines.entries()) {
			const prefix = index === 0 ? this.theme.fg(color, prefixText) : " ".repeat(prefixWidth);
			lines.push(`${border("│")} ${fitCell(`${prefix}${editorLine}`, cellWidth)} ${border("│")}`);
		}
		if (item.images.length > 0) {
			const imageNote = `${item.images.length} image${item.images.length === 1 ? "" : "s"} preserved`;
			lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", `${" ".repeat(prefixWidth)}↳ ${imageNote}`), cellWidth)} ${border("│")}`);
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

	const renderQueue = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		if (queue.length === 0) paused = false;
		if (ctx.mode !== "tui" || queue.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		const items = queue.snapshot().map((item) => {
			const draftText = editSession?.textFor(item.id);
			const draftImages = editSession?.imagesFor(item.id);
			return {
				...item,
				text: draftText ?? item.text,
				images: draftImages ?? item.images,
			};
		});
		const touchedIds = new Set(items.filter((item) => editSession?.touches(item.id)).map((item) => item.id));
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => new QueueTimelineWidget({
				items,
				editingId: editSession?.selectedId,
				touchedIds,
				renderInlineEditor,
				paused,
				modes: queueModes(),
				theme,
			}),
		);
	};

	const takeLaneBatch = (lane: QueueLane): QueuedMessage<ImageContent>[] => {
		if (paused || queue.laneLength(lane) === 0 || laneIsHeld(lane)) return [];
		if (queueModes()[lane] === "all") return queue.shiftAll(lane);
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

	const dispatchFromIdle = (ctx: ExtensionContext): boolean => {
		activeContext = ctx;
		const lane: QueueLane | undefined = queue.laneLength("steer") > 0
			? "steer"
			: queue.laneLength("followUp") > 0
				? "followUp"
				: undefined;
		if (!lane || laneIsHeld(lane)) {
			renderQueue(ctx);
			return false;
		}
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
			ctx.ui.notify(`Removed ${result.removed} empty queued message${result.removed === 1 ? "" : "s"}`, "info");
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

		const currentText = ctx.ui.getEditorText();
		const selectedId = direction === "previous"
			? queue.previousId(editSession.selectedId)
			: queue.nextId(editSession.selectedId);
		const selected = selectedId ? queue.get(selectedId) : undefined;
		if (!selected) return;
		const selectedText = editSession.select(selected, currentText);
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

	const scheduleEditorInstall = (ctx: ExtensionContext): void => {
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		editorInstallTimer = setTimeout(() => {
			editorInstallTimer = undefined;
			installEditor(ctx);
		}, 0);
	};

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		settingsManager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		ctx.ui.setWidget(WIDGET_ID, undefined);
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
		queue.clear();
	});
}
