import { execFileSync } from "node:child_process";
import type { MailEnvelope } from "./types.js";

/** Apple Core Data epoch offset: seconds between 2001-01-01 and 1970-01-01. */
export const APPLE_EPOCH_OFFSET = 978307200;

/**
 * Error callback for query failures.
 * If not provided, errors are silently ignored.
 */
export type QueryErrorHandler = (error: Error) => void;

/**
 * Read-only access to Apple Mail message envelopes.
 *
 * Implementations may read from the real SQLite database or return
 * mock data for testing.
 */
export interface MailStore {
  /**
   * Fetch unread INBOX messages with ROWID greater than the given cursor.
   * Results are ordered by date_received ascending (oldest first).
   */
  getUnreadInboxMessages(sinceRowid?: number): MailEnvelope[];

  /** Release any held resources. */
  close(): void;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

interface RawEnvelopeRow {
  rowid: number;
  subject: string | null;
  sender: string | null;
  date_received: number;
  read: number;
  deleted: number;
  mailbox_url: string | null;
}

/**
 * Parameterized query using `.param set` to bind the cursor value.
 *
 * The cursor is bound via sqlite3's `.param set :cursor` command,
 * which safely handles the value without string interpolation.
 * The query references `:cursor` as a named parameter.
 */
const UNREAD_INBOX_QUERY = `
  SELECT
    m.ROWID   AS rowid,
    COALESCE(m.subject_prefix, '') || COALESCE(s.subject, '') AS subject,
    a.address AS sender,
    m.date_received,
    m.read,
    m.deleted,
    mb.url    AS mailbox_url
  FROM messages m
    LEFT JOIN subjects  s  ON m.subject = s.ROWID
    LEFT JOIN addresses a  ON m.sender  = a.ROWID
    LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
  WHERE m.read    = 0
    AND m.deleted = 0
    AND mb.url LIKE '%/INBOX'
    AND m.ROWID > :cursor
  ORDER BY m.date_received ASC;
`;

/**
 * {@link MailStore} backed by Apple Mail's "Envelope Index" SQLite database.
 *
 * Uses the system `sqlite3` CLI to avoid native-module dependencies.
 * Each query spawns a short-lived subprocess — fast enough for polling
 * intervals of 10 s or more.
 */
export class SqliteMailStore implements MailStore {
  private readonly onError?: QueryErrorHandler;

  constructor(
    private readonly dbPath: string,
    onError?: QueryErrorHandler,
  ) {
    this.onError = onError;
  }

  getUnreadInboxMessages(sinceRowid = 0): MailEnvelope[] {
    const cursor = toSafeInt(sinceRowid);
    const output = this.query(cursor);
    if (!output) return [];

    const rows: RawEnvelopeRow[] = JSON.parse(output);
    return rows.map(toMailEnvelope);
  }

  close(): void {
    // No persistent connection to close with the CLI approach.
  }

  // -- internal -------------------------------------------------------------

  /**
   * Execute the unread-inbox query with the given cursor bound as a
   * named parameter via sqlite3's `.param set` command. This avoids
   * interpolating user-controlled values into SQL.
   */
  private query(cursor: number): string {
    const commands = [
      `.param set :cursor ${cursor}`,
      `.mode json`,
      UNREAD_INBOX_QUERY,
    ].join("\n");

    try {
      return execFileSync("sqlite3", [this.dbPath], {
        encoding: "utf-8",
        input: commands,
        timeout: 5_000,
      }).trim();
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMailEnvelope(row: RawEnvelopeRow): MailEnvelope {
  return {
    rowid: row.rowid,
    sender: (row.sender ?? "").toLowerCase(),
    subject: row.subject ?? "(no subject)",
    dateReceived: new Date((row.date_received + APPLE_EPOCH_OFFSET) * 1000),
    read: row.read === 1,
    deleted: row.deleted === 1,
    mailboxUrl: row.mailbox_url ?? "",
  };
}

/** Coerce a value to a non-negative integer, defaulting to 0. */
function toSafeInt(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
