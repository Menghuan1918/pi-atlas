/**
 * Feishu (飞书) custom-bot notifications, fired from the guard extension.
 *
 * Two trigger points (see `extensions/guard/index.ts`):
 *   1. `tool_call` for the `AskUser` tool  → "waiting for input".
 *   2. `agent_settled` when no guard will inject (agent truly idle) → "session ended".
 *
 * Exclusions (notify is a no-op):
 *   - subagent sessions (`PI_ATLAS_TASK_DEPTH > 0`), and
 *   - session-end while a guard would inject (auto-continue / running tasks /
 *     aborted) — enforced by the call site in `guard/index.ts`, not here.
 *
 * Config (global, `~/.pi/atlas/notify.json`): webhookUrl / webhookSecret / webUrl / enabled.
 * Re-read on every call so edits take effect without restart. Fire-and-forget from the
 * guard: `notify` never throws and network failures only log to stderr.
 *
 * Card schema + HMAC signing mirror xbot's `~/.claude/hooks/feishu-notify.py`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { getNotifyConfigPath } from "@pi-atlas/shared/atlas-paths.js";

export interface NotifyConfig {
  enabled: boolean;
  webhookUrl: string;
  webhookSecret: string;
  webUrl: string;
}

export type NotifyType = "askUser" | "sessionEnd";

const CARD_META: Record<NotifyType, { emoji: string; title: string; template: string }> = {
  askUser: { emoji: "🔔", title: "pi 等待输入", template: "orange" },
  sessionEnd: { emoji: "✅", title: "pi 会话结束", template: "blue" },
};

/**
 * True for subagent sessions. pi-atlas spawns sub-agents via CreateAgent, which
 * sets `PI_ATLAS_TASK_DEPTH` on the child; the main session leaves it unset (depth 0).
 */
export function isSubagent(): boolean {
  const depth = parseInt(process.env.PI_ATLAS_TASK_DEPTH ?? "0", 10);
  return Number.isFinite(depth) && depth > 0;
}

/** Keep only the last two path components (mirrors xbot's `last_two_dirs`). */
function lastTwoDirs(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  if (parts.length >= 2) return parts.slice(-2).join("/");
  return cwd || "/";
}

/**
 * Load + validate the global notify config. Returns `null` (→ no notification)
 * when the file is missing/malformed, `enabled` is explicitly false, or no
 * `webhookUrl` is configured.
 */
export function loadNotifyConfig(): NotifyConfig | null {
  const filePath = getNotifyConfigPath();
  let parsed: unknown;
  try {
    if (!existsSync(filePath)) return null;
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  const webhookUrl = typeof obj.webhookUrl === "string" ? obj.webhookUrl.trim() : "";
  if (!webhookUrl) return null; // nothing to send to

  const enabled = obj.enabled !== false; // default true once a webhook is set
  if (!enabled) return null;

  const webhookSecret = typeof obj.webhookSecret === "string" ? obj.webhookSecret.trim() : "";
  const webUrl = typeof obj.webUrl === "string" ? obj.webUrl.trim() : ""; // empty → card omits the button

  return { enabled, webhookUrl, webhookSecret, webUrl };
}

/** Feishu v1 interactive card: compact header + pwd (last two dirs) + link button. */
export function buildCard(
  type: NotifyType,
  cwd: string,
  sessionId: string,
  webUrl: string,
): Record<string, unknown> {
  const meta = CARD_META[type];
  const elements: Record<string, unknown>[] = [
    { tag: "div", text: { tag: "lark_md", content: `**📁 目录**\n${lastTwoDirs(cwd)}` } },
  ];
  // Omit the "open session" button entirely when no webUrl is configured —
  // there is no hardcoded default (keeps personal domains out of the source).
  if (webUrl) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "打开会话" },
          type: "primary",
          url: `${webUrl}/?session=${encodeURIComponent(sessionId)}`,
        },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `${meta.emoji} ${meta.title}` },
      template: meta.template,
    },
    elements,
  };
}

/** HMAC-SHA256 signature for a signed webhook (key = `${timestamp}\n${secret}`, empty message). */
export function sign(timestamp: string, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("", "utf8").digest("base64");
}

/** POST the card to the webhook. Never throws; failures only log to stderr. */
async function sendFeishu(config: NotifyConfig, card: Record<string, unknown>): Promise<void> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload: Record<string, unknown> = { msg_type: "interactive", card };
  if (config.webhookSecret) {
    payload.timestamp = timestamp;
    payload.sign = sign(timestamp, config.webhookSecret);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let result: { code?: number; StatusCode?: number } = {};
    try {
      result = JSON.parse(text);
    } catch {
      console.error(`[pi-atlas] feishu notify bad response: ${text}`);
      return;
    }
    if (result.code !== 0 && result.StatusCode !== 0) {
      console.error(`[pi-atlas] feishu notify failed: ${text}`);
    }
  } catch (e) {
    console.error(`[pi-atlas] feishu notify error: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire a Feishu notification of the given type. No-op for subagents or when
 * notifications are disabled/unconfigured. Safe to call as `void notify(...)`.
 */
export async function notify(ctx: ExtensionContext, type: NotifyType): Promise<void> {
  try {
    if (isSubagent()) return;
    const config = loadNotifyConfig();
    if (!config) return;
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const sessionId = ctx.sessionManager.getSessionId();
    await sendFeishu(config, buildCard(type, cwd, sessionId, config.webUrl));
  } catch (e) {
    console.error(`[pi-atlas] feishu notify error: ${(e as Error).message}`);
  }
}
