"use strict";

const EXPECTED_SEED_SAN_BLOB =
  "ff4223f9b42c8f22be35dcf23abe477d93101300";

const REQUIRED_RIGHTS_KEYS = [
  "sourceUrl",
  "sourceCommit",
  "sourcePath",
  "gitBlobSha",
  "downloadSha256",
  "licenseUrl",
  "licenseTextSha256",
  "embeddedMetaSha256",
  "attributionText",
  "intendedUse",
  "implementerVerification",
  "independentVerification",
];

function isMissing(value) {
  return value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "");
}

function validateAdoptionContract(contract = {}, manifest = {}) {
  if (
    contract.distributionAllowed === false &&
    manifest.distributionAllowed === false
  ) {
    return [];
  }

  const errors = [];

  if (
    contract.distributionAllowed !== true ||
    manifest.distributionAllowed !== true
  ) {
    errors.push(
      "Manifest and rights contract must both explicitly enable distribution.",
    );
  }

  for (const key of REQUIRED_RIGHTS_KEYS) {
    if (isMissing(contract[key])) {
      errors.push(`Missing rights field: ${key}`);
    }
    if (Object.hasOwn(manifest, key) && manifest[key] !== contract[key]) {
      errors.push(`Manifest disagrees with rights contract: ${key}`);
    }
  }

  if (contract.gitBlobSha !== EXPECTED_SEED_SAN_BLOB) {
    errors.push("gitBlobSha does not match the pinned source blob.");
  }
  if (contract.implementerVerification !== "verified") {
    errors.push("Implementer verification must be verified.");
  }
  if (contract.independentVerification !== "verified") {
    errors.push("Independent verification must be verified.");
  }

  return errors;
}

module.exports = {
  EXPECTED_SEED_SAN_BLOB,
  REQUIRED_RIGHTS_KEYS,
  validateAdoptionContract,
};
