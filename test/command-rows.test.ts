import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryQueue, parseQueuedCommand, type QueuedMessage } from "../queue-state.ts";

test("parses /compact with and without instructions", () => {
	assert.deepEqual(parseQueuedCommand("/compact"), { kind: "compact" });
	assert.deepEqual(parseQueuedCommand("  /compact  "), { kind: "compact" });
	assert.deepEqual(parseQueuedCommand("/compact keep the API notes"), {
		kind: "compact",
		instructions: "keep the API notes",
	});
	assert.deepEqual(parseQueuedCommand("/compact   "), { kind: "compact" });
});

test("parses /reload exactly", () => {
	assert.deepEqual(parseQueuedCommand("/reload"), { kind: "reload" });
	assert.deepEqual(parseQueuedCommand(" /reload "), { kind: "reload" });
	assert.equal(parseQueuedCommand("/reload now"), undefined);
});

test("does not treat messages or other commands as command rows", () => {
	assert.equal(parseQueuedCommand("continue"), undefined);
	assert.equal(parseQueuedCommand("/compactor settings"), undefined);
	assert.equal(parseQueuedCommand("/model"), undefined);
	assert.equal(parseQueuedCommand("please /compact later"), undefined);
	assert.equal(parseQueuedCommand(""), undefined);
});

test("shiftWhile stops at the first rejected row and preserves FIFO", () => {
	const queue = new DeliveryQueue<string>();
	queue.enqueue("followUp", "one");
	queue.enqueue("followUp", "two");
	queue.enqueue("followUp", "/compact");
	queue.enqueue("followUp", "three");
	queue.enqueue("steer", "steer one");

	const isMessage = (item: QueuedMessage<string>) => parseQueuedCommand(item.text) === undefined;
	const batch = queue.shiftWhile("followUp", isMessage);

	assert.deepEqual(batch.map((item) => item.text), ["one", "two"]);
	assert.deepEqual(
		queue.snapshot().map((item) => [item.lane, item.text]),
		[
			["steer", "steer one"],
			["followUp", "/compact"],
			["followUp", "three"],
		],
	);
});

test("shiftWhile with a command head takes nothing", () => {
	const queue = new DeliveryQueue<string>();
	queue.enqueue("followUp", "/compact focus on tests");
	queue.enqueue("followUp", "continue");

	const isMessage = (item: QueuedMessage<string>) => parseQueuedCommand(item.text) === undefined;
	assert.deepEqual(queue.shiftWhile("followUp", isMessage), []);
	assert.equal(queue.laneLength("followUp"), 2);
});

test("shiftWhile drains a lane with no command rows", () => {
	const queue = new DeliveryQueue<string>();
	queue.enqueue("steer", "a");
	queue.enqueue("steer", "b");
	queue.enqueue("followUp", "later");

	const isMessage = (item: QueuedMessage<string>) => parseQueuedCommand(item.text) === undefined;
	assert.deepEqual(queue.shiftWhile("steer", isMessage).map((item) => item.text), ["a", "b"]);
	assert.equal(queue.laneLength("steer"), 0);
	assert.equal(queue.laneLength("followUp"), 1);
});
