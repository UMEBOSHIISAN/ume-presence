"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const lockPath = path.join(__dirname, "..", "package-lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

const requirements = {
  "fast-uri": { floor: "3.1.4", major: 3 },
  hono: { floor: "4.12.33", major: 4 },
};

function parseStableVersion(version) {
  assert.equal(typeof version, "string", "version must be a string");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  assert.ok(match, `${version} must be a stable numeric version`);
  return match.slice(1).map((part) => BigInt(part));
}

function compareVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function satisfiesCaret(version, range) {
  assert.match(range, /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const minimum = range.slice(1);
  const minimumParts = parseStableVersion(minimum);
  const versionParts = parseStableVersion(version);
  let upperParts;

  if (minimumParts[0] > 0n) {
    upperParts = [minimumParts[0] + 1n, 0n, 0n];
  } else if (minimumParts[1] > 0n) {
    upperParts = [0n, minimumParts[1] + 1n, 0n];
  } else {
    upperParts = [0n, 0n, minimumParts[2] + 1n];
  }

  const compareParts = (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] < right[index]) return -1;
      if (left[index] > right[index]) return 1;
    }
    return 0;
  };

  return compareParts(versionParts, minimumParts) >= 0
    && compareParts(versionParts, upperParts) < 0;
}

function isLeafKey(key, packageName) {
  const suffix = `/node_modules/${packageName}`;
  return key === `node_modules/${packageName}` || key.endsWith(suffix);
}

function productionLeaves(packages, packageName) {
  assert.ok(packages && typeof packages === "object" && !Array.isArray(packages));
  return Object.entries(packages)
    .filter(([key]) => isLeafKey(key, packageName))
    .filter(([, entry]) => entry?.dev !== true);
}

function assertStableMajorLeaves(packages, packageName, expectedMajor) {
  const leaves = productionLeaves(packages, packageName);
  assert.ok(leaves.length > 0, `${packageName} must have a production lock entry`);

  for (const [key, entry] of leaves) {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `${key} must be an object`);
    const [major] = parseStableVersion(entry.version);
    assert.equal(major, BigInt(expectedMajor), `${key} must remain below the next major`);
  }

  return leaves;
}

function assertLeavesAboveFloor(packages, packageName, { floor, major }) {
  const leaves = assertStableMajorLeaves(packages, packageName, major);
  for (const [key, entry] of leaves) {
    assert.ok(
      compareVersions(entry.version, floor) > 0,
      `${key} must resolve above ${floor}`,
    );
  }
}

function fixtureLeaf(version, extra = {}) {
  return { version, ...extra };
}

test("lockfile v3 preserves the frozen production dependency graph and ranges", () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.ok(lock.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages));

  const root = lock.packages[""];
  const sdk = lock.packages["node_modules/@modelcontextprotocol/sdk"];
  const ajv = lock.packages["node_modules/ajv"];
  assert.ok(root && typeof root === "object");
  assert.ok(sdk && typeof sdk === "object");
  assert.ok(ajv && typeof ajv === "object");
  assert.notEqual(sdk.dev, true);
  assert.notEqual(ajv.dev, true);

  assert.equal(root.dependencies?.["@modelcontextprotocol/sdk"], "^1.30.0");
  assert.equal(sdk.version, "1.30.0");
  assert.equal(sdk.dependencies?.ajv, "^8.17.1");
  assert.equal(sdk.dependencies?.hono, "^4.11.4");
  assert.equal(ajv.version, "8.20.0");
  assert.equal(ajv.dependencies?.["fast-uri"], "^3.0.1");

  assert.equal(satisfiesCaret(sdk.version, root.dependencies["@modelcontextprotocol/sdk"]), true);
  assert.equal(satisfiesCaret(ajv.version, sdk.dependencies.ajv), true);

  const fastUriLeaves = assertStableMajorLeaves(lock.packages, "fast-uri", 3);
  const honoLeaves = assertStableMajorLeaves(lock.packages, "hono", 4);
  for (const [, entry] of fastUriLeaves) {
    assert.equal(satisfiesCaret(entry.version, ajv.dependencies["fast-uri"]), true);
  }
  for (const [, entry] of honoLeaves) {
    assert.equal(satisfiesCaret(entry.version, sdk.dependencies.hono), true);
  }
});

test("production fast-uri entries are stable 3.x releases above 3.1.4", () => {
  assertLeavesAboveFloor(lock.packages, "fast-uri", requirements["fast-uri"]);
});

test("production hono entries are stable 4.x releases above 4.12.33", () => {
  assertLeavesAboveFloor(lock.packages, "hono", requirements.hono);
});

test("a missing production leaf is rejected", () => {
  assert.throws(
    () => assertLeavesAboveFloor({}, "fast-uri", requirements["fast-uri"]),
    /must have a production lock entry/,
  );
});

test("a dev-only leaf is rejected", () => {
  const packages = {
    "node_modules/fast-uri": fixtureLeaf("3.1.5", { dev: true }),
  };
  assert.throws(
    () => assertLeavesAboveFloor(packages, "fast-uri", requirements["fast-uri"]),
    /must have a production lock entry/,
  );
});

test("malformed and non-stable production versions are rejected", () => {
  for (const version of ["3.1", "03.1.5", "v3.1.5", "3.1.5-beta.1", "3.1.5+build", 3]) {
    const packages = { "node_modules/fast-uri": fixtureLeaf(version) };
    assert.throws(
      () => assertLeavesAboveFloor(packages, "fast-uri", requirements["fast-uri"]),
      /version must be a string|must be a stable numeric version/,
    );
  }
});

test("an unsafe nested production duplicate is rejected", () => {
  const packages = {
    "node_modules/fast-uri": fixtureLeaf("3.1.5"),
    "node_modules/example/node_modules/fast-uri": fixtureLeaf("3.1.4"),
  };
  assert.throws(
    () => assertLeavesAboveFloor(packages, "fast-uri", requirements["fast-uri"]),
    /must resolve above 3\.1\.4/,
  );
});

test("an unsafe dev duplicate does not hide a safe production leaf", () => {
  const packages = {
    "node_modules/fast-uri": fixtureLeaf("3.1.5"),
    "node_modules/example/node_modules/fast-uri": fixtureLeaf("3.1.4", { dev: true }),
  };
  assert.doesNotThrow(
    () => assertLeavesAboveFloor(packages, "fast-uri", requirements["fast-uri"]),
  );
});

test("a next-major production leaf is rejected", () => {
  for (const [packageName, version] of [["fast-uri", "4.0.0"], ["hono", "5.0.0"]]) {
    const packages = { [`node_modules/${packageName}`]: fixtureLeaf(version) };
    assert.throws(
      () => assertLeavesAboveFloor(packages, packageName, requirements[packageName]),
      /must remain below the next major/,
    );
  }
});
