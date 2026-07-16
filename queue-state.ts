export interface QueuedFollowUp<TImage = unknown> {
	id: string;
	text: string;
	images: TImage[];
}

/** Small FIFO with stable ids so a visible item can be edited while the queue advances. */
export class FollowUpQueue<TImage = unknown> {
	private items: QueuedFollowUp<TImage>[] = [];
	private nextId = 1;

	enqueue(text: string, images: readonly TImage[] = []): QueuedFollowUp<TImage> {
		const item = { id: `follow-up-${this.nextId++}`, text, images: [...images] };
		this.items.push(item);
		return this.copy(item);
	}

	prepend(item: QueuedFollowUp<TImage>): void {
		this.items.unshift(this.copy(item));
	}

	update(id: string, text: string, images?: readonly TImage[]): boolean {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item) return false;
		item.text = text;
		if (images) item.images = [...images];
		return true;
	}

	remove(id: string): QueuedFollowUp<TImage> | undefined {
		const index = this.items.findIndex((item) => item.id === id);
		if (index === -1) return undefined;
		const [item] = this.items.splice(index, 1);
		return item ? this.copy(item) : undefined;
	}

	peek(): QueuedFollowUp<TImage> | undefined {
		const item = this.items[0];
		return item ? this.copy(item) : undefined;
	}

	shift(): QueuedFollowUp<TImage> | undefined {
		const item = this.items.shift();
		return item ? this.copy(item) : undefined;
	}

	get(id: string): QueuedFollowUp<TImage> | undefined {
		const item = this.items.find((candidate) => candidate.id === id);
		return item ? this.copy(item) : undefined;
	}

	previousId(currentId?: string): string | undefined {
		if (this.items.length === 0) return undefined;
		if (!currentId) return this.items.at(-1)?.id;
		const index = this.items.findIndex((item) => item.id === currentId);
		if (index <= 0) return this.items.at(-1)?.id;
		return this.items[index - 1]?.id;
	}

	snapshot(): QueuedFollowUp<TImage>[] {
		return this.items.map((item) => this.copy(item));
	}

	get length(): number {
		return this.items.length;
	}

	clear(): void {
		this.items = [];
	}

	private copy(item: QueuedFollowUp<TImage>): QueuedFollowUp<TImage> {
		return { ...item, images: [...item.images] };
	}
}

interface QueuedFollowUpDraft<TImage> {
	id: string;
	text: string;
	images?: TImage[];
}

/**
 * Transient, rollback-safe edits for one or more queue rows.
 *
 * Cycling can visit several rows without mutating the queue. Commit applies all
 * visited drafts in place; cancel leaves the queue untouched.
 */
export class FollowUpEditSession<TImage = unknown> {
	private readonly drafts = new Map<string, QueuedFollowUpDraft<TImage>>();
	private currentId: string;
	readonly composerDraft: string;

	constructor(item: QueuedFollowUp<TImage>, composerDraft: string) {
		this.currentId = item.id;
		this.composerDraft = composerDraft;
		this.drafts.set(item.id, { id: item.id, text: item.text });
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

	select(item: QueuedFollowUp<TImage>, currentText: string, images?: readonly TImage[]): string {
		this.capture(currentText, images);
		if (!this.drafts.has(item.id)) {
			this.drafts.set(item.id, { id: item.id, text: item.text });
		}
		this.currentId = item.id;
		return this.selectedText;
	}

	touches(id: string): boolean {
		return this.drafts.has(id);
	}

	textFor(id: string): string | undefined {
		return this.drafts.get(id)?.text;
	}

	commit(queue: FollowUpQueue<TImage>, currentText: string, images?: readonly TImage[]): number {
		this.capture(currentText, images);
		let updated = 0;
		for (const draft of this.drafts.values()) {
			if (queue.update(draft.id, draft.text, draft.images)) updated += 1;
		}
		return updated;
	}
}
