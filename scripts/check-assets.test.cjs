"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EXPECTED_ASSETS, validateAssets } = require("./check-assets.cjs");

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-assets-"));
  const assetRoot = path.join(root, "assets");
  fs.mkdirSync(assetRoot, { recursive: true });
  const manifestPath = path.join(assetRoot, "manifest.json");
  const rightsContractPath = path.join(root, "ASSET_RIGHTS_GATE.json");
  fs.copyFileSync(
    path.join(__dirname, "..", "public", "assets", "manifest.json"),
    manifestPath,
  );
  fs.copyFileSync(
    path.join(__dirname, "..", "docs", "ASSET_RIGHTS_GATE.json"),
    rightsContractPath,
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { assetRoot, manifestPath, rightsContractPath };
}

test("development accepts the complete local set or no media", (context) => {
  assert.deepEqual(validateAssets(), []);
  const fixture = createFixture(context);
  assert.deepEqual(validateAssets(fixture), []);
});

test("development rejects a partial local media set", (context) => {
  const fixture = createFixture(context);
  const partial = path.join(fixture.assetRoot, EXPECTED_ASSETS[0]);
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, "local test media");
  assert.ok(
    validateAssets(fixture).some((error) =>
      error.includes("Runtime asset files do not match"),
    ),
  );
});

test("local temporary assets are rejected by the release gate", () => {
  const errors = validateAssets({ release: true });
  assert.ok(errors.some((error) => error.includes("distribution is disabled")));
});

test("release cannot bypass independent rights verification", (context) => {
  const fixture = createFixture(context);
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
  manifest.distributionAllowed = true;
  for (const asset of manifest.assets) {
    asset.license = "CC0-1.0";
    asset.source = "https://example.invalid/verified-source";
    const absolute = path.join(fixture.assetRoot, asset.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "non-empty fixture");
  }
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest));

  const errors = validateAssets({ ...fixture, release: true });
  assert.match(errors.join("\n"), /independent verification/i);
});
