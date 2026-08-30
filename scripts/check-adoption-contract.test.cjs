"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  validateAdoptionContract,
} = require("./check-adoption-contract.cjs");

const candidateContract = {
  schemaVersion: 1,
  candidate: "Seed-san",
  sourceUrl: "https://github.com/vrm-c/vrm-specification",
  sourceCommit: "837f156dbce43ad69183ce1bdab549961ae1c1ee",
  sourcePath: "samples/Seed-san/vrm/Seed-san.vrm",
  gitBlobSha: "ff4223f9b42c8f22be35dcf23abe477d93101300",
  distributionAllowed: false,
  gateState: "CANDIDATE_EVIDENCE_ONLY",
};

const verifiedContract = {
  ...candidateContract,
  downloadSha256: "a".repeat(64),
  licenseUrl: "https://example.invalid/license",
  licenseTextSha256: "b".repeat(64),
  embeddedMetaSha256: "c".repeat(64),
  attributionText: "Seed-san test attribution",
  intendedUse: "temporary local Persona preflight",
  implementerVerification: "verified",
  independentVerification: "verified",
  distributionAllowed: true,
  gateState: "VERIFIED",
};

test("candidate rights evidence cannot enable distribution", () => {
  const errors = validateAdoptionContract(candidateContract, {
    distributionAllowed: true,
  });
  assert.match(errors.join("\n"), /independent verification/i);
});

test("missing rights fields fail closed", () => {
  const errors = validateAdoptionContract(
    { ...verifiedContract, licenseTextSha256: null },
    { distributionAllowed: true },
  );
  assert.match(errors.join("\n"), /licenseTextSha256/);
});

test("disabled candidate is valid for local preflight", () => {
  assert.deepEqual(
    validateAdoptionContract(candidateContract, {
      distributionAllowed: false,
    }),
    [],
  );
});

test("distribution rejects a source blob other than the pinned candidate", () => {
  const errors = validateAdoptionContract(
    { ...verifiedContract, gitBlobSha: "d".repeat(40) },
    { distributionAllowed: true },
  );
  assert.match(errors.join("\n"), /gitBlobSha.*pinned source blob/i);
});

test("distribution rejects manifest and contract disagreement", () => {
  const errors = validateAdoptionContract(verifiedContract, {
    distributionAllowed: true,
    licenseTextSha256: "d".repeat(64),
  });
  assert.match(errors.join("\n"), /disagrees.*licenseTextSha256/i);
});

test("validation does not mutate the manifest", () => {
  const manifest = Object.freeze({
    distributionAllowed: true,
    licenseTextSha256: verifiedContract.licenseTextSha256,
  });
  const before = JSON.stringify(manifest);
  validateAdoptionContract(verifiedContract, manifest);
  assert.equal(JSON.stringify(manifest), before);
});
