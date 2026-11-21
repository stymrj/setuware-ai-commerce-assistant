// .env loading. No network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadEnvFile } = require("../lib/load-env");

test("loadEnvFile reads KEY=VALUE, ignores comments, and does not override", () => {
  const file = path.join(os.tmpdir(), `setuware-env-${process.pid}-${Date.now()}.env`);
  fs.writeFileSync(
    file,
    [
      "# comment",
      "",
      "SETUWARE_FROM_FILE=from-file",
      "export SETUWARE_EXPORTED=exported",
      "SETUWARE_QUOTED=\"keep me\"",
      "SETUWARE_ALREADY=from-file-should-lose",
      "not a valid line",
    ].join("\n")
  );
  const previous = process.env.SETUWARE_ALREADY;
  process.env.SETUWARE_ALREADY = "from-env";
  try {
    const first = loadEnvFile(file);
    assert.equal(first.loaded, true);
    assert.equal(process.env.SETUWARE_FROM_FILE, "from-file");
    assert.equal(process.env.SETUWARE_EXPORTED, "exported");
    assert.equal(process.env.SETUWARE_QUOTED, "keep me");
    assert.equal(process.env.SETUWARE_ALREADY, "from-env");
    assert.deepEqual(first.keys.sort(), ["SETUWARE_EXPORTED", "SETUWARE_FROM_FILE", "SETUWARE_QUOTED"]);

    const missing = loadEnvFile(path.join(os.tmpdir(), "setuware-missing.env"));
    assert.deepEqual(missing, { loaded: false, keys: [] });
  } finally {
    delete process.env.SETUWARE_FROM_FILE;
    delete process.env.SETUWARE_EXPORTED;
    delete process.env.SETUWARE_QUOTED;
    if (previous === undefined) delete process.env.SETUWARE_ALREADY;
    else process.env.SETUWARE_ALREADY = previous;
    fs.unlinkSync(file);
  }
});
