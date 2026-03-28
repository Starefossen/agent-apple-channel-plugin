# Apple Mail Channel Plugin

Receive-only channel plugin that lets an OC agent process inbound emails from Apple Mail.app on macOS. Emails from allowed senders are dispatched to the agent's auto-reply pipeline — the same way iMessage, Telegram, and IRC deliver inbound messages.

> **Warning:** This plugin reads the local Mail.app SQLite database directly. It should only be used on a **dedicated macOS user account** created specifically for the agent — never on your primary personal or work account. The agent account's Mail.app should be configured with its own mailbox that receives only agent-directed mail.

## How it works

1. Polls the local Mail.app SQLite database (`~/Library/Mail/V10/MailData/Envelope Index`) for new messages
2. Filters by sender allowlist (case-insensitive email matching)
3. Fetches full email body via AppleScript → Mail.app
4. **Dispatches to the agent** via OC's `dispatchInboundReplyWithBase()` — the agent sees the email as an inbound message and can act on it (e.g., add a calendar event, update a document)
5. Tracks processed message IDs to avoid duplicates

This is a **receive-only** channel — the agent processes emails but does **not** reply via email. The `deliver` callback in dispatch is a no-op.

## OC Plugin Runtime

The plugin accesses the OC runtime via the **`api.runtime`** object passed to `register(api)`. This is the `PluginRuntime` — NOT the `ctx.runtime` in `startAccount` (which is just a logger).

Key runtime APIs used:

- `runtime.channel.routing.resolveAgentRoute()` — resolves which agent handles the message
- `runtime.channel.session.resolveStorePath()` — gets the session store path
- `runtime.channel.reply.finalizeInboundContext()` — builds the context payload for the agent
- `runtime.channel.reply.formatAgentEnvelope()` — formats the inbound message envelope
- `dispatchInboundReplyWithBase()` — records the session and dispatches to the agent

This follows the same pattern as the IRC and Nextcloud Talk channel plugins (see `openclaw/extensions/irc/src/inbound.ts` on Varden).

Since the plugin is a standalone TypeScript project (no `openclaw` dependency), all runtime types are defined locally with `unknown`-based interfaces.

## Configuration

The plugin uses a standalone `config.json` file deployed alongside, not OC's `channels` config section (OC validates channel IDs before plugins load, so custom channels can't use the `channels` config block).

```json
{
  "enabled": true,
  "allowFrom": ["someone@example.com"],
  "pollIntervalMs": 30000
}
```

| Key              | Default                                      | Description                                         |
| ---------------- | -------------------------------------------- | --------------------------------------------------- |
| `enabled`        | `false`                                      | Whether the channel is active                       |
| `allowFrom`      | `[]`                                         | Email addresses allowed to send messages (required) |
| `pollIntervalMs` | `30000`                                      | How often to poll for new messages (ms)             |
| `dbPath`         | `~/Library/Mail/V10/MailData/Envelope Index` | Path to Mail.app SQLite database                    |

## Prerequisites

- macOS with Mail.app configured on a **dedicated agent user account**
- Full Disk Access for the gateway process (to read Mail's SQLite database)
- macOS Automation permission: the gateway process must be allowed to control Mail.app via AppleScript (System Settings → Privacy & Security → Automation)
- Node.js >= 20

## Development

```bash
npm install
npm test          # run tests
npm run typecheck # type-check without emitting
```

## Architecture

```text
src/
├── index.ts                # OC channel plugin entry point + dispatch
├── config.ts               # Configuration resolution with defaults
├── poller.ts               # Polling loop with abort signal support
├── mail/
│   ├── client.ts           # AppleScript-based mail interaction
│   ├── store.ts            # SQLite database reader
│   └── types.ts            # Mail message type definitions
└── security/
    └── allowlist.ts        # Case-insensitive email allowlist
```

## Key design decisions

- **No `openclaw` dependency** — runtime APIs are accessed dynamically via `api.runtime` and typed with local interfaces. This avoids version coupling.
- **Standalone config file** — OC validates channel IDs in `channels` config BEFORE plugins load, so custom channels must use file-based config.
- **Receive-only** — the `deliver` callback in `dispatchInboundReplyWithBase()` is a no-op. The agent cannot send email replies. Replies go via other channels (e.g., iMessage).
- **`api.runtime` vs `ctx.runtime`** — `api.runtime` (from `register(api)`) is the full `PluginRuntime` with channel dispatch APIs. `ctx.runtime` (from `startAccount(ctx)`) is just a logger. Use `api.runtime`.
