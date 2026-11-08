import { resolveConfigFromFile, type AppleMailConfig } from "./config.js";
import { SqliteMailStore } from "./mail/store.js";
import { AppleScriptMailClient } from "./mail/client.js";
import { Allowlist } from "./security/allowlist.js";
import { MailPoller, type PollerDelegate } from "./poller.js";
import type { MailMessage } from "./mail/types.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// OC type aliases (minimal surface to avoid depending on OC internals)
// ---------------------------------------------------------------------------

/** Subset of OC's ChannelLogSink. */
interface OcLog {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** Context passed to `startAccount` by OC. */
interface OcGatewayContext {
  cfg: Record<string, unknown>;
  accountId: string;
  runtime: unknown;
  abortSignal: AbortSignal;
  log?: OcLog;
}

/**
 * Minimal OC plugin API for channel registration.
 *
 * `api.runtime` is the full PluginRuntime with channel dispatch APIs.
 * `ctx.runtime` in startAccount is just a logger — do NOT use it for dispatch.
 */
interface OcPluginApi {
  registerChannel: (plugin: unknown) => void;
  runtime: OcPluginRuntime;
}

/**
 * Loose typing for OC's PluginRuntime.channel subset.
 *
 * We can't import from "openclaw/plugin-sdk" (standalone project),
 * so we type only the methods we actually call.
 */
interface OcPluginRuntime {
  config: { loadConfig: (...args: unknown[]) => unknown };
  channel: {
    routing: {
      resolveAgentRoute: (params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: string; id: string };
      }) => { agentId: string; sessionKey: string; accountId?: string };
    };
    session: {
      resolveStorePath: (
        storeConfig: unknown,
        params: { agentId: string },
      ) => string;
      readSessionUpdatedAt: (params: {
        storePath: string;
        sessionKey: string;
      }) => number | undefined;
      recordInboundSession: (params: {
        storePath: string;
        sessionKey: string;
        ctx: Record<string, unknown>;
        onRecordError?: (err: unknown) => void;
      }) => Promise<void>;
    };
    reply: {
      finalizeInboundContext: (
        ctx: Record<string, unknown>,
      ) => Record<string, unknown>;
      formatAgentEnvelope: (params: {
        channel: string;
        from: string;
        timestamp: number;
        previousTimestamp?: number;
        envelope: unknown;
        body: string;
      }) => string;
      resolveEnvelopeFormatOptions: (
        cfg: unknown,
      ) => unknown;
      dispatchReplyWithBufferedBlockDispatcher: (params: {
        ctx: Record<string, unknown>;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: { text: string }) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
        replyOptions?: Record<string, unknown>;
      }) => Promise<void>;
    };
  };
}

// ---------------------------------------------------------------------------
// Channel plugin definition
// ---------------------------------------------------------------------------

const CHANNEL_ID = "apple-mail";

/**
 * Module-level reference to the OC PluginRuntime.
 *
 * Set in `register(api)` via `api.runtime`. Used in `startAccount`
 * for inbound message dispatch. This is NOT the same as `ctx.runtime`
 * in startAccount (which is just a logger).
 */
let pluginRuntime: OcPluginRuntime | null = null;

/** Resolve path to config.json relative to this module. */
function getConfigPath(): string {
  // Works for both ESM (__dirname not available) and CJS.
  const dir = typeof __dirname !== "undefined"
    ? __dirname
    : join(fileURLToPath(import.meta.url), "..");
  return join(dir, "..", "config.json");
}

/**
 * Create the OC ChannelPlugin object for Apple Mail.
 *
 * This is a **receive-only** channel. Inbound emails from allowed
 * senders are delivered to the OC auto-reply pipeline. Outbound
 * (sending replies via email) is not implemented.
 */
