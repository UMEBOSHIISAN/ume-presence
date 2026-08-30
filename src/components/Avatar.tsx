import { Suspense, useEffect, useLayoutEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import { useVrmLoader } from '../hooks/useVrmLoader';
import { useVrmAnimation } from '../hooks/useVrmAnimation';
import { useAmplitudeLipSync } from '../hooks/useAmplitudeLipSync';
import { useBlink } from '../hooks/useBlink';
import type { AnimationType } from '../animation-catalog';

interface AvatarProps {
  animation: AnimationType;
  audioLevel: number;
  speaking: boolean;
  talkTurn: number;
  onReady?: (scene: THREE.Object3D) => void;
}

function AvatarModel({
  animation,
  audioLevel,
  speaking,
  talkTurn,
  onReady,
}: AvatarProps) {
  const vrm = useVrmLoader('./assets/model.vrm');
  const { play, update: updateAnimation } = useVrmAnimation(vrm);
  const updateLipSync = useAmplitudeLipSync(vrm);
  const updateBlink = useBlink(vrm);

  const animationRequest = animation === 'TALK' ? talkTurn : 0;

  useEffect(() => {
    void play(animation);
  }, [animation, animationRequest, play]);

  useLayoutEffect(() => {
    if (vrm) onReady?.(vrm.scene);
  }, [onReady, vrm]);

  useFrame((_, delta) => {
    if (!vrm) return;
    updateAnimation(delta);
    updateBlink(delta);
    updateLipSync(delta, audioLevel, speaking);
    vrm.update(delta);
  });

  return vrm ? <primitive object={vrm.scene} /> : null;
}

export function Avatar(props: AvatarProps) {
  return (
    <Suspense fallback={null}>
      <AvatarModel {...props} />
    </Suspense>
  );
}
