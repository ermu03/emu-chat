export class ConversationViewCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly capacity = 12) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Conversation cache capacity must be positive");
    }
  }

  get(conversationId: string): T | undefined {
    const entry = this.entries.get(conversationId);
    if (entry === undefined) return undefined;

    this.entries.delete(conversationId);
    this.entries.set(conversationId, entry);
    return entry;
  }

  set(conversationId: string, entry: T): void {
    this.entries.delete(conversationId);
    this.entries.set(conversationId, entry);

    if (this.entries.size > this.capacity) {
      const oldestConversationId = this.entries.keys().next().value;
      if (oldestConversationId !== undefined) {
        this.entries.delete(oldestConversationId);
      }
    }
  }

  delete(conversationId: string): void {
    this.entries.delete(conversationId);
  }
}