function createPlugin() {
  const configPath = getConfigPath();
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "Apple Mail",
      selectionLabel: "Apple Mail (macOS)",
      docsPath: "/channels/apple-mail",
      docsLabel: "apple-mail",
      blurb:
        "Receive emails via Apple Mail.app on macOS. Polls the local Mail database for new messages from allowed senders.",
      order: 45,
      quickstartAllowFrom: true,
    },

    capabilities: {
      chatTypes: ["direct"],
      dm: true,
      group: false,
      media: false,
      reactions: false,
      threads: false,
      polls: false,
      typing: false,
      markdown: false,
    },

    // -- config adapter -----------------------------------------------------
    config: {
      listAccountIds: () => {
        try {
          const config = resolveConfigFromFile(configPath);
          return config.enabled ? ["default"] : [];
        } catch {
          return [];
        }
      },

      resolveAccount: () => {
        return resolveConfigFromFile(configPath);
      },

      defaultAccountId: () => "default",

      isEnabled: (account: AppleMailConfig) => account.enabled,

      disabledReason: (account: AppleMailConfig) =>
        account.enabled ? "" : "Apple Mail channel is disabled in config",

      isConfigured: (account: AppleMailConfig) =>
        account.allowFrom.length > 0,

      unconfiguredReason: (account: AppleMailConfig) =>
        account.allowFrom.length > 0
          ? ""
          : "No allowFrom addresses configured for Apple Mail",

      resolveAllowFrom: () => {
        const config = resolveConfigFromFile(configPath);
        return config.allowFrom as string[];
      },
    },

    // -- security adapter ---------------------------------------------------
    security: {
      resolveDmPolicy: () => "allowlist" as const,
    },

    // -- gateway adapter (core: starts the mail poller) --------------------
    gateway: {
      startAccount: async (ctx: OcGatewayContext): Promise<() => void> => {
        const { abortSignal, log } = ctx;
        const config = resolveConfigFromFile(configPath);

        if (!config.enabled) {
          log?.info?.("[apple-mail] Channel disabled, skipping");
          return () => { };
        }

        if (config.allowFrom.length === 0) {
          log?.warn?.("[apple-mail] No allowFrom addresses configured");
          return () => { };
        }

        const runtime = pluginRuntime;
        if (!runtime) {
          log?.error?.("[apple-mail] PluginRuntime not set — dispatch unavailable");
          return () => { };
        }

        const store = new SqliteMailStore(config.dbPath, (err) => {
          log?.error?.(`[apple-mail] SQLite query error: ${err.message}`);
        });
        const client = new AppleScriptMailClient();
        const allowlist = new Allowlist(config.allowFrom);

        const delegate: PollerDelegate = {
          onMessage: async (message: MailMessage) => {
            log?.info?.(
              `[apple-mail] New email from ${message.sender}: ${message.subject}`,
            );
            try {
              await deliverToAgent(ctx, runtime, message, log);
            } catch (err) {
              log?.error?.(
                `[apple-mail] Failed to dispatch: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
          onError: (error: Error) => {
            log?.error?.(`[apple-mail] Poll error: ${error.message}`);
          },
        };

        const poller = new MailPoller(store, client, allowlist, delegate, {
          intervalMs: config.pollIntervalMs,
        });

        log?.info?.(
          `[apple-mail] Starting poller (interval=${config.pollIntervalMs}ms, ` +
          `allowFrom=${config.allowFrom.length} addresses, ` +
          `db=${config.dbPath})`,
        );

        poller.start();

        // OC expects startAccount to return a promise that stays pending
        // until the channel shuts down. Resolving immediately causes OC
        // to treat it as a crash and trigger auto-restart.
        return new Promise<() => void>((resolve) => {
          const cleanup = () => {
            log?.info?.("[apple-mail] Stopping poller");
            poller.stop();
          };
          abortSignal.addEventListener("abort", () => {
            cleanup();
            resolve(cleanup);
          }, { once: true });
        });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Inbound dispatch — delivers email content to the agent
// ---------------------------------------------------------------------------

/**
 * Format an email into the body text the agent will see.
 *
 * Includes sender, subject, and body content.
 */
function formatEmailBody(message: MailMessage): string {
  const parts = [`From: ${message.sender}`, `Subject: ${message.subject}`];
  if (message.body) {
    parts.push("", message.body);
  }
  return parts.join("\n");
}

/**
 * Dispatch an inbound email to the OC agent pipeline.
 *
 * Follows the same pattern as the IRC channel plugin:
 * 1. Resolve which agent handles this message
 * 2. Build the inbound context payload
 * 3. Record the inbound session
 * 4. Dispatch to the agent's auto-reply pipeline
 *
 * The `deliver` callback is a no-op — this is a receive-only channel.
 */
async function deliverToAgent(
  ctx: OcGatewayContext,
  runtime: OcPluginRuntime,
  message: MailMessage,
  log?: OcLog,
): Promise<void> {
  const peerId = message.sender.toLowerCase();

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    peer: { kind: "direct", id: peerId },
  });

  const storePath = runtime.channel.session.resolveStorePath(
    (ctx.cfg as Record<string, Record<string, unknown>>).session?.store,
    { agentId: route.agentId },
  );

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(
    ctx.cfg,
  );

  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const rawBody = formatEmailBody(message);
  const timestamp = message.dateReceived
    ? new Date(message.dateReceived).getTime()
    : Date.now();

  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "Apple Mail",
    from: message.sender,
    timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `apple-mail:${peerId}`,
    To: `apple-mail:${ctx.accountId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? ctx.accountId,
    ChatType: "direct",
    ConversationLabel: message.sender,
    SenderName: message.sender,
    SenderId: peerId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: String(message.rowid),
    Timestamp: timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `apple-mail:${ctx.accountId}`,
  });

  // Record the inbound session
  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey as string ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      log?.error?.(`[apple-mail] Session record error: ${String(err)}`);
    },
  });

  // Dispatch to the agent — deliver is a no-op (receive-only channel)
  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: ctx.cfg,
    dispatcherOptions: {
      deliver: async () => {
        // Receive-only channel — no outbound email delivery.
        // The agent's reply will be silently discarded.
      },
      onError: (err, info) => {
        log?.error?.(
          `[apple-mail] Dispatch ${info.kind} error: ${String(err)}`,
        );
      },
    },
  });

  log?.info?.(
    `[apple-mail] Dispatched email from ${message.sender} to agent ${route.agentId}`,
  );
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * OpenClaw plugin entry point.
 *
 * Called by the OC gateway when loading the plugin from
 * `openclaw.extensions` in package.json.
 */
export default function register(api: OcPluginApi): void {
  pluginRuntime = api.runtime;
  api.registerChannel(createPlugin());
}
