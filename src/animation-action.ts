import * as THREE from 'three';

export type AnimationActionControl = Pick<
  THREE.AnimationAction,
  'stop' | 'reset' | 'setLoop' | 'setEffectiveWeight' | 'fadeIn' | 'play'
>;

export function replaceAnimationAction(
  previous: AnimationActionControl | null,
  next: AnimationActionControl,
  fadeSeconds: number,
): void {
  if (previous !== next) previous?.stop();
  next
    .reset()
    .setLoop(THREE.LoopRepeat, Infinity)
    .setEffectiveWeight(1)
    .fadeIn(fadeSeconds)
    .play();
}
