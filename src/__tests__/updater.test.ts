import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  checkForUpdate,
  compareVersions,
  getCurrentVersion,
  installLatestUpdate,
} from "../core/version-check.js";

describe("checkForUpdate", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns update available when latest is newer", async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v2.0.0",
          html_url: "https://github.com/test/releases/tag/v2.0.0",
          published_at: "2025-06-01T00:00:00Z",
        }),
      }) as Response;

      const info = await checkForUpdate("1.0.0");
      assert.ok(info.updateAvailable);
      assert.equal(info.latestVersion, "2.0.0");
      assert.equal(info.currentVersion, "1.0.0");
      assert.equal(info.releaseUrl, "https://github.com/test/releases/tag/v2.0.0");
    });

    it("returns no update when versions match", async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v1.0.0",
          html_url: "https://github.com/test/releases/tag/v1.0.0",
          published_at: "2025-01-01T00:00:00Z",
        }),
      }) as Response;

      const info = await checkForUpdate("1.0.0");
      assert.equal(info.updateAvailable, false);
    });

    it("returns no update when API fails", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 404,
      }) as Response;

      const info = await checkForUpdate("1.0.0");
      assert.equal(info.updateAvailable, false);
    });

    it("returns no update on network error", async () => {
      globalThis.fetch = async () => {
        throw new Error("network error");
      };

      const info = await checkForUpdate("1.0.0");
      assert.equal(info.updateAvailable, false);
    });

    it("handles missing tag_name", async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({}),
      }) as Response;

      const info = await checkForUpdate("1.0.0");
      assert.equal(info.updateAvailable, false);
    });

    it("strips v prefix from tag", async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v3.2.1",
          html_url: "",
          published_at: "",
        }),
      }) as Response;

      const info = await checkForUpdate("1.0.0");
      assert.equal(info.latestVersion, "3.2.1");
    });
  });

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });

  it("returns 1 when a is greater", () => {
    assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  });

  it("returns -1 when a is less", () => {
    assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  });

  it("pads missing segments with zero", () => {
    assert.equal(compareVersions("1.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.1", "1.0.1"), 1);
  });
});

describe("getCurrentVersion", () => {
  it("returns the version from package.json", () => {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const expected = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }).version;
    assert.equal(getCurrentVersion(), expected);
  });

  it("returns a non-empty semver-ish string", () => {
    assert.match(getCurrentVersion(), /^\d+\.\d+\.\d+/);
  });
});

describe("installLatestUpdate", () => {
  it("reports failure when npm install throws", async () => {
    const result = await installLatestUpdate({
      _execSync: () => {
        throw new Error("npm down");
      },
      _getCurrentVersion: () => "1.0.0",
    });
    assert.equal(result.success, false);
    assert.equal(result.fromVersion, "1.0.0");
    assert.match(result.message, /npm install failed/);
    assert.match(result.message, /npm down/);
  });

  it("reports failure when runtime sync fails", async () => {
    const result = await installLatestUpdate({
      _execSync: () => "",
      _getCurrentVersion: () => "2.0.0",
      _setupRuntime: async () => ({ success: false, errors: ["junction broken"] }),
    });
    assert.equal(result.success, false);
    assert.equal(result.toVersion, "2.0.0");
    assert.match(result.message, /runtime sync failed/);
    assert.match(result.message, /junction broken/);
  });

  it("reports already up-to-date when version did not change", async () => {
    const result = await installLatestUpdate({
      _execSync: () => "",
      _getCurrentVersion: () => "1.5.0",
      _setupRuntime: async () => ({ success: true, errors: [] }),
    });
    assert.equal(result.success, true);
    assert.equal(result.fromVersion, "1.5.0");
    assert.equal(result.toVersion, "1.5.0");
    assert.match(result.message, /Already up-to-date/);
  });

  it("reports success with from/to when version increased", async () => {
    let calls = 0;
    const result = await installLatestUpdate({
      _execSync: () => "",
      _getCurrentVersion: () => (calls++ === 0 ? "1.5.0" : "1.6.0"),
      _setupRuntime: async () => ({ success: true, errors: [] }),
    });
    assert.equal(result.success, true);
    assert.equal(result.fromVersion, "1.5.0");
    assert.equal(result.toVersion, "1.6.0");
    assert.match(result.message, /Updated v1\.5\.0 .+ v1\.6\.0/);
  });
});
