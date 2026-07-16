import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import queueSteerExtension from "../index.ts";
import { DeliveryQueue, QueueEditSession, type QueueLane } from "../queue-state.ts";

test("keeps steering and follow-ups in independent FIFOs", () => {
	const queue = new DeliveryQueue<string>();
	queue.enqueue("followUp", "later one", ["one.png"]);
	queue.enqueue("steer", "steer one");
	queue.enqueue("followUp", "later two");
	queue.enqueue("steer", "steer two");

	assert.deepEqual(
		queue.snapshot().map((item) => [item.lane, item.text]),
		[
			["steer", "steer one"],
			["steer", "steer two"],
			["followUp", "later one"],
			["followUp", "later two"],
		],
	);
	assert.equal(queue.shift("steer")?.text, "steer one");
	assert.equal(queue.shift("followUp")?.text, "later one");
});

test("selects the globally most recent item before navigating spatially", () => {
	const queue = new DeliveryQueue();
	const firstSteer = queue.enqueue("steer", "steer one");
	const latestFollowUp = queue.enqueue("followUp", "later");
	const latestSteer = queue.enqueue("steer", "steer two");

	assert.equal(queue.mostRecentId(), latestSteer.id);
	assert.equal(queue.previousId(), latestSteer.id);
	assert.equal(queue.previousId(latestSteer.id), firstSteer.id);
	assert.equal(queue.nextId(latestSteer.id), latestFollowUp.id);
	assert.equal(queue.nextId(latestFollowUp.id), firstSteer.id);
});

test("edits a row without changing its stable lane position", () => {
	const queue = new DeliveryQueue();
	const first = queue.enqueue("steer", "first");
	queue.enqueue("steer", "second");

	assert.equal(queue.update(first.id, "first, edited"), true);
	assert.deepEqual(queue.laneSnapshot("steer").map((item) => item.text), ["first, edited", "second"]);
});

test("restores failed batches at the front in their original order", () => {
	const queue = new DeliveryQueue();
	queue.enqueue("followUp", "first");
	queue.enqueue("followUp", "second");
	const failed = queue.shiftAll("followUp");
	queue.enqueue("followUp", "third");
	queue.prependMany(failed);

	assert.deepEqual(queue.laneSnapshot("followUp").map((item) => item.text), ["first", "second", "third"]);
});

test("edit sessions keep cross-lane drafts private until commit", () => {
	const queue = new DeliveryQueue();
	const steer = queue.enqueue("steer", "steer original");
	const followUp = queue.enqueue("followUp", "later original");
	const edit = new QueueEditSession(followUp, "composer draft");

	edit.select(steer, "later edited");
	assert.equal(edit.textFor(followUp.id), "later edited");
	assert.equal(queue.get(followUp.id)?.text, "later original");
	edit.commit(queue, "steer edited");

	assert.deepEqual(queue.snapshot().map((item) => item.text), ["steer edited", "later edited"]);
	assert.equal(edit.composerDraft, "composer draft");
});

test("empty drafts remove text-only rows but preserve image-only rows", () => {
	const queue = new DeliveryQueue<string>();
	const textOnly = queue.enqueue("steer", "delete me");
	const imageOnly = queue.enqueue("followUp", "", ["image.png"]);

	const deleteEdit = new QueueEditSession(textOnly, "");
	assert.deepEqual(deleteEdit.commit(queue, ""), { updated: 0, removed: 1 });
	const imageEdit = new QueueEditSession(imageOnly, "");
	assert.deepEqual(imageEdit.commit(queue, ""), { updated: 1, removed: 0 });
	assert.deepEqual(queue.get(imageOnly.id)?.images, ["image.png"]);
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

function createHarness(options: { cwd?: string; projectTrusted?: boolean } = {}) {
	type Handler = (event: any, context: any) => any;
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ content: unknown; options: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let idle = false;
	let pending = false;
	let aborted = false;
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
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
	};

	const context = {
		mode: "tui",
		hasUI: true,
		cwd: options.cwd ?? "/tmp",
		ui,
		isIdle: () => idle,
		isProjectTrusted: () => options.projectTrusted ?? false,
		hasPendingMessages: () => pending,
		abort() {
			aborted = true;
		},
	};

	const pi = {
		on(name: string, handler: Handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		sendUserMessage(content: unknown, options?: unknown) {
			sent.push({ content, options });
			if (options) pending = true;
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
		notifications,
		get editor() {
			return activeEditor;
		},
		get widget() {
			return widget;
		},
		get aborted() {
			return aborted;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		clearPending() {
			pending = false;
		},
		replaceEditor(editor = new MockEditor()) {
			ui.setEditorComponent(() => editor);
		},
	};
}

async function enqueue(
	harness: ReturnType<typeof createHarness>,
	lane: QueueLane,
	text: string,
): Promise<void> {
	await harness.emit("input", {
		source: "interactive",
		text,
		streamingBehavior: lane,
	});
}

function renderWidget(harness: ReturnType<typeof createHarness>, width = 76): string {
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const component = widgetFactory({}, { fg: (_color: string, text: string) => text });
	return component.render(width).join("\n");
}

test("renders one timeline with steering before the after-this-run boundary", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "write the README");
	await enqueue(harness, "steer", "check the API first");

	const rendered = renderWidget(harness);
	assert.ok(rendered.indexOf("check the API first") < rendered.indexOf("after this run"));
	assert.ok(rendered.indexOf("after this run") < rendered.indexOf("write the README"));
	assert.match(rendered, /steer/);
	assert.match(rendered, /follow-up/);
});

test("uses compact queue chrome at narrow terminal widths", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "a long steering row that needs clipping");
	await enqueue(harness, "followUp", "a long follow-up row that needs clipping");
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const component = widgetFactory({}, { fg: (_color: string, text: string) => text });

	const narrow = component.render(30);
	assert.ok(
		narrow.every((line) => visibleWidth(line) <= 30),
		JSON.stringify(narrow.map((line) => [visibleWidth(line), line])),
	);
	assert.deepEqual(component.render(20), ["queued S1 F1"]);
});

