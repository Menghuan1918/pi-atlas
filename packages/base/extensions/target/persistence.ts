/**
 * Persistence layer for the Target extension.
 *
 * State is persisted under `~/.pi/atlas/sessions/<sessionId>/target/`:
 *   - `state.json` — the full TargetState for the session
 *
 * Writes are atomic: data is written to a temp file then renamed.
 *
 * The read path (`loadTargetState` / types / normalization) lives in
 * `@pi-atlas/shared/target-state.js` and is re-exported here so the compact
 * extension (same package) keeps importing from `./persistence.js`.
 */

import { join } from "node:path";
import {
  atomicWrite,
  ensureDir,
  getTargetDir,
  type TargetState,
} from "@pi-atlas/shared/target-state.js";

// Re-export the shared read path for consumers inside the base package.
export {
  getTargetDir,
  getStatePath,
  loadTargetState,
} from "@pi-atlas/shared/target-state.js";

const STATE_FILE = "state.json";

/**
 * Per-session write serialization.
 *
 * Read-modify-write calls are serialized per session to avoid losing data
 * when multiple tool calls fire in the same turn.
 */
const writeLocks = new Map<string, Promise<void>>();

function withWriteLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(
    sessionId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Persist the full target state for a session (atomic write).
 */
export async function saveTargetState(
  sessionId: string,
  state: TargetState,
): Promise<void> {
  await withWriteLock(sessionId, async () => {
    const dir = getTargetDir(sessionId);
    await ensureDir(dir);
    const filePath = join(dir, STATE_FILE);
    const data = JSON.stringify({ sessionId, state }, null, 2);
    await atomicWrite(filePath, data);
  });
}
