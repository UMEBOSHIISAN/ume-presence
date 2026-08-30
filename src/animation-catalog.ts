export const ANIMATION_CATALOG = {
  idle: 'idle.vrma',
  talk1: 'talk1.vrma',
  talk2: 'talk2.vrma',
  talk3: 'talk3.vrma',
  greeting: 'greeting.vrma',
  celebrate1: 'celebrate1.vrma',
  celebrate2: 'celebrate2.vrma',
  dance1: 'dance1.vrma',
  dance2: 'dance2.vrma',
} as const;

export type AnimationType = 'IDLE' | 'GREETING' | 'TALK' | 'CELEBRATE' | 'DANCE';

export const ANIMATION_MAP: Record<AnimationType, readonly string[]> = {
  IDLE: [ANIMATION_CATALOG.idle],
  GREETING: [ANIMATION_CATALOG.greeting],
  TALK: [
    ANIMATION_CATALOG.talk1,
    ANIMATION_CATALOG.talk2,
    ANIMATION_CATALOG.talk3,
  ],
  CELEBRATE: [ANIMATION_CATALOG.celebrate1, ANIMATION_CATALOG.celebrate2],
  DANCE: [ANIMATION_CATALOG.dance1, ANIMATION_CATALOG.dance2],
};

export function randomAnimation(type: AnimationType): string {
  const choices = ANIMATION_MAP[type];
  return choices[Math.floor(Math.random() * choices.length)]!;
}

export function nextAnimation(
  type: AnimationType,
  previous: string | null = null,
): string {
  const choices = ANIMATION_MAP[type];
  const previousIndex = previous == null ? -1 : choices.indexOf(previous);
  return choices[(previousIndex + 1) % choices.length]!;
}
