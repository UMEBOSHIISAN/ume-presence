import { useCallback, useEffect, useRef } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { replaceAnimationAction } from '../animation-action';
import { nextAnimation, type AnimationType } from '../animation-catalog';

function transitionSeconds(previous: AnimationType | null, next: AnimationType): number {
  if (previous === 'TALK' && next === 'IDLE') return 1.15;
  if (next === 'TALK') return 0.85;
  return 0.7;
}

export function useVrmAnimation(vrm: VRM | null) {
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const current = useRef<THREE.AnimationAction | null>(null);
  const currentType = useRef<AnimationType | null>(null);
  const cache = useRef(new Map<string, VRMAnimation>());
  const previousAnimation = useRef(new Map<AnimationType, string>());
  const requestGeneration = useRef(0);

  useEffect(() => {
    if (!vrm) return;
    const animationHistory = previousAnimation.current;
    mixer.current = new THREE.AnimationMixer(vrm.scene);
    return () => {
      mixer.current?.stopAllAction();
      mixer.current = null;
      current.current = null;
      currentType.current = null;
      animationHistory.clear();
    };
  }, [vrm]);

  const load = useCallback(async (path: string) => {
    const cached = cache.current.get(path);
    if (cached) return cached;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.loadAsync(`./assets/animations/${path}`);
    const animation = gltf.userData.vrmAnimations?.[0] as VRMAnimation | undefined;
    if (!animation) throw new Error(`No VRM animation found in ${path}`);
    cache.current.set(path, animation);
    return animation;
  }, []);

  const play = useCallback(
    async (type: AnimationType) => {
      if (!vrm || !mixer.current) return;
      const generation = ++requestGeneration.current;
      try {
        const path = nextAnimation(
          type,
          previousAnimation.current.get(type) ?? null,
        );
        previousAnimation.current.set(type, path);
        const animation = await load(path);
        if (generation !== requestGeneration.current || !mixer.current) return;
        const action = mixer.current.clipAction(createVRMAnimationClip(animation, vrm));
        const fadeSeconds = transitionSeconds(currentType.current, type);
        replaceAnimationAction(current.current, action, fadeSeconds);
        current.current = action;
        currentType.current = type;
      } catch (error) {
        console.warn('[persona] animation load failed', error);
      }
    },
    [load, vrm],
  );

  const update = useCallback((delta: number) => mixer.current?.update(delta), []);
  return { play, update };
}
