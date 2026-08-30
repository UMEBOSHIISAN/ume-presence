"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  validateAdoptionContract,
} = require("./check-adoption-contract.cjs");

const PROJECT_ROOT = path.join(__dirname, "..");
const ASSET_ROOT = path.join(PROJECT_ROOT, "public", "assets");
const MANIFEST_PATH = path.join(ASSET_ROOT, "manifest.json");
const RIGHTS_CONTRACT_PATH = path.join(
  PROJECT_ROOT,
  "docs",
  "ASSET_RIGHTS_GATE.json",
);
const EXPECTED_ASSETS = [
  "model.vrm",
  "animations/idle.vrma",
  "animations/talk1.vrma",
  "animations/talk2.vrma",
  "animations/talk3.vrma",
  "animations/greeting.vrma",
  "animations/celebrate1.vrma",
  "animations/celebrate2.vrma",
  "animations/dance1.vrma",
  "animations/dance2.vrma",
];

function listRuntimeAssets(directory = ASSET_ROOT, prefix = "") {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return listRuntimeAssets(absolute, relative);
      return /\.(?:vrm|vrma)$/i.test(entry.name) ? [relative] : [];
    })
    .sort();
}

function validateAssets({
  release = false,
  assetRoot = ASSET_ROOT,
  manifestPath = MANIFEST_PATH,
  rightsContractPath = RIGHTS_CONTRACT_PATH,
} = {}) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [`Cannot read assets/manifest.json: ${error.message}`];
  }

  const manifestPaths = (manifest.assets ?? []).map((asset) => asset.path).sort();
  const expected = [...EXPECTED_ASSETS].sort();
  const actual = listRuntimeAssets(assetRoot);
  const mediaAbsent = actual.length === 0;
  if (JSON.stringify(manifestPaths) !== JSON.stringify(expected)) {
    errors.push("Asset manifest paths do not match Persona's stable asset contract.");
  }
  if ((!mediaAbsent || release) && JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push("Runtime asset files do not match Persona's stable asset contract.");
  }

  if (!mediaAbsent || release) {
    for (const relative of EXPECTED_ASSETS) {
      const absolute = path.join(assetRoot, relative);
      if (!fs.existsSync(absolute) || fs.statSync(absolute).size === 0) {
        errors.push(`Missing or empty asset: ${relative}`);
      }
    }
  }

  if (release) {
    try {
      const rightsContract = JSON.parse(
        fs.readFileSync(rightsContractPath, "utf8"),
      );
      errors.push(...validateAdoptionContract(rightsContract, manifest));
    } catch (error) {
      errors.push(`Cannot read asset rights contract: ${error.message}`);
    }
    if (manifest.distributionAllowed !== true) {
      errors.push(
        "Asset distribution is disabled. Replace the test-only files and set distributionAllowed to true.",
      );
    }
    for (const asset of manifest.assets ?? []) {
      if (
        typeof asset.license !== "string" ||
        asset.license.trim() === "" ||
        typeof asset.source !== "string" ||
        asset.source.trim() === "" ||
        asset.source === "local-test-only"
      ) {
        errors.push(`Incomplete release license metadata: ${asset.path ?? "unknown asset"}`);
      }
    }
  }
  return errors;
}

if (require.main === module) {
  const release = process.argv.includes("--release");
  const errors = validateAssets({ release });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      release
        ? "Persona assets are complete and marked for distribution."
        : "Persona asset contract is valid (local character media may be absent).",
    );
  }
}

module.exports = {
  ASSET_ROOT,
  EXPECTED_ASSETS,
  RIGHTS_CONTRACT_PATH,
  listRuntimeAssets,
  validateAssets,
};
