import type { MailStore } from "../src/mail/store.js";
import type { MailClient } from "../src/mail/client.js";
import type { MailEnvelope, MailMessage } from "../src/mail/types.js";

// ---------------------------------------------------------------------------
// In-memory MailStore for testing
// ---------------------------------------------------------------------------

export class InMemoryMailStore implements MailStore {
  private messages: MailEnvelope[] = [];

  addMessage(msg: MailEnvelope): void {
    this.messages.push(msg);
  }

  getUnreadInboxMessages(sinceRowid = 0): MailEnvelope[] {
    return this.messages.filter(
      (m) => m.rowid > sinceRowid && !m.read && !m.deleted,
    );
  }

  close(): void {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Stub MailClient for testing (no AppleScript)
// ---------------------------------------------------------------------------

export class StubMailClient implements MailClient {
  readonly fetchedBodies: MailEnvelope[] = [];
  readonly markedAsRead: MailEnvelope[] = [];
  checkForNewMailCalled = 0;

  /** Map of sender → body for fetchBody responses. */
  bodies = new Map<string, string>();

  async fetchBody(envelope: MailEnvelope): Promise<string> {
    this.fetchedBodies.push(envelope);
    return this.bodies.get(envelope.sender) ?? `Body for: ${envelope.subject}`;
  }

  async markAsRead(envelope: MailEnvelope): Promise<void> {
    this.markedAsRead.push(envelope);
  }

  async checkForNewMail(): Promise<void> {
    this.checkForNewMailCalled++;
  }
}

// ---------------------------------------------------------------------------
// Factory for test envelopes
// ---------------------------------------------------------------------------

let nextRowid = 1;

export function makeEnvelope(
  overrides: Partial<MailEnvelope> = {},
): MailEnvelope {
  return {
    rowid: nextRowid++,
    sender: "test@example.com",
    subject: "Test Subject",
    dateReceived: new Date("2026-03-15T09:00:00Z"),
    read: false,
    deleted: false,
    mailboxUrl: "imap://test/INBOX",
    ...overrides,
  };
}

export function resetRowidCounter(): void {
  nextRowid = 1;
}

// ---------------------------------------------------------------------------
// Collecting delegate for MailPoller tests
// ---------------------------------------------------------------------------

export class CollectingDelegate {
  readonly messages: MailMessage[] = [];
  readonly errors: Error[] = [];

  async onMessage(message: MailMessage): Promise<void> {
    this.messages.push(message);
  }

  onError(error: Error): void {
    this.errors.push(error);
  }
}
