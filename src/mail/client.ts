import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MailEnvelope } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Interface for Apple Mail operations that require AppleScript.
 *
 * Separated from {@link import("./store.js").MailStore} so that the
 * fast SQLite path handles discovery while AppleScript handles the
 * heavier body-fetch and state-mutation operations.
 */
export interface MailClient {
  /** Fetch the plain-text body of a message identified by its envelope. */
  fetchBody(envelope: MailEnvelope): Promise<string>;

  /** Mark a message as read in Mail.app. */
  markAsRead(envelope: MailEnvelope): Promise<void>;

  /** Tell Mail.app to check for new mail from all accounts. */
  checkForNewMail(): Promise<void>;
}

/**
 * {@link MailClient} implementation that shells out to `osascript`.
 *
 * Messages are located by matching on subject + sender address among
 * unread inbox messages. This is reliable when processed promptly
 * after detection via SQLite polling.
 *
 * **Security:** User-controlled data (subject, sender) is passed via
 * environment variables and read inside AppleScript with
 * `system attribute`. This eliminates AppleScript injection since no
 * user data is interpolated into the script source.
 */
export class AppleScriptMailClient implements MailClient {
  async fetchBody(envelope: MailEnvelope): Promise<string> {
    const script = `
set targetSubject to system attribute "MAIL_SUBJECT"
set targetSender to system attribute "MAIL_SENDER"
tell application "Mail"
  set matchedMsgs to (every message of inbox whose read status is false and subject contains targetSubject)
  repeat with msg in matchedMsgs
    if (extract address from sender of msg) is targetSender then
      return content of msg
    end if
  end repeat
  return ""
end tell`;
    return this.osascript(script, {
      MAIL_SUBJECT: envelope.subject,
      MAIL_SENDER: envelope.sender,
    });
  }

  async markAsRead(envelope: MailEnvelope): Promise<void> {
    const script = `
set targetSubject to system attribute "MAIL_SUBJECT"
set targetSender to system attribute "MAIL_SENDER"
tell application "Mail"
  set matchedMsgs to (every message of inbox whose read status is false and subject contains targetSubject)
  repeat with msg in matchedMsgs
    if (extract address from sender of msg) is targetSender then
      set read status of msg to true
      return
    end if
  end repeat
end tell`;
    await this.osascript(script, {
      MAIL_SUBJECT: envelope.subject,
      MAIL_SENDER: envelope.sender,
    });
  }

  async checkForNewMail(): Promise<void> {
    await this.osascript('tell application "Mail" to check for new mail');
  }

  // -- internal -------------------------------------------------------------

  private async osascript(
    script: string,
    env?: Record<string, string>,
  ): Promise<string> {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      encoding: "utf-8",
      timeout: 30_000,
      env: env ? { ...process.env, ...env } : undefined,
    });
    return stdout.trim();
  }
}
