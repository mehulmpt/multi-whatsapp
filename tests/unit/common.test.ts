import { describe, expect, test } from "bun:test";
import { ago, contrastText, escapeHtml, formatBytes, formatPhone, initials } from "../../src/shared/common";

describe("initials", () => {
  test.each([
    ["Account 2", "A2"],
    ["Work Phone", "WP"],
    ["work", "W"],
    ["  ", "?"],
    ["+91 98765", "91"],
    ["15550001111", "11"],
    ["émile zola", "ÉZ"],
  ])("%p → %p", (name, out) => expect(initials(name)).toBe(out));
});

describe("contrastText", () => {
  test("dark text on light colours, white on dark", () => {
    expect(contrastText("#EAB308")).toBe("#111b21");
    expect(contrastText("#3B82F6")).toBe("#ffffff");
    expect(contrastText("#000000")).toBe("#ffffff");
    expect(contrastText("#ffffff")).toBe("#111b21");
  });
});

describe("escapeHtml", () => {
  test("neutralises markup and attribute breakouts", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">'&`)).toBe("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;&#39;&#38;");
  });
});

describe("formatBytes", () => {
  test.each([
    [512, "512 B"],
    [1536, "1.5 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [300 * 1024 * 1024, "300 MB"],
    [2.5 * 1024 ** 3, "2.5 GB"],
  ])("%p → %p", (n, out) => expect(formatBytes(n)).toBe(out));
});

describe("ago", () => {
  const now = 1_000_000_000_000;
  test.each([
    [now - 5_000, "just now"],
    [now - 5 * 60_000, "5m ago"],
    [now - 3 * 3_600_000, "3h ago"],
    [now - 2 * 86_400_000, "2d ago"],
  ])("%p → %p", (ts, out) => expect(ago(ts, now)).toBe(out));
});

test("formatPhone", () => {
  expect(formatPhone("15550001111")).toBe("+15550001111");
  expect(formatPhone(undefined)).toBe("");
});
