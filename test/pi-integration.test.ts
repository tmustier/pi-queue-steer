import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import queueSteerExtension from "../index.ts";

type CompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;
type AgentStartEvent = Extract<AgentSessionEvent, { type: "agent_start" }>;

interface IntegrationHarness {
	session: AgentSession;
	faux: FauxProviderHandle;
	cleanup(): Promise<void>;
}

function nextCompactionEnd(session: AgentSession): Promise<CompactionEndEvent> {
	return new Promise((resolve) => {
		let unsubscribe: (() => void) | undefined;
		unsubscribe = session.subscribe((event) => {
			if (event.type !== "compaction_end") return;
			unsubscribe?.();
			resolve(event);
		});
	});
}

function nextAgentStart(session: AgentSession): Promise<AgentStartEvent> {
	return new Promise((resolve) => {
		let unsubscribe: (() => void) | undefined;
		unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_start") return;
			unsubscribe?.();
			resolve(event);
		});
	});
}

function nextAgentRun(session: AgentSession): Promise<void> {
	return new Promise((resolve) => {
		let started = false;
		let unsubscribe: (() => void) | undefined;
		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") {
				started = true;
				return;
			}
			if (event.type !== "agent_settled" || !started) return;
			unsubscribe?.();
			resolve();
		});
	});
}

