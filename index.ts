import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	keyText,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { extractInlineEditorLines } from "./editor-render.ts";
import { FollowUpEditSession, FollowUpQueue, type QueuedFollowUp } from "./queue-state.ts";

const WIDGET_ID = "queue-steer.follow-ups";
const EDITOR_FEATURES = Symbol.for("@tmustier/pi-editor-features");
const QUEUE_STEER_FEATURE = "queue-steer";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type ComposedEditorFactory = EditorFactory & { [EDITOR_FEATURES]?: ReadonlySet<string> };
type InlineEditorRenderer = (width: number) => string[];

function editorFeatures(factory: EditorFactory | undefined): ReadonlySet<string> {
	return (factory as ComposedEditorFactory | undefined)?.[EDITOR_FEATURES] ?? new Set();
}

function compactText(item: QueuedFollowUp<ImageContent>): string {
	const text = item.text.replace(/\s+/g, " ").trim();
	const imageNote = item.images.length > 0 ? ` [${item.images.length} image${item.images.length === 1 ? "" : "s"}]` : "";
	return `${text || "[image follow-up]"}${imageNote}`;
}

function fitCell(content: string, width: number): string {
	const clipped = truncateToWidth(content, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

class FollowUpWidget implements Component {
	private readonly items: QueuedFollowUp<ImageContent>[];
	private readonly editingId: string | undefined;
	private readonly renderInlineEditor: InlineEditorRenderer | undefined;
	private readonly theme: Theme;

	constructor(
		items: QueuedFollowUp<ImageContent>[],
		editingId: string | undefined,
		renderInlineEditor: InlineEditorRenderer | undefined,
		theme: Theme,
	) {
		this.items = items;
		this.editingId = editingId;
		this.renderInlineEditor = renderInlineEditor;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (width < 12) {
			return [truncateToWidth(this.theme.fg("warning", `follow-ups (${this.items.length})`), width, "")];
		}

		const border = (text: string) => this.theme.fg("warning", text);
		const title = ` follow-ups (${this.items.length}) `;
		const topFill = "─".repeat(Math.max(0, width - title.length - 2));
		const lines = [border(`┌${title}${topFill}┐`)];
		const cellWidth = width - 4;

		for (const item of this.items) {
			const selected = item.id === this.editingId;
			if (!selected) {
				const raw = `○ ${compactText(item)}`;
				lines.push(`${border("│")} ${fitCell(this.theme.fg("muted", raw), cellWidth)} ${border("│")}`);
				continue;
			}

			const editorWidth = Math.max(1, cellWidth - 2);
			const editorLines = this.renderInlineEditor?.(editorWidth) ?? [item.text];
			for (const [index, editorLine] of editorLines.entries()) {
				const marker = index === 0 ? this.theme.fg("accent", "› ") : "  ";
				lines.push(`${border("│")} ${fitCell(`${marker}${editorLine}`, cellWidth)} ${border("│")}`);
			}
			if (item.images.length > 0) {
				const imageNote = `${item.images.length} image${item.images.length === 1 ? "" : "s"} preserved`;
				lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", `  ↳ ${imageNote}`), cellWidth)} ${border("│")}`);
			}
		}

		const dequeue = keyText("app.message.dequeue");
		const followUp = keyText("app.message.followUp");
		const submit = keyText("tui.input.submit");
		const interrupt = keyText("app.interrupt");
		const help = this.editingId
			? `${dequeue} previous · ${submit}/${followUp} save · ${interrupt} cancel`
			: `${submit} send next now · ${dequeue} select/edit · ${followUp} queue`;
		lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", help), cellWidth)} ${border("│")}`);
		lines.push(border(`└${"─".repeat(width - 2)}┘`));
		return lines;
	}

	invalidate(): void {}
}

function userContent(item: QueuedFollowUp<ImageContent>): string | (TextContent | ImageContent)[] {
	if (item.images.length === 0) return item.text;
	return [{ type: "text", text: item.text }, ...item.images];
}

export default function queueSteerExtension(pi: ExtensionAPI) {
	const queue = new FollowUpQueue<ImageContent>();
	let editSession: FollowUpEditSession<ImageContent> | undefined;
	let activeContext: ExtensionContext | undefined;
	let renderInlineEditor: InlineEditorRenderer | undefined;
	let editorInstallTimer: ReturnType<typeof setTimeout> | undefined;
	let renderingInline = false;

	const renderQueue = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		if (ctx.mode !== "tui" || queue.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		const items = queue.snapshot().map((item) => {
			const draftText = editSession?.textFor(item.id);
			return draftText === undefined ? item : { ...item, text: draftText };
		});
		const editingId = editSession?.selectedId;
		const inlineRenderer = renderInlineEditor;
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => new FollowUpWidget(items, editingId, inlineRenderer, theme),
		);
	};

	const dispatchFirst = (ctx: ExtensionContext): boolean => {
		activeContext = ctx;
		const first = queue.peek();
		if (!first || editSession?.touches(first.id)) {
			renderQueue(ctx);
			return false;
		}

		const next = queue.shift();
		if (!next) return false;
		renderQueue(ctx);

		try {
			if (ctx.isIdle()) {
				pi.sendUserMessage(userContent(next));
			} else {
				pi.sendUserMessage(userContent(next), { deliverAs: "steer" });
			}
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
		if (save) session.commit(queue, text, images);

		editSession = undefined;
		ctx.ui.setEditorText(session.composerDraft);
		renderQueue(ctx);

		// FIFO dispatch may have paused because the first row was being edited.
		if (ctx.isIdle()) dispatchFirst(ctx);
	};

	const selectPreviousFollowUp = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		if (queue.length === 0) {
			ctx.ui.notify("No queued follow-ups to edit", "info");
			return;
		}

		if (!editSession) {
			const composerDraft = ctx.ui.getEditorText();
			if (composerDraft.trim()) {
				ctx.ui.notify("Send or clear the current draft before editing queued follow-ups", "warning");
				return;
			}

			const selectedId = queue.previousId();
			const selected = selectedId ? queue.get(selectedId) : undefined;
			if (!selected) return;
			editSession = new FollowUpEditSession(selected, composerDraft);
			ctx.ui.setEditorText(selected.text);
			renderQueue(ctx);
			return;
		}

		const currentText = ctx.ui.getEditorText();
		const selectedId = queue.previousId(editSession.selectedId);
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
						selectPreviousFollowUp(ctx);
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
					selectPreviousFollowUp(ctx);
					return;
				}
				if (
					queue.length > 0 &&
					!editor.getText().trim() &&
					keybindings.matches(data, "tui.input.submit")
				) {
					dispatchFirst(ctx);
					return;
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
		// Remove any widget instance left by a pre-reload copy before recomposing.
		ctx.ui.setWidget(WIDGET_ID, undefined);
		installEditor(ctx);
		scheduleEditorInstall(ctx);
		renderQueue(ctx);
	});

	// Recompose after late-installed editor chrome, such as pi-session-hud.
	pi.on("agent_start", (_event, ctx) => {
		installEditor(ctx);
		scheduleEditorInstall(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		activeContext = ctx;

		// Safety net for editor wrappers installed after ours: an editing submit
		// always saves in place and never changes the queued row's delivery mode.
		if (editSession) {
			finishEditing(ctx, true, event.text, event.images);
			return { action: "handled" };
		}

		if (event.streamingBehavior === "followUp") {
			queue.enqueue(event.text, event.images);
			renderQueue(ctx);
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.isIdle() || queue.length === 0) return;
		activeContext = ctx;
		dispatchFirst(ctx);
	});

	pi.on("session_shutdown", () => {
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		if (activeContext?.hasUI) activeContext.ui.setWidget(WIDGET_ID, undefined);
		activeContext = undefined;
		renderInlineEditor = undefined;
		editorInstallTimer = undefined;
		editSession = undefined;
		queue.clear();
	});
}
