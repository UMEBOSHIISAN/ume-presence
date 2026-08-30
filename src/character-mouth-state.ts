export type CharacterMouthState = 'closed' | 'small' | 'open';

const CLOSE_LEVEL = 0.012;
const OPEN_LEVEL = 0.075;
const OPEN_HOLD_LEVEL = 0.05;

export function nextCharacterMouthState(
  previous: CharacterMouthState,
  level: number,
  speaking: boolean,
): CharacterMouthState {
  const normalized = Number.isFinite(level)
    ? Math.min(1, Math.max(0, level))
    : 0;
  if (!speaking || normalized <= CLOSE_LEVEL) return 'closed';
  if (previous === 'open' && normalized >= OPEN_HOLD_LEVEL) return 'open';
  if (normalized >= OPEN_LEVEL) return 'open';
  return 'small';
}
