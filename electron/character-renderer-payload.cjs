"use strict";

function toRendererCharacter(pack) {
  const { manifest } = pack;
  return Object.freeze({
    id: manifest.id,
    displayName: manifest.displayName,
    avatar: Object.freeze({
      type: manifest.avatar.type,
      source: `data:${pack.avatarMimeType};base64,${pack.avatarBytes.toString("base64")}`,
      accessibleLabel: manifest.avatar.accessibleLabel,
      backgroundMode: manifest.avatar.backgroundMode,
      mouth: manifest.avatar.mouth,
    }),
  });
}

module.exports = {
  toRendererCharacter,
};
