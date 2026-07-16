export type QueueLane = "steer" | "followUp";

export interface QueuedMessage<TImage = unknown> {
	id: string;
	lane: QueueLane;
	text: string;
	images: TImage[];
	sequence: number;
}

/**
 * Two independent FIFOs presented as one delivery-ordered timeline.
 *
 * Steering rows always appear before follow-ups because Pi consumes that lane
 * first. Sequence is global so queue editing can enter at the most recently
 * enqueued row even when that row sits in the middle of the visual timeline.
 */
export class DeliveryQueue<TImage = unknown> {
	private items: QueuedMessage<TImage>[] = [];
	private nextIdNumber = 1;
	private nextSequence = 1;

	enqueue(lane: QueueLane, text: string, images: readonly TImage[] = []): QueuedMessage<TImage> {
		const prefix = lane === "steer" ? "steer" : "follow-up";
		const item = {
			id: `${prefix}-${this.nextIdNumber++}`,
			lane,
			text,
			images: [...images],
			sequence: this.nextSequence++,
		};
		this.items.push(item);
		return this.copy(item);
	}

	prepend(item: QueuedMessage<TImage>): void {
		const firstInLane = this.items.findIndex((candidate) => candidate.lane === item.lane);
		if (firstInLane === -1) this.items.push(this.copy(item));
		else this.items.splice(firstInLane, 0, this.copy(item));
	}

	prependMany(items: readonly QueuedMessage<TImage>[]): void {
		for (let index = items.length - 1; index >= 0; index -= 1) {
			const item = items[index];
			if (item) this.prepend(item);
		}
	}

	update(id: string, text: string, images?: readonly TImage[]): boolean {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item) return false;
		item.text = text;
		if (images) item.images = [...images];
		return true;
	}

	remove(id: string): QueuedMessage<TImage> | undefined {
		const index = this.items.findIndex((item) => item.id === id);
		if (index === -1) return undefined;
		const [item] = this.items.splice(index, 1);
		return item ? this.copy(item) : undefined;
	}

	peek(lane: QueueLane): QueuedMessage<TImage> | undefined {
		const item = this.items.find((candidate) => candidate.lane === lane);
		return item ? this.copy(item) : undefined;
	}

	shift(lane: QueueLane): QueuedMessage<TImage> | undefined {
		const index = this.items.findIndex((item) => item.lane === lane);
		if (index === -1) return undefined;
		const [item] = this.items.splice(index, 1);
		return item ? this.copy(item) : undefined;
	}

	shiftAll(lane: QueueLane): QueuedMessage<TImage>[] {
		const removed = this.items.filter((item) => item.lane === lane).map((item) => this.copy(item));
		this.items = this.items.filter((item) => item.lane !== lane);
		return removed;
	}

	get(id: string): QueuedMessage<TImage> | undefined {
		const item = this.items.find((candidate) => candidate.id === id);
		return item ? this.copy(item) : undefined;
	}

	previousId(currentId?: string): string | undefined {
		const ordered = this.snapshot();
		if (ordered.length === 0) return undefined;
		if (!currentId) return this.mostRecentId();
		const index = ordered.findIndex((item) => item.id === currentId);
		if (index <= 0) return ordered.at(-1)?.id;
		return ordered[index - 1]?.id;
	}

	nextId(currentId?: string): string | undefined {
		const ordered = this.snapshot();
		if (ordered.length === 0) return undefined;
		if (!currentId) return this.mostRecentId();
		const index = ordered.findIndex((item) => item.id === currentId);
		if (index === -1 || index === ordered.length - 1) return ordered[0]?.id;
		return ordered[index + 1]?.id;
	}

	mostRecentId(): string | undefined {
		let newest: QueuedMessage<TImage> | undefined;
		for (const item of this.items) {
			if (!newest || item.sequence > newest.sequence) newest = item;
		}
		return newest?.id;
	}

	laneSnapshot(lane: QueueLane): QueuedMessage<TImage>[] {
		return this.items.filter((item) => item.lane === lane).map((item) => this.copy(item));
	}

	snapshot(): QueuedMessage<TImage>[] {
		return [...this.laneSnapshot("steer"), ...this.laneSnapshot("followUp")];
	}

	laneLength(lane: QueueLane): number {
		return this.items.filter((item) => item.lane === lane).length;
	}

	get length(): number {
		return this.items.length;
	}

	clear(): void {
		this.items = [];
	}

	private copy(item: QueuedMessage<TImage>): QueuedMessage<TImage> {
		return { ...item, images: [...item.images] };
	}
}

interface QueuedMessageDraft<TImage> {
	id: string;
	text: string;
	images: TImage[];
}

export interface EditCommitResult {
	updated: number;
	removed: number;
}

/** Rollback-safe drafts spanning rows from either delivery lane. */
export class QueueEditSession<TImage = unknown> {
	private readonly drafts = new Map<string, QueuedMessageDraft<TImage>>();
	private currentId: string;
	readonly composerDraft: string;

	constructor(item: QueuedMessage<TImage>, composerDraft: string) {
		this.currentId = item.id;
		this.composerDraft = composerDraft;
		this.drafts.set(item.id, { id: item.id, text: item.text, images: [...item.images] });
	}

	get selectedId(): string {
		return this.currentId;
	}

	get selectedText(): string {
		return this.drafts.get(this.currentId)?.text ?? "";
	}

	capture(text: string, images?: readonly TImage[]): void {
		const draft = this.drafts.get(this.currentId);
		if (!draft) return;
		draft.text = text;
		if (images) draft.images = [...images];
	}

	select(item: QueuedMessage<TImage>, currentText: string, images?: readonly TImage[]): string {
		this.capture(currentText, images);
		if (!this.drafts.has(item.id)) {
			this.drafts.set(item.id, { id: item.id, text: item.text, images: [...item.images] });
		}
		this.currentId = item.id;
		return this.selectedText;
	}

	touches(id: string): boolean {
		return this.drafts.has(id);
	}

	touchesLane(queue: DeliveryQueue<TImage>, lane: QueueLane): boolean {
		return queue.laneSnapshot(lane).some((item) => this.touches(item.id));
	}

	textFor(id: string): string | undefined {
		return this.drafts.get(id)?.text;
	}

	imagesFor(id: string): TImage[] | undefined {
		const images = this.drafts.get(id)?.images;
		return images ? [...images] : undefined;
	}

	commit(
		queue: DeliveryQueue<TImage>,
		currentText: string,
		images?: readonly TImage[],
	): EditCommitResult {
		this.capture(currentText, images);
		let updated = 0;
		let removed = 0;
		for (const draft of this.drafts.values()) {
			if (!draft.text.trim() && draft.images.length === 0) {
				if (queue.remove(draft.id)) removed += 1;
				continue;
			}
			if (queue.update(draft.id, draft.text, draft.images)) updated += 1;
		}
		return { updated, removed };
	}
}
