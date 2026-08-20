import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();

test("Pi manifest and npm allowlist describe the runtime package", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-marginalia");
  assert.equal(manifest.version, "0.1.0");
  assert.deepEqual(manifest.pi.extensions, ["./extensions/marginalia.ts"]);
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.files, ["LICENSE", "README.md", "extensions/marginalia.ts"]);
  assert.equal(manifest.publishConfig.access, "public");
});