async function within<T>(promise: Promise<T>, detail: () => string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out: ${detail()}`)), 2_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function userTexts(session: AgentSession): string[] {
	return session.messages
		.filter((message) => message.role === "user")
		.map((message) => {
			if (typeof message.content === "string") return message.content;
			return message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		});
}

async function createIntegrationHarness(options: {
	contextWindow?: number;
	maxTokens?: number;
	extraExtensions?: ExtensionFactory[];
	retryEnabled?: boolean;
} = {}): Promise<IntegrationHarness> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-integration-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	const faux = fauxProvider({
		models: [{
			id: "queue-integration",
			contextWindow: options.contextWindow ?? 100_000,
			maxTokens: options.maxTokens ?? 1_000,
		}],
	});
	const model = faux.getModel();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
		retry: options.retryEnabled
			? { enabled: true, maxRetries: 2, baseDelayMs: 1 }
			: { enabled: false },
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const providerExtension: ExtensionFactory = (pi) => {
		pi.registerProvider(model.provider, {
			name: "Faux integration provider",
			baseUrl: model.baseUrl,
			apiKey: "integration-test-key",
			api: model.api,
			streamSimple: faux.provider.streamSimple,
			models: [{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			}],
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [providerExtension, queueSteerExtension, ...(options.extraExtensions ?? [])],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		settingsManager,
		sessionManager,
		resourceLoader,
		noTools: "all",
	});
	await session.bindExtensions({ mode: "tui" });
	return {
		session,
		faux,
		async cleanup() {
			// Let the extension's public-API editor recomposition timer settle
			// before invalidating its session context.
			await new Promise((resolve) => setTimeout(resolve, 5));
			session.dispose();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function gatedResponse(
	content: string,
	options?: Parameters<typeof fauxAssistantMessage>[1],
): {
	step: () => Promise<ReturnType<typeof fauxAssistantMessage>>;
	release(): void;
} {
	let releaseGate: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	return {
		step: async () => {
			await gate;
			return fauxAssistantMessage(content, options);
		},
		release() {
			releaseGate?.();
		},
	};
}

async function seedSession(harness: IntegrationHarness): Promise<void> {
	harness.faux.setResponses([
		fauxAssistantMessage("seed response one"),
		fauxAssistantMessage("seed response two"),
	]);
	await harness.session.prompt("seed one");
	await harness.session.prompt("seed two");
}

test("real AgentSession runs a queued manual compaction before the following row", async () => {
	const harness = await createIntegrationHarness();
	try {
		await seedSession(harness);
		const active = gatedResponse("active response");
		harness.faux.setResponses([
			active.step,
			fauxAssistantMessage("manual summary"),
			fauxAssistantMessage("manual split-turn summary"),
			fauxAssistantMessage("response after compaction"),
		]);
		const activeStarted = nextAgentStart(harness.session);
		const activePrompt = harness.session.prompt("active prompt");
		await within(activeStarted, () => "manual compaction agent did not start");
		await harness.session.prompt("/compact preserve integration evidence", { streamingBehavior: "followUp" });
		await harness.session.prompt("after manual compaction", { streamingBehavior: "followUp" });
		const compactionEnded = nextCompactionEnd(harness.session);
		const resumed = nextAgentRun(harness.session);
		active.release();
		await activePrompt;

		const compaction = await within(compactionEnded, () => "manual compaction did not finish");
		assert.equal(compaction.reason, "manual");
		assert.equal(compaction.result?.summary.includes("manual summary"), true);
		await within(resumed, () => "post-compaction row did not run");
		assert.equal(userTexts(harness.session).at(-1), "after manual compaction");
		assert.equal(userTexts(harness.session).filter((text) => text === "after manual compaction").length, 1);
		assert.equal(harness.session.getLastAssistantText(), "response after compaction");
		assert.equal(harness.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
	} finally {
		await harness.cleanup();
	}
});

test("real failed manual compaction releases the following row without adding a compaction entry", async () => {
	const harness = await createIntegrationHarness();
	try {
		await seedSession(harness);
		const active = gatedResponse("active response");
		harness.faux.setResponses([
			active.step,
			() => {
				throw new Error("synthetic summary failure");
			},
			fauxAssistantMessage("response after failed compaction"),
		]);
		const activeStarted = nextAgentStart(harness.session);
		const activePrompt = harness.session.prompt("active before failure");
		await within(activeStarted, () => "failed-compaction agent did not start");
		await harness.session.prompt("/compact", { streamingBehavior: "followUp" });
		await harness.session.prompt("after failed compaction", { streamingBehavior: "followUp" });
		const compactionEnded = nextCompactionEnd(harness.session);
		const resumed = nextAgentRun(harness.session);
		active.release();
		await activePrompt;

		const compaction = await within(compactionEnded, () => "failed compaction did not finish");
		assert.equal(compaction.reason, "manual");
		assert.match(compaction.errorMessage ?? "", /synthetic summary failure/);
		await within(resumed, () => "row after failed compaction did not run");
		assert.equal(userTexts(harness.session).filter((text) => text === "after failed compaction").length, 1);
		assert.equal(harness.session.getLastAssistantText(), "response after failed compaction");
		assert.equal(harness.session.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
	} finally {
		await harness.cleanup();
	}
});

test("real retry finishes before the extension releases its queued follow-up", async () => {
	const harness = await createIntegrationHarness({ retryEnabled: true });
	try {
		const trace: string[] = [];
		harness.session.subscribe((event) => trace.push(event.type));
		const failed = gatedResponse("", {
			stopReason: "error",
			errorMessage: "rate limit exceeded",
		});
		harness.faux.setResponses([
			failed.step,
			fauxAssistantMessage("retry succeeded"),
			fauxAssistantMessage("queued follow-up succeeded"),
		]);
		const started = nextAgentStart(harness.session);
		const prompt = harness.session.prompt("retry original");
		await within(started, () => trace.join(", "));
		await harness.session.prompt("after retry", { streamingBehavior: "followUp" });
		failed.release();
		await within(prompt, () => trace.join(", "));

		assert.ok(trace.includes("auto_retry_start"));
		assert.ok(trace.includes("auto_retry_end"));
		assert.equal(userTexts(harness.session).filter((text) => text === "after retry").length, 1);
		assert.equal(harness.session.getLastAssistantText(), "queued follow-up succeeded");
	} finally {
		await harness.cleanup();
	}
});

test("real public prompt path triggers overflow compaction and preserves a queued follow-up", async () => {
	const summaryExtension: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", (event) => {
			if (event.reason !== "overflow") return;
			return {
				compaction: {
					summary: "overflow integration summary",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { source: "integration-test" },
				},
			};
		});
	};
	const harness = await createIntegrationHarness({
		contextWindow: 1_000,
		maxTokens: 100,
		extraExtensions: [summaryExtension],
	});
	try {
		const trace: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				trace.push(`${event.type}:${event.message.stopReason}:${event.message.errorMessage ?? ""}`);
				return;
			}
			trace.push(event.type);
		});
		const active = gatedResponse("partial response");
		harness.faux.setResponses([
			active.step,
			fauxAssistantMessage("completed queued follow-up"),
		]);
		const activeStarted = nextAgentStart(harness.session);
		const compactionEnded = nextCompactionEnd(harness.session);
		const prompt = harness.session.prompt("x".repeat(20_000));
		await within(activeStarted, () => trace.join(", "));
		await harness.session.prompt("queued across overflow", { streamingBehavior: "followUp" });
		const queuedRun = new Promise<void>((resolve) => {
			let matched = false;
			let unsubscribe: (() => void) | undefined;
			unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "user") {
					const text = typeof event.message.content === "string"
						? event.message.content
						: event.message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
					if (text === "queued across overflow") matched = true;
					return;
				}
				if (event.type !== "agent_settled" || !matched) return;
				unsubscribe?.();
				resolve();
			});
		});
		active.release();
		await within(prompt, () => trace.join(", "));

		const compaction = await within(compactionEnded, () => trace.join(", "));
		await within(queuedRun, () => trace.join(", "));
		assert.equal(compaction.reason, "overflow");
		assert.equal(compaction.willRetry, false);
		assert.equal(compaction.result?.summary, "overflow integration summary");
		assert.equal(userTexts(harness.session).filter((text) => text === "queued across overflow").length, 1);
		assert.equal(harness.faux.state.callCount, 2);
		assert.equal(harness.session.getLastAssistantText(), "completed queued follow-up");
	} finally {
		await harness.cleanup();
	}
});
