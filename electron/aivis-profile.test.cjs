"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateAivisProfile } = require("./aivis-profile.cjs");

function validProfile() {
  return {
    styleId: 123,
    speedScale: 1,
    tempoDynamicsScale: 1,
    pitchScale: 0,
    volumeScale: 1,
  };
}

test("accepts an exact Aivis profile and returns a frozen copy", () => {
  const input = validProfile();
  const profile = validateAivisProfile(input);

  assert.deepEqual(profile, input);
  assert.notEqual(profile, input);
  assert.equal(Object.isFrozen(profile), true);

  input.styleId = 456;
  assert.equal(profile.styleId, 123);
});

test("accepts every documented Aivis tuning boundary", () => {
  assert.deepEqual(validateAivisProfile({
    styleId: 0,
    speedScale: 0.5,
    tempoDynamicsScale: 0,
    pitchScale: -0.15,
    volumeScale: 0,
  }), {
    styleId: 0,
    speedScale: 0.5,
    tempoDynamicsScale: 0,
    pitchScale: -0.15,
    volumeScale: 0,
  });

  assert.deepEqual(validateAivisProfile({
    styleId: Number.MAX_SAFE_INTEGER,
    speedScale: 2,
    tempoDynamicsScale: 2,
    pitchScale: 0.15,
    volumeScale: 2,
  }), {
    styleId: Number.MAX_SAFE_INTEGER,
    speedScale: 2,
    tempoDynamicsScale: 2,
    pitchScale: 0.15,
    volumeScale: 2,
  });
});

test("rejects unsafe style IDs", () => {
  for (const styleId of [
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "123",
  ]) {
    assert.throws(
      () => validateAivisProfile({ ...validProfile(), styleId }),
      Error,
      `styleId ${String(styleId)} must be rejected`,
    );
  }
});

test("rejects non-finite and out-of-range speech tuning", () => {
  const cases = [
    ["speedScale", 0.49],
    ["speedScale", 2.01],
    ["speedScale", Number.NaN],
    ["speedScale", Number.POSITIVE_INFINITY],
    ["tempoDynamicsScale", -0.01],
    ["tempoDynamicsScale", 2.01],
    ["tempoDynamicsScale", Number.NaN],
    ["pitchScale", -0.151],
    ["pitchScale", 0.151],
    ["pitchScale", Number.NEGATIVE_INFINITY],
    ["volumeScale", -0.01],
    ["volumeScale", 2.01],
    ["volumeScale", Number.POSITIVE_INFINITY],
  ];

  for (const [field, value] of cases) {
    assert.throws(
      () => validateAivisProfile({ ...validProfile(), [field]: value }),
      Error,
      `${field}=${String(value)} must be rejected`,
    );
  }
});

test("rejects missing, unknown, and executable profile fields", () => {
  for (const field of Object.keys(validProfile())) {
    const profile = validProfile();
    delete profile[field];
    assert.throws(
      () => validateAivisProfile(profile),
      Error,
      `missing ${field} must be rejected`,
    );
  }

  for (const field of [
    "command",
    "credential",
    "environment",
    "executable",
    "prompt",
    "url",
  ]) {
    assert.throws(
      () => validateAivisProfile({ ...validProfile(), [field]: "injected" }),
      Error,
      `${field} must be rejected`,
    );
  }

  for (const value of [null, [], "profile", 123]) {
    assert.throws(() => validateAivisProfile(value), Error);
  }
});
