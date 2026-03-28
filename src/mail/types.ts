/**
 * Lightweight message envelope from the Apple Mail SQLite database.
 * Contains metadata only — no body content.
 */
export interface MailEnvelope {
  /** SQLite ROWID — unique, monotonically increasing. Used as a cursor for polling. */
  readonly rowid: number;
  /** Sender email address (lowercase). */
  readonly sender: string;
  /** Email subject line. */
  readonly subject: string;
  /** When the message was received. */
  readonly dateReceived: Date;
  /** Whether the message has been read in Mail.app. */
  readonly read: boolean;
  /** Whether the message has been marked for deletion. */
  readonly deleted: boolean;
  /** IMAP mailbox URL (e.g. "imap://UUID/INBOX"). */
  readonly mailboxUrl: string;
}

/**
 * Full message including body content, ready for processing.
 */
export interface MailMessage extends MailEnvelope {
  /** Plain-text body of the email. */
  readonly body: string;
}
