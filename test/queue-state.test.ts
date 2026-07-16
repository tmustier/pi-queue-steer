import assert from "node:assert/strict";
import test from "node:test";
import queueSteerExtension from "../index.ts";
import { FollowUpEditSession, FollowUpQueue } from "../queue-state.ts";

test("dispatches follow-ups in FIFO order", () => {
	const queue = new FollowUpQueue<string>();
	queue.enqueue("first", ["one.png"]);
	queue.enqueue("second");

	assert.deepEqual(queue.peek(), {
		id: "follow-up-1",
		text: "first",
		images: ["one.png"],
	});
	assert.deepEqual(queue.shift(), {
		id: "follow-up-1",
		text: "first",
		images: ["one.png"],
	});
	assert.equal(queue.shift()?.text, "second");
	assert.equal(queue.length, 0);
});

test("edits one item without changing its position", () => {
	const queue = new FollowUpQueue();
	const first = queue.enqueue("first");
	queue.enqueue("second");

	assert.equal(queue.update(first.id, "first, edited"), true);
	assert.deepEqual(queue.snapshot().map((item) => item.text), ["first, edited", "second"]);
});

test("cycles upward from the item nearest the editor", () => {
	const queue = new FollowUpQueue();
	const first = queue.enqueue("first");
	const second = queue.enqueue("second");
	const third = queue.enqueue("third");

	assert.equal(queue.previousId(), third.id);
	assert.equal(queue.previousId(third.id), second.id);
	assert.equal(queue.previousId(second.id), first.id);
	assert.equal(queue.previousId(first.id), third.id);
});

test("restores a failed dispatch at the front", () => {
	const queue = new FollowUpQueue();
	queue.enqueue("first");
	queue.enqueue("second");
	const first = queue.shift();
	assert.ok(first);
	queue.prepend(first);

	assert.deepEqual(queue.snapshot().map((item) => item.text), ["first", "second"]);
});

test("edit sessions preserve queue state until commit and can be discarded", () => {
	const queue = new FollowUpQueue();
	const item = queue.enqueue("original");
	const edit = new FollowUpEditSession(item, "composer draft");

	edit.capture("unsaved change");
	assert.equal(queue.get(item.id)?.text, "original");
	assert.equal(edit.composerDraft, "composer draft");
});

test("edit sessions commit cycled drafts at their stable positions", () => {
	const queue = new FollowUpQueue();
	const first = queue.enqueue("first");
	const second = queue.enqueue("second");
	const edit = new FollowUpEditSession(second, "");

	edit.select(first, "second, edited");
	assert.equal(edit.textFor(second.id), "second, edited");
	assert.equal(queue.get(second.id)?.text, "second");
	edit.commit(queue, "first, edited");

	assert.deepEqual(queue.snapshot().map((item) => item.text), ["first, edited", "second, edited"]);
});

class MockEditor {
	private text = "";
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
		this.onChange?.(text);
	}

	handleInput(_data: string): void {}

	render(width: number): string[] {
		const border = "─".repeat(width);
		return [border, this.text.slice(0, width).padEnd(width), border];
	}

	invalidate(): void {}
}

function createHarness() {
	type Handler = (event: any, context: any) => any;
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ content: unknown; options: unknown }> = [];
	let idle = false;
	let activeEditor = new MockEditor();
	let currentFactory: any = () => activeEditor;
	let widget: unknown;

	const keybindings = {
		matches(data: string, action: string): boolean {
			return (
				(data === "enter" && action === "tui.input.submit") ||
				(data === "alt-enter" && action === "app.message.followUp") ||
				(data === "alt-up" && action === "app.message.dequeue") ||
				(data === "escape" && action === "app.interrupt")
			);
		},
	};

	const ui = {
		getEditorComponent: () => currentFactory,
		setEditorComponent(factory: any) {
			currentFactory = factory;
			activeEditor = factory({}, {}, keybindings);
		},
		getEditorText: () => activeEditor.getText(),
		setEditorText: (text: string) => activeEditor.setText(text),
		setWidget(_id: string, value: unknown) {
			widget = value;
		},
		notify() {},
	};

	const context = {
		mode: "tui",
		hasUI: true,
		ui,
		isIdle: () => idle,
	};

	const pi = {
		on(name: string, handler: Handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		sendUserMessage(content: unknown, options?: unknown) {
			sent.push({ content, options });
		},
	};

	queueSteerExtension(pi as any);

	const emit = async (name: string, event: any = {}): Promise<any[]> => {
		const results = [];
		for (const handler of handlers.get(name) ?? []) {
			results.push(await handler(event, context));
		}
		return results;
	};

	return {
		emit,
		sent,
		get editor() {
			return activeEditor;
		},
		get widget() {
			return widget;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		replaceEditor(editor = new MockEditor()) {
			ui.setEditorComponent(() => editor);
		},
	};
}

async function enqueue(harness: ReturnType<typeof createHarness>, text: string): Promise<void> {
	await harness.emit("input", {
		source: "interactive",
		text,
		streamingBehavior: "followUp",
	});
}

test("editing-mode Enter saves in place instead of sending the row directly", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "original");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("edited");
	harness.editor.handleInput("enter");
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.editor.getText(), "");

	harness.editor.handleInput("enter");
	assert.equal(harness.sent.length, 1);
	assert.equal(harness.sent[0]?.content, "edited");
});

test("the selected row becomes the editor without opening nested chrome", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "first");
	await enqueue(harness, "second");

	harness.editor.handleInput("alt-up");
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const component = widgetFactory({}, {
		fg: (_color: string, text: string) => text,
	});
	const rendered = component.render(60).join("\n");

	assert.match(rendered, /│ › second\s+│/);
	assert.match(rendered, /│ ○ first\s+│/);
	assert.doesNotMatch(rendered, /editing this queued follow-up/);
	assert.equal(rendered.split("\n").filter((line) => line.includes("────")).length, 2);
});

test("cycling moves the live editor marker and leaves the previous draft in its row", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "first");
	await enqueue(harness, "second");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("second, edited");
	harness.editor.handleInput("alt-up");
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const rendered = widgetFactory({}, { fg: (_color: string, text: string) => text }).render(60).join("\n");

	assert.match(rendered, /│ › first\s+│/);
	assert.match(rendered, /│ ○ second, edited\s+│/);
});

test("recomposes after another extension installs editor chrome on a later tick", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "original");
	await harness.emit("agent_start");

	// Simulate an editor extension's deferred session_start install winning the
	// current tick. queue-steer's own deferred pass should wrap it again.
	harness.replaceEditor();
	await new Promise((resolve) => setTimeout(resolve, 5));
	harness.editor.handleInput("alt-up");

	assert.equal(harness.editor.getText(), "original");
});

test("Escape rolls back an inline queue edit", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "original");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("discard me");
	harness.editor.handleInput("escape");
	harness.editor.handleInput("enter");

	assert.equal(harness.sent[0]?.content, "original");
});

test("FIFO waits while the first row is being edited, then resumes after save", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "first");
	await enqueue(harness, "second");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("alt-up");
	harness.editor.setText("first, edited");
	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);

	harness.editor.handleInput("enter");
	assert.equal(harness.sent[0]?.content, "first, edited");
});

test("editing a later row does not block FIFO dispatch of the first row", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "first");
	await enqueue(harness, "second");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("second, edited");
	harness.setIdle(true);
	await harness.emit("agent_settled");

	assert.equal(harness.sent.length, 1);
	assert.equal(harness.sent[0]?.content, "first");
	assert.equal(harness.editor.getText(), "second, edited");
});
