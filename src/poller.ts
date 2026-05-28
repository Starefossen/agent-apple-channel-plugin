import type { MailStore } from "./mail/store.js";
import type { MailClient } from "./mail/client.js";
import type { AllowlistChecker } from "./security/allowlist.js";
import type { MailEnvelope, MailMessage } from "./mail/types.js";

/**
 * Delegate that receives processed mail messages and errors.
 * Implement this to wire the poller into OC or any other consumer.
 */
export interface PollerDelegate {
  /** Called when a new message from an allowed sender is ready for processing. */
  onMessage(message: MailMessage): Promise<void>;

  /** Called when a non-fatal error occurs during a poll cycle. */
  onError(error: Error): void;
}

export interface PollerOptions {
  /** Polling interval in milliseconds. @default 30_000 */
  intervalMs?: number;

  /**
   * Whether to tell Mail.app to check for new mail at the start of
   * each poll cycle (via AppleScript). Ensures the IMAP inbox is
   * synced before querying SQLite.
   *
   * @default true
   */
  checkForNewMail?: boolean;
}

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Polls Apple Mail for new unread messages from allowed senders.
 *
 * ## Poll cycle
 *
 * 1. (Optional) Tell Mail.app to check for new mail.
 * 2. Query the SQLite "Envelope Index" for unread INBOX messages
 *    with ROWID greater than the last seen cursor.
 * 3. For each message whose sender is on the allowlist:
 *    a. Fetch the plain-text body via AppleScript.
 *    b. Mark the message as read.
 *    c. Deliver to the delegate.
 * 4. Messages from non-allowed senders are silently skipped (but the
 *    cursor still advances past them).
 *
 * ## Error handling
 *
 * - If `checkForNewMail` fails, the cycle continues (non-fatal).
 * - If body fetch or delivery fails for a single message, the error
 *   is reported to the delegate and the cursor advances. The message
 *   will remain unread in Mail.app if `markAsRead` wasn't reached.
 */
export class MailPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRowid = 0;
  private polling = false;

  constructor(
    private readonly store: MailStore,
    private readonly client: MailClient,
    private readonly allowlist: AllowlistChecker,
    private readonly delegate: PollerDelegate,
    private readonly options: PollerOptions = {},
  ) { }

  /** Start the polling loop. Idempotent. */
  start(): void {
    if (this.timer) return;

    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;

    // Run an initial poll immediately, then schedule recurring polls.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  /** Stop the polling loop and release resources. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.store.close();
  }

  /** Whether the poller is currently running. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** High-water mark ROWID — all messages up to this point have been seen. */
  get cursor(): number {
    return this.lastRowid;
  }

  /**
   * Run a single poll cycle.
   *
   * Concurrent calls are serialized: if a poll is already in progress
   * the second call returns immediately.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      // 1. Ask Mail.app to sync (non-fatal if it fails).
      if (this.options.checkForNewMail !== false) {
        try {
          await this.client.checkForNewMail();
        } catch (err) {
          this.delegate.onError(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }

      // 2. Query for new unread messages.
      const envelopes = this.store.getUnreadInboxMessages(this.lastRowid);
      if (envelopes.length === 0) return;

      // 3. Process each envelope sequentially.
      for (const envelope of envelopes) {
        await this.processEnvelope(envelope);
      }
    } catch (err) {
      this.delegate.onError(
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      this.polling = false;
    }
  }

  // -- internal -------------------------------------------------------------

  private async processEnvelope(envelope: MailEnvelope): Promise<void> {
    // Always advance the cursor so we don't re-scan this message.
    this.lastRowid = Math.max(this.lastRowid, envelope.rowid);

    if (!this.allowlist.isAllowed(envelope.sender)) {
      return;
    }

    try {
      const body = await this.client.fetchBody(envelope);
      const message: MailMessage = { ...envelope, body };
      await this.client.markAsRead(envelope);
      await this.delegate.onMessage(message);
    } catch (err) {
      this.delegate.onError(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}