test("injects one owned steering row at Pi's native turn boundary", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "first steer");
	await enqueue(harness, "steer", "second steer");

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], { content: "first steer", options: { deliverAs: "steer" } });
	assert.match(renderWidget(harness), /second steer/);
	assert.doesNotMatch(renderWidget(harness), /first steer/);
});

test("injects follow-ups through Pi's native continuation queue at agent_end", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "later one");
	await enqueue(harness, "followUp", "later two");

	await harness.emit("agent_end");
	assert.deepEqual(harness.sent[0], { content: "later one", options: { deliverAs: "followUp" } });
	assert.match(renderWidget(harness), /later two/);
});

test("honours Pi all-mode settings and pins the whole edited lane", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-steer-all-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ steeringMode: "all", followUpMode: "all" }),
	);
	try {
		const steering = createHarness({ cwd, projectTrusted: true });
		await steering.emit("session_start");
		await enqueue(steering, "steer", "steer one");
		await enqueue(steering, "steer", "steer two");
		steering.editor.handleInput("alt-up");
		await steering.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		assert.equal(steering.sent.length, 0);
		steering.editor.handleInput("enter");
		await steering.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		assert.deepEqual(steering.sent.map((item) => item.content), ["steer one", "steer two"]);

		const followUps = createHarness({ cwd, projectTrusted: true });
		await followUps.emit("session_start");
		await enqueue(followUps, "followUp", "later one");
		await enqueue(followUps, "followUp", "later two");
		await followUps.emit("agent_end");
		assert.deepEqual(followUps.sent.map((item) => item.content), ["later one", "later two"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Alt+Up enters at the most recently enqueued row across both lanes", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "latest later");
	await enqueue(harness, "steer", "latest overall");
	await enqueue(harness, "followUp", "newest overall");

	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "newest overall");
	assert.match(renderWidget(harness), /› follow-up newest overall/);
});

test("Alt+Up and Alt+Down navigate spatially while retaining row drafts", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "steer one");
	await enqueue(harness, "steer", "steer two");
	await enqueue(harness, "followUp", "later one");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("later one edited");
	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "steer two");
	harness.editor.handleInput("\x1b[1;3B");
	assert.equal(harness.editor.getText(), "later one edited");
});

test("queue editing stashes and restores an unrelated composer draft", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "queued row");
	harness.editor.setText("unrelated composer draft");

	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "queued row");
	harness.editor.setText("queued row edited");
	harness.editor.handleInput("enter");
	assert.equal(harness.editor.getText(), "unrelated composer draft");
});

test("editing-mode Enter saves in place without changing the delivery lane", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "original");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("edited");
	harness.editor.handleInput("enter");
	assert.equal(harness.sent.length, 0);
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], { content: "edited", options: { deliverAs: "steer" } });
});

test("Escape rolls back an inline edit and releases its pin", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "original");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("discard me");
	harness.editor.handleInput("escape");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.sent[0]?.content, "original");
});

test("editing a steering head pins it while editing a later row does not", async () => {
	const held = createHarness();
	await held.emit("session_start");
	await enqueue(held, "steer", "first");
	await enqueue(held, "steer", "second");
	held.editor.handleInput("alt-up");
	held.editor.handleInput("alt-up");
	await held.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(held.sent.length, 0);
	assert.match(renderWidget(held), /steer \[held\] first/);

	const later = createHarness();
	await later.emit("session_start");
	await enqueue(later, "steer", "first");
	await enqueue(later, "steer", "second");
	later.editor.handleInput("alt-up");
	await later.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(later.sent[0]?.content, "first");
	assert.equal(later.editor.getText(), "second");
});

test("editing a later follow-up does not block its lane head", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "first");
	await enqueue(harness, "followUp", "second");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("second edited");
	await harness.emit("agent_end");
	assert.equal(harness.sent[0]?.content, "first");
	assert.equal(harness.editor.getText(), "second edited");
});

test("abort pauses both owned lanes and empty Enter explicitly resumes", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "do not auto-send");
	harness.editor.handleInput("escape");
	assert.equal(harness.aborted, true);

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
	await harness.emit("agent_end");
	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /paused/);

	harness.editor.handleInput("enter");
	assert.equal(harness.sent[0]?.content, "do not auto-send");
});

test("empty Enter promotes the oldest follow-up to steering while busy", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "send this now");

	harness.editor.handleInput("enter");
	assert.deepEqual(harness.sent[0], { content: "send this now", options: { deliverAs: "steer" } });
});

test("clearing a selected text-only row deletes it on save", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "delete this");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("");
	harness.editor.handleInput("enter");
	assert.equal(harness.widget, undefined);
	assert.match(harness.notifications[0]?.message ?? "", /Removed 1 empty queued message/);
});

test("recomposes after another extension installs editor chrome on a later tick", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "original");
	await harness.emit("agent_start");

	harness.replaceEditor();
	await new Promise((resolve) => setTimeout(resolve, 5));
	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "original");
});
