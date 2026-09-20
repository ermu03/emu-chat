export class StreamedAssistantCache {
  private readonly contentByRun = new Map<string, string>();
  private readonly lastSequenceByRun = new Map<string, number>();

  get(runId: string): string {
    return this.contentByRun.get(runId) ?? "";
  }

  append(runId: string, sequence: number | null, delta: string): string | null {
    if (
      sequence !== null &&
      sequence <= (this.lastSequenceByRun.get(runId) ?? 0)
    ) {
      return null;
    }
    if (sequence !== null) this.lastSequenceByRun.set(runId, sequence);

    const content = this.get(runId) + delta;
    this.contentByRun.set(runId, content);
    return content;
  }

  clear(runId: string): void {
    this.contentByRun.delete(runId);
    this.lastSequenceByRun.delete(runId);
  }
}
