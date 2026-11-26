import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRemoteUrl } from "../../indexer/git-diff.js";

describe("normalizeRemoteUrl", () => {
  it("treats the HTTPS, SSH and scp spellings of a repository as equal", () => {
    for (const url of [
      "https://github.com/Org/Repo.git",
      "ssh://git@github.com/org/repo",
      "git@github.com:org/repo.git",
      "github.com:org/repo/",
    ]) {
      assert.equal(normalizeRemoteUrl(url), "github.com/org/repo", url);
    }
  });

  it("drops embedded credentials", () => {
    assert.equal(
      normalizeRemoteUrl("https://user:token@example.com/org/repo.git"),
      "example.com/org/repo",
    );
  });

  it("keeps a Windows path remote intact", () => {
    assert.equal(normalizeRemoteUrl("C:/repos/demo.git"), "c:/repos/demo");
  });
});
