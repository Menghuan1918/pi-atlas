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
