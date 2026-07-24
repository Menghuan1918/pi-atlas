/**
 * Shared formatting utilities for tool outputs.
 *
 * - formatDuration: smart human-readable duration (< 60s → "12s", ≥ 60s → "2m 15s")
 */

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

/**
 * Format a duration in milliseconds as a compact, human-readable string.
 *
 * - < 60s: "12s"
 * - ≥ 60s with remainder: "2m 15s"
 * - ≥ 60s without remainder: "2m"
 *
 * Returns "0s" for durations < 500ms (avoids "0s" for sub-second tasks).
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}
