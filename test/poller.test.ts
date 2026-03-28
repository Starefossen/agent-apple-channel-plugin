import { describe, it, expect, beforeEach } from "vitest";
import { MailPoller } from "../src/poller.js";
import { Allowlist } from "../src/security/allowlist.js";
import {
  InMemoryMailStore,
  StubMailClient,
  CollectingDelegate,
  makeEnvelope,
  resetRowidCounter,
} from "./helpers.js";

describe("MailPoller", () => {
  let store: InMemoryMailStore;
  let client: StubMailClient;
  let delegate: CollectingDelegate;

  beforeEach(() => {
    resetRowidCounter();
    store = new InMemoryMailStore();
    client = new StubMailClient();
    delegate = new CollectingDelegate();
  });

  function createPoller(
    allowedAddresses: string[] = ["allowed@example.com"],
  ) {
    return new MailPoller(
      store,
      client,
      new Allowlist(allowedAddresses),
      delegate,
      { checkForNewMail: false }, // skip AppleScript in tests
    );
  }

  it("delivers messages from allowed senders", async () => {
    const envelope = makeEnvelope({ sender: "allowed@example.com" });
    store.addMessage(envelope);

    const poller = createPoller();
    await poller.poll();

    expect(delegate.messages).toHaveLength(1);
    expect(delegate.messages[0].sender).toBe("allowed@example.com");
    expect(delegate.messages[0].body).toBe("Body for: Test Subject");
  });

  it("skips messages from non-allowed senders", async () => {
    store.addMessage(makeEnvelope({ sender: "stranger@evil.com" }));

    const poller = createPoller();
    await poller.poll();

    expect(delegate.messages).toHaveLength(0);
    expect(client.fetchedBodies).toHaveLength(0);
  });

  it("advances cursor past all messages including skipped ones", async () => {
    store.addMessage(makeEnvelope({ rowid: 10, sender: "stranger@evil.com" }));
    store.addMessage(makeEnvelope({ rowid: 20, sender: "allowed@example.com" }));
    store.addMessage(makeEnvelope({ rowid: 30, sender: "stranger@evil.com" }));

    const poller = createPoller();
    await poller.poll();

    expect(poller.cursor).toBe(30);
    expect(delegate.messages).toHaveLength(1);
  });

  it("does not re-process messages on subsequent polls", async () => {
    store.addMessage(makeEnvelope({ rowid: 1, sender: "allowed@example.com" }));

    const poller = createPoller();
    await poller.poll();
    await poller.poll(); // second poll: same message, but cursor moved past it

    expect(delegate.messages).toHaveLength(1);
  });

  it("marks processed messages as read", async () => {
    store.addMessage(makeEnvelope({ sender: "allowed@example.com" }));

    const poller = createPoller();
    await poller.poll();

    expect(client.markedAsRead).toHaveLength(1);
  });

  it("does not mark non-allowed messages as read", async () => {
    store.addMessage(makeEnvelope({ sender: "stranger@evil.com" }));

    const poller = createPoller();
    await poller.poll();

    expect(client.markedAsRead).toHaveLength(0);
  });

  it("reports body-fetch errors to delegate without blocking", async () => {
    store.addMessage(
      makeEnvelope({ rowid: 1, sender: "allowed@example.com", subject: "Fail" }),
    );
    store.addMessage(
      makeEnvelope({ rowid: 2, sender: "allowed@example.com", subject: "OK" }),
    );

    // Make fetchBody throw for "Fail" subject.
    const origFetchBody = client.fetchBody.bind(client);
    client.fetchBody = async (env) => {
      if (env.subject === "Fail") throw new Error("AppleScript timeout");
      return origFetchBody(env);
    };

    const poller = createPoller();
    await poller.poll();

    // First message errored, second succeeded.
    expect(delegate.errors).toHaveLength(1);
    expect(delegate.errors[0].message).toBe("AppleScript timeout");
    expect(delegate.messages).toHaveLength(1);
    expect(delegate.messages[0].subject).toBe("OK");
    // Cursor advanced past both.
    expect(poller.cursor).toBe(2);
  });

  it("checks for new mail when enabled", async () => {
    const poller = new MailPoller(
      store,
      client,
      new Allowlist([]),
      delegate,
      { checkForNewMail: true },
    );
    await poller.poll();

    expect(client.checkForNewMailCalled).toBe(1);
  });

  it("reports checkForNewMail errors to delegate", async () => {
    const failingClient = new StubMailClient();
    failingClient.checkForNewMail = async () => {
      throw new Error("Mail.app not running");
    };

    const poller = new MailPoller(
      store,
      failingClient,
      new Allowlist([]),
      delegate,
      { checkForNewMail: true },
    );
    await poller.poll();

    expect(delegate.errors).toHaveLength(1);
    expect(delegate.errors[0].message).toBe("Mail.app not running");
  });

  it("skips check for new mail when disabled", async () => {
    const poller = createPoller(); // checkForNewMail: false
    await poller.poll();

    expect(client.checkForNewMailCalled).toBe(0);
  });

  it("serializes concurrent poll calls", async () => {
    store.addMessage(makeEnvelope({ sender: "allowed@example.com" }));

    const poller = createPoller();
    // Fire two polls concurrently.
    await Promise.all([poller.poll(), poller.poll()]);

    // Only one should have run (the second sees polling=true and returns).
    expect(delegate.messages).toHaveLength(1);
  });

  it("start and stop lifecycle", async () => {
    const poller = createPoller();
    expect(poller.running).toBe(false);

    poller.start();
    expect(poller.running).toBe(true);

    // Idempotent start.
    poller.start();
    expect(poller.running).toBe(true);

    poller.stop();
    expect(poller.running).toBe(false);
  });

  it("handles empty inbox gracefully", async () => {
    const poller = createPoller();
    await poller.poll();

    expect(delegate.messages).toHaveLength(0);
    expect(delegate.errors).toHaveLength(0);
    expect(poller.cursor).toBe(0);
  });

  it("processes multiple allowed messages in order", async () => {
    store.addMessage(
      makeEnvelope({ rowid: 1, sender: "allowed@example.com", subject: "First" }),
    );
    store.addMessage(
      makeEnvelope({ rowid: 2, sender: "allowed@example.com", subject: "Second" }),
    );
    store.addMessage(
      makeEnvelope({ rowid: 3, sender: "allowed@example.com", subject: "Third" }),
    );

    const poller = createPoller();
    await poller.poll();

    expect(delegate.messages).toHaveLength(3);
    expect(delegate.messages.map((m) => m.subject)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });
});
