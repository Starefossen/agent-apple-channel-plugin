import { describe, it, expect } from "vitest";
import { resolveConfig, resolvePath, validateDbPath, DEFAULT_DB_PATH } from "../src/config.js";
import { homedir } from "node:os";

describe("resolvePath", () => {
  it("expands ~ to home directory", () => {
    const result = resolvePath("~/Library/Mail");
    expect(result.startsWith("~")).toBe(false);
    expect(result).toContain("/Library/Mail");
  });

  it("leaves absolute paths unchanged", () => {
    expect(resolvePath("/usr/local/data")).toBe("/usr/local/data");
  });

  it("leaves relative paths unchanged", () => {
    expect(resolvePath("relative/path")).toBe("relative/path");
  });
});

describe("validateDbPath", () => {
  const home = homedir();

  it("accepts paths under ~/Library/Mail/", () => {
    const valid = `${home}/Library/Mail/V10/MailData/Envelope Index`;
    expect(validateDbPath(valid)).toBe(valid);
  });

  it("accepts subdirectories under ~/Library/Mail/", () => {
    const valid = `${home}/Library/Mail/V10/SomeOther/db.sqlite`;
    expect(validateDbPath(valid)).toBe(valid);
  });

  it("rejects paths outside ~/Library/Mail/", () => {
    expect(() => validateDbPath("/etc/passwd")).toThrow("not under ~/Library/Mail/");
    expect(() => validateDbPath(`${home}/Desktop/db.sqlite`)).toThrow("not under ~/Library/Mail/");
  });

  it("rejects path traversal attempts", () => {
    expect(() =>
      validateDbPath(`${home}/Library/Mail/../../.ssh/id_ed25519`),
    ).toThrow("not under ~/Library/Mail/");
  });

  it("rejects paths under other users' Library", () => {
    expect(() => validateDbPath("/Users/other/Library/Mail/V10/db")).toThrow(
      "not under ~/Library/Mail/",
    );
  });
});

describe("resolveConfig", () => {
  it("returns defaults when no channel config exists", () => {
    const config = resolveConfig({});
    expect(config.enabled).toBe(false);
    expect(config.dbPath).toBe(resolvePath(DEFAULT_DB_PATH));
    expect(config.pollIntervalMs).toBe(30_000);
    expect(config.allowFrom).toEqual([]);
  });

  it("reads complete config", () => {
    const home = homedir();
    const config = resolveConfig({
      channels: {
        "apple-mail": {
          enabled: true,
          dbPath: `${home}/Library/Mail/V10/Custom/Envelope Index`,
          pollIntervalMs: 10_000,
          allowFrom: ["alice@example.com", "bob@example.com"],
        },
      },
    });

    expect(config.enabled).toBe(true);
    expect(config.dbPath).toBe(`${home}/Library/Mail/V10/Custom/Envelope Index`);
    expect(config.pollIntervalMs).toBe(10_000);
    expect(config.allowFrom).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  it("handles partial config with defaults", () => {
    const config = resolveConfig({
      channels: {
        "apple-mail": {
          enabled: true,
          allowFrom: ["test@example.com"],
        },
      },
    });

    expect(config.enabled).toBe(true);
    expect(config.dbPath).toBe(resolvePath(DEFAULT_DB_PATH));
    expect(config.pollIntervalMs).toBe(30_000);
    expect(config.allowFrom).toEqual(["test@example.com"]);
  });

  it("rejects invalid pollIntervalMs", () => {
    const config = resolveConfig({
      channels: {
        "apple-mail": {
          pollIntervalMs: -100,
        },
      },
    });
    expect(config.pollIntervalMs).toBe(30_000);
  });

  it("filters non-string entries from allowFrom", () => {
    const config = resolveConfig({
      channels: {
        "apple-mail": {
          allowFrom: ["valid@test.com", 42, null, "also@valid.com"],
        },
      },
    });
    expect(config.allowFrom).toEqual(["valid@test.com", "also@valid.com"]);
  });

  it("rejects dbPath outside ~/Library/Mail/", () => {
    expect(() =>
      resolveConfig({
        channels: {
          "apple-mail": {
            dbPath: "/etc/passwd",
          },
        },
      }),
    ).toThrow("not under ~/Library/Mail/");
  });
});
