import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { Allowlist } from "../src/security/allowlist.js";
import { validateDbPath, resolveConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Allowlist security tests
// ---------------------------------------------------------------------------

describe("Allowlist — security edge cases", () => {
  const allowlist = new Allowlist(["trusted@example.com"]);

  it("rejects addresses with extra characters appended", () => {
    expect(allowlist.isAllowed("trusted@example.com.evil.com")).toBe(false);
  });

  it("rejects addresses with prefix matching", () => {
    expect(allowlist.isAllowed("nottrusted@example.com")).toBe(false);
  });

  it("rejects addresses with null bytes", () => {
    expect(allowlist.isAllowed("trusted@example.com\0@evil.com")).toBe(false);
  });

  it("rejects addresses differing only by unicode homoglyphs", () => {
    // Cyrillic 'а' (U+0430) vs Latin 'a' (U+0061)
    expect(allowlist.isAllowed("trusted@ex\u0430mple.com")).toBe(false);
  });

  it("rejects empty and whitespace-only senders", () => {
    expect(allowlist.isAllowed("")).toBe(false);
    expect(allowlist.isAllowed("   ")).toBe(false);
    expect(allowlist.isAllowed("\t\n")).toBe(false);
  });

  it("does not match substrings", () => {
    expect(allowlist.isAllowed("trusted@example")).toBe(false);
    expect(allowlist.isAllowed("@example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dbPath validation — path traversal prevention
// ---------------------------------------------------------------------------

describe("validateDbPath — path traversal", () => {
  const home = homedir();

  it("blocks absolute path outside Mail directory", () => {
    expect(() => validateDbPath("/tmp/evil.db")).toThrow();
    expect(() => validateDbPath("/var/db/something")).toThrow();
  });

  it("blocks directory traversal with ..", () => {
    expect(() =>
      validateDbPath(`${home}/Library/Mail/../../../etc/passwd`),
    ).toThrow();
  });

  it("blocks double-dot in middle of path", () => {
    expect(() =>
      validateDbPath(`${home}/Library/Mail/V10/../../secrets/key`),
    ).toThrow();
  });

  it("blocks symlink-style paths to other users", () => {
    expect(() =>
      validateDbPath("/Users/attacker/Library/Mail/V10/db"),
    ).toThrow();
  });

  it("blocks /Library/Mail without home prefix", () => {
    expect(() => validateDbPath("/Library/Mail/V10/db")).toThrow();
  });

  it("allows legitimate Mail database paths", () => {
    const valid = `${home}/Library/Mail/V10/MailData/Envelope Index`;
    expect(() => validateDbPath(valid)).not.toThrow();
    expect(validateDbPath(valid)).toBe(valid);
  });

  it("returns resolved (normalized) path", () => {
    const withDot = `${home}/Library/Mail/./V10/MailData/db`;
    const result = validateDbPath(withDot);
    expect(result).not.toContain("/./");
    expect(result).toContain(`${home}/Library/Mail/V10/MailData/db`);
  });
});

// ---------------------------------------------------------------------------
// resolveConfig — security defaults
// ---------------------------------------------------------------------------

describe("resolveConfig — security properties", () => {
  it("defaults to disabled when config is empty", () => {
    const config = resolveConfig({});
    expect(config.enabled).toBe(false);
  });

  it("defaults to empty allowlist", () => {
    const config = resolveConfig({
      channels: { "apple-mail": { enabled: true } },
    });
    expect(config.allowFrom).toEqual([]);
  });

  it("strips non-string values from allowFrom", () => {
    const config = resolveConfig({
      channels: {
        "apple-mail": {
          allowFrom: [42, null, undefined, true, {}, [], "valid@test.com"],
        },
      },
    });
    expect(config.allowFrom).toEqual(["valid@test.com"]);
  });

  it("rejects traversal dbPath values", () => {
    expect(() =>
      resolveConfig({
        channels: { "apple-mail": { dbPath: "/etc/shadow" } },
      }),
    ).toThrow();
  });

  it("enforces minimum pollIntervalMs (must be positive)", () => {
    const config = resolveConfig({
      channels: {
        "apple-mail": { pollIntervalMs: 0 },
      },
    });
    expect(config.pollIntervalMs).toBe(30_000);
  });
});
