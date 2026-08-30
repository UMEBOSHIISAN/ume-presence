"use strict";

const z = require("zod/v4");

const AivisProfileSchema = z.strictObject({
  styleId: z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER),
  speedScale: z.number().finite().min(0.5).max(2),
  tempoDynamicsScale: z.number().finite().min(0).max(2),
  pitchScale: z.number().finite().min(-0.15).max(0.15),
  volumeScale: z.number().finite().min(0).max(2),
});

function validateAivisProfile(value) {
  return Object.freeze(AivisProfileSchema.parse(value));
}

module.exports = {
  validateAivisProfile,
};
