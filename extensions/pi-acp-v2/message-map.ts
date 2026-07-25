/**
 * messageId ↔ pi entryId bidirectional mapping, plus the "before user message"
 * anchor resolver consumed by A4 (`_fork_from` / `_rewind_to`).
 *
 * A1 owns this resolver contract; A4 consumes it. The mapping lives for the
 * lifetime of an ACP session and is keyed by ACP messageId (uuid) ↔ pi entryId.
 */

/** Minimal entry shape the resolver needs (SessionEntry satisfies this). */
export interface AnchorEntry {
  id: string;
  parentId: string | null;
}

export class MessageIdMap {
  private readonly messageIdToEntry = new Map<string, string>();
  private readonly entryToMessageId = new Map<string, string>();

  /** Record the bidirectional mapping for one message. */
  record(messageId: string, entryId: string): void {
    this.messageIdToEntry.set(messageId, entryId);
    this.entryToMessageId.set(entryId, messageId);
  }

  getEntryId(messageId: string): string | undefined {
    return this.messageIdToEntry.get(messageId);
  }

  getMessageId(entryId: string): string | undefined {
    return this.entryToMessageId.get(entryId);
  }

  /**
   * Resolve the "anchor immediately before this user message" entryId.
   *
   * Per Spec §5.1: given a user message's messageId → its entryId → the entry
   * immediately before it in the active branch. Because pi sessions are an
   * append-only tree, the entry immediately before a message IS its parent.
   * The anchor may be the previous assistant turn's last entry, a preceding
   * user message (consecutive user messages), or null (root).
   *
   * @param messageId  the ACP messageId of a user message
   * @param entries    the active branch entries (getBranch / buildContextEntries)
   * @returns the parent entryId, or null if the message is the root / unknown
   */
  resolveAnchorBefore(messageId: string, entries: AnchorEntry[]): string | null {
    const entryId = this.messageIdToEntry.get(messageId);
    if (entryId === undefined) return null;
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return null;
    return entry.parentId;
  }

  /** All recorded messageIds (for diagnostics / replay). */
  get messageIds(): string[] {
    return [...this.messageIdToEntry.keys()];
  }
}
