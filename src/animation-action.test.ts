import { describe, expect, it, vi } from 'vitest';
import {
  replaceAnimationAction,
  type AnimationActionControl,
} from './animation-action';

function fakeAction() {
  const action = {
    stop: vi.fn(),
    reset: vi.fn(),
    setLoop: vi.fn(),
    setEffectiveWeight: vi.fn(),
    fadeIn: vi.fn(),
    play: vi.fn(),
  };
  action.stop.mockReturnValue(action);
  action.reset.mockReturnValue(action);
  action.setLoop.mockReturnValue(action);
  action.setEffectiveWeight.mockReturnValue(action);
  action.fadeIn.mockReturnValue(action);
  action.play.mockReturnValue(action);
  return action;
}

describe('replaceAnimationAction', () => {
  it('stops the previous clip before starting the replacement', () => {
    const previous = fakeAction();
    const next = fakeAction();

    replaceAnimationAction(
      previous as unknown as AnimationActionControl,
      next as unknown as AnimationActionControl,
      0.7,
    );

    expect(previous.stop).toHaveBeenCalledOnce();
    expect(next.reset).toHaveBeenCalledOnce();
    expect(previous.stop.mock.invocationCallOrder[0]).toBeLessThan(
      next.reset.mock.invocationCallOrder[0]!,
    );
    expect(next.fadeIn).toHaveBeenCalledWith(0.7);
    expect(next.play).toHaveBeenCalledOnce();
  });
});
