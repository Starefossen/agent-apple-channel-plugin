import { describe, it, expect } from "vitest";
import { Allowlist, normalizeEmail } from "../src/security/allowlist.js";

describe("normalizeEmail", () => {
  it("lowercases an address", () => {
    expect(normalizeEmail("Hans@Flaatten.ORG")).toBe("hans@flaatten.org");
  });

  it("trims whitespace", () => {
    expect(normalizeEmail("  alice@example.com  ")).toBe("alice@example.com");
  });

  it("handles empty string", () => {
    expect(normalizeEmail("")).toBe("");
  });
});

describe("Allowlist", () => {
  const allowlist = new Allowlist([
    "hans@flaatten.org",
    "kristian.flaatten@icloud.com",
    "hakon.flaatten@icloud.com",
  ]);

  it("allows exact matches", () => {
    expect(allowlist.isAllowed("hans@flaatten.org")).toBe(true);
  });

  it("allows case-insensitive matches", () => {
    expect(allowlist.isAllowed("Hans@Flaatten.ORG")).toBe(true);
    expect(allowlist.isAllowed("KRISTIAN.FLAATTEN@ICLOUD.COM")).toBe(true);
  });

  it("rejects addresses not in the list", () => {
    expect(allowlist.isAllowed("stranger@evil.com")).toBe(false);
  });

  it("rejects empty sender", () => {
    expect(allowlist.isAllowed("")).toBe(false);
  });

  it("handles leading/trailing whitespace in sender", () => {
    expect(allowlist.isAllowed("  hans@flaatten.org  ")).toBe(true);
  });

  it("reports correct size", () => {
    expect(allowlist.size).toBe(3);
  });

  it("handles empty allowlist", () => {
    const empty = new Allowlist([]);
    expect(empty.isAllowed("anyone@example.com")).toBe(false);
    expect(empty.size).toBe(0);
  });

  it("deduplicates entries", () => {
    const duped = new Allowlist([
      "hans@flaatten.org",
      "HANS@FLAATTEN.ORG",
      "hans@flaatten.org",
    ]);
    expect(duped.size).toBe(1);
    expect(duped.isAllowed("hans@flaatten.org")).toBe(true);
  });
});
