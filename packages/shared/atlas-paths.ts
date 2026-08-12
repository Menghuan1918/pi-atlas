/**
 * Shared path helpers for pi-atlas extension storage.
 *
 * All pi-atlas data lives under `~/.pi/atlas/`, organized by session:
 *   `~/.pi/atlas/sessions/<sessionId>/<extension>/...`
 *
 * Override the base directory via the `PI_ATLAS_DIR` environment variable
 * (primarily for testing). Default: `~/.pi/atlas/` — sibling of `~/.pi/agent/`.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";

/** Env var name for overriding the atlas base directory. */
export const ENV_ATLAS_DIR = "PI_ATLAS_DIR";

/**
 * Get the base directory for all pi-atlas storage: `~/.pi/atlas/`.
 *
 * Uses `PI_ATLAS_DIR` env var if set. Default: sibling of `~/.pi/agent/`.
 */
export function getAtlasDir(): string {
  const envDir = process.env[ENV_ATLAS_DIR];
  if (envDir) return envDir;
  return join(dirname(getAgentDir()), "atlas");
}

/**
 * Get the per-session storage directory: `~/.pi/atlas/sessions/<sessionId>/`.
 */
export function getAtlasSessionDir(sessionId: string): string {
  return join(getAtlasDir(), "sessions", sessionId);
}

/**
 * Get the directory for sub-agent session files (isolated from pi's session store).
 *
 * Sub-agent sessions are stored under the task extension's directory so they are
 * never discovered by pi's `/resume` picker (which only scans `~/.pi/agent/sessions/`).
 *
 *   `~/.pi/atlas/sessions/<sessionId>/task/sub-sessions/`
 */
export function getAgentSessionDir(sessionId: string): string {
  return join(getAtlasSessionDir(sessionId), "task", "sub-sessions");
}

/**
 * Get the path to the global model-tiers config file.
 *
 *   `~/.pi/atlas/model-tiers.json`
 *
 * Maps `model_tier` values ("fast" | "quality") to pi model patterns.
 * Created on first use via auto-detection (`pi --list-models`).
 */
export function getModelTiersPath(): string {
  return join(getAtlasDir(), "model-tiers.json");
}

/**
 * Get the path to the global Feishu notification config file.
 *
 *   `~/.pi/atlas/notify.json`
 *
 * Holds the webhook URL/secret, the button jump base URL, and an enabled flag.
 * Global (not per-session) — webhook credentials don't change per session. The
 * per-session `sessionId` is read from the event context at notify time.
 */
export function getNotifyConfigPath(): string {
  return join(getAtlasDir(), "notify.json");
}
