/**
 * @fileoverview Tests for the Web UI bind-address helpers (issue #42).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_UI_HOST,
  isWildcardHost,
  resolveUiBindHost,
  uiBaseUrls,
} from "../../web/bind.js";

describe("web bind address", () => {
  it("defaults to loopback", () => {
    assert.equal(DEFAULT_UI_HOST, "127.0.0.1");
    assert.equal(resolveUiBindHost(), "127.0.0.1");
    assert.equal(resolveUiBindHost("", ""), "127.0.0.1");
  });

  it("prefers the CLI value over the configured host", () => {
    assert.equal(resolveUiBindHost("0.0.0.0", "192.168.1.5"), "0.0.0.0");
    assert.equal(resolveUiBindHost(undefined, "192.168.1.5"), "192.168.1.5");
    assert.equal(resolveUiBindHost("  ", "192.168.1.5"), "192.168.1.5");
  });

  it("recognizes wildcard hosts", () => {
    assert.equal(isWildcardHost("0.0.0.0"), true);
    assert.equal(isWildcardHost("::"), true);
    assert.equal(isWildcardHost("[::]"), true);
    assert.equal(isWildcardHost("127.0.0.1"), false);
    assert.equal(isWildcardHost("localhost"), false);
  });

  it("prints the bound host as the URL for a concrete address", () => {
    assert.deepEqual(uiBaseUrls("127.0.0.1", 3210), ["http://127.0.0.1:3210"]);
    assert.deepEqual(uiBaseUrls("192.168.1.5", 3210), ["http://192.168.1.5:3210"]);
  });

  it("wraps IPv6 literals for URLs", () => {
    assert.deepEqual(uiBaseUrls("::1", 3210), ["http://[::1]:3210"]);
  });

  it("lists loopback first and no duplicates for a wildcard bind", () => {
    const urls = uiBaseUrls("0.0.0.0", 3210);
    assert.equal(urls[0], "http://127.0.0.1:3210");
    assert.equal(new Set(urls).size, urls.length, "no duplicate URLs");
    for (const url of urls) {
      assert.match(url, /^http:\/\/[^/]+:3210$/);
    }
  });
});
