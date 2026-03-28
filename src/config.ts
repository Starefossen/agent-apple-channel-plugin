import { homedir } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

/**
 * Resolved configuration for the Apple Mail channel.
 */
export interface AppleMailConfig {
  /** Whether the channel is active. */
  enabled: boolean;

  /** Absolute path to the Mail.app "Envelope Index" SQLite database. */
  dbPath: string;

  /** Polling interval in milliseconds. */
  pollIntervalMs: number;

  /** Email addresses allowed to send messages to the agent. */
  allowFrom: readonly string[];
}

export const DEFAULT_DB_PATH = "~/Library/Mail/V10/MailData/Envelope Index";
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Allowed parent directories for the Mail database path. */
const ALLOWED_DB_PARENTS = [
  "/Library/Mail/",
] as const;

/**
 * Read Apple Mail channel configuration from a standalone JSON file.
 *
 * OC validates channel IDs in `channels` before plugins load, so custom
 * channel plugins cannot use `channels["apple-mail"]`. Instead, config
 * lives in a `config.json` file alongside the plugin.
 */
export function resolveConfigFromFile(configPath: string): AppleMailConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // File missing or unreadable — return defaults (disabled).
  }
  return resolveConfigRaw(raw);
}

/**
 * Read Apple Mail channel configuration from the OpenClaw config object.
 *
 * Reads from `channels["apple-mail"]` if present. Used in tests and
 * as a fallback when no standalone config file is provided.
 */
export function resolveConfig(
  cfg: { channels?: Record<string, unknown> },
  _accountId?: string,
): AppleMailConfig {
  const raw = (cfg.channels?.["apple-mail"] ?? {}) as Record<string, unknown>;
  return resolveConfigRaw(raw);
}

function resolveConfigRaw(raw: Record<string, unknown>): AppleMailConfig {

  const rawDbPath = typeof raw.dbPath === "string" ? raw.dbPath : DEFAULT_DB_PATH;
  const dbPath = validateDbPath(resolvePath(rawDbPath));

  return {
    enabled: raw.enabled === true,
    dbPath,
    pollIntervalMs:
      typeof raw.pollIntervalMs === "number" && raw.pollIntervalMs > 0
        ? raw.pollIntervalMs
        : DEFAULT_POLL_INTERVAL_MS,
    allowFrom: Array.isArray(raw.allowFrom)
      ? raw.allowFrom.filter((v): v is string => typeof v === "string")
      : [],
  };
}

/** Expand a leading `~` to the user's home directory. */
export function resolvePath(p: string): string {
  if (p.startsWith("~/")) {
    return homedir() + p.slice(1);
  }
  return p;
}

/**
 * Ensure the database path resolves to a location under the user's
 * Mail data directory. Prevents path traversal via config manipulation.
 *
 * @throws {Error} if the resolved path is outside allowed directories.
 */
export function validateDbPath(dbPath: string): string {
  const resolved = resolve(dbPath);
  const home = homedir();
  const allowed = ALLOWED_DB_PARENTS.some(
    (parent) => resolved.startsWith(home + parent),
  );
  if (!allowed) {
    throw new Error(
      `Invalid dbPath: "${dbPath}" is not under ~/Library/Mail/`,
    );
  }
  return resolved;
}
