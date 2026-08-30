import { describe, expect, it } from 'vitest';
import {
  createSpeechPlayback,
  type SpeechPayload,
  type SpeechPlaybackDependencies,
  type SpeechResult,
} from './speech-playback';

class FakeAudio {
  src = '';
  paused = 0;
  playError: Error | null = null;
  listeners = new Map<string, Set<() => void>>();

  addEventListener(name: string, listener: () => void) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: () => void) {
    this.listeners.get(name)?.delete(listener);
  }

  async play() {
    if (this.playError) throw this.playError;
  }

  pause() {
    this.paused += 1;
  }

  dispatch(name: string) {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

function createHarness() {
  const audio = new FakeAudio();
  const results: SpeechResult[] = [];
  const active: boolean[] = [];
  const levels: number[] = [];
  const revoked: string[] = [];
  const cancelledFrames: number[] = [];
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let contextClosed = 0;
  let sourceDisconnected = 0;
  let analyserDisconnected = 0;
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 8,
    connect: () => {},
    disconnect: () => {
      analyserDisconnected += 1;
    },
    getByteTimeDomainData(data: Uint8Array) {
      data.fill(255);
    },
  };
  const source = {
    connect: () => {},
    disconnect: () => {
      sourceDisconnected += 1;
    },
  };
  const context = {
    destination: {},
    createAnalyser: () => analyser,
    createMediaElementSource: () => source,
    close: async () => {
      contextClosed += 1;
    },
  };
  const dependencies: SpeechPlaybackDependencies = {
    createAudio: () => audio,
    createAudioContext: () => context,
    createObjectURL: () => 'blob:speech-1',
    revokeObjectURL: (url) => revoked.push(url),
    requestFrame: (callback) => {
      const id = ++nextFrame;
      frameCallbacks.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      cancelledFrames.push(id);
      frameCallbacks.delete(id);
    },
    onActive: (value) => active.push(value),
    onLevel: (value) => levels.push(value),
    reportResult: (result) => results.push(result),
  };
  const playback = createSpeechPlayback(dependencies);
  return {
    active,
    analyser,
    audio,
    cancelledFrames,
    context,
    dependencies,
    frameCallbacks,
    levels,
    playback,
    results,
    revoked,
    source,
    get analyserDisconnected() {
      return analyserDisconnected;
    },
    get contextClosed() {
      return contextClosed;
    },
    get sourceDisconnected() {
      return sourceDisconnected;
    },
  };
}

const PAYLOAD: SpeechPayload = {
  id: 'speech-1',
  wavBytes: new Uint8Array([82, 73, 70, 70]),
};

describe('speech playback', () => {
  it('plays in memory, emits live levels, and cleans up after ending', async () => {
    const harness = createHarness();

    await harness.playback.play(PAYLOAD);
    expect(harness.results).toContainEqual({ id: 'speech-1', status: 'started' });
    expect(harness.active).toContain(true);
    expect(harness.analyser.fftSize).toBe(256);
    const frame = [...harness.frameCallbacks.values()][0];
    frame(0);
    expect(harness.levels.some((level) => level > 0)).toBe(true);

    harness.audio.dispatch('ended');
    await Promise.resolve();

    expect(harness.results).toContainEqual({ id: 'speech-1', status: 'completed' });
    expect(harness.active.at(-1)).toBe(false);
    expect(harness.levels.at(-1)).toBe(0);
    expect(harness.revoked).toEqual(['blob:speech-1']);
    expect(harness.contextClosed).toBe(1);
    expect(harness.sourceDisconnected).toBe(1);
    expect(harness.analyserDisconnected).toBe(1);
  });

  it('reports a play rejection once and releases resources', async () => {
    const harness = createHarness();
    harness.audio.playError = new Error('autoplay denied');

    await expect(harness.playback.play(PAYLOAD)).rejects.toThrow('autoplay denied');

    expect(harness.results).toEqual([
      { id: 'speech-1', status: 'failed', message: 'autoplay denied' },
    ]);
    expect(harness.active.at(-1)).toBe(false);
    expect(harness.revoked).toEqual(['blob:speech-1']);
  });

  it('reports and cleans up a Web Audio setup failure immediately', async () => {
    const harness = createHarness();
    harness.context.createMediaElementSource = () => {
      throw new Error('audio graph unavailable');
    };

    await expect(harness.playback.play(PAYLOAD)).rejects.toThrow('audio graph unavailable');

    expect(harness.results).toEqual([
      { id: 'speech-1', status: 'failed', message: 'audio graph unavailable' },
    ]);
    expect(harness.audio.paused).toBe(1);
    expect(harness.contextClosed).toBe(1);
    expect(harness.analyserDisconnected).toBe(1);
    expect(harness.active.at(-1)).toBe(false);
    expect(harness.levels.at(-1)).toBe(0);
  });

  it('reports an audio error once', async () => {
    const harness = createHarness();
    await harness.playback.play(PAYLOAD);

    harness.audio.dispatch('error');
    harness.audio.dispatch('error');
    await Promise.resolve();

    expect(harness.results.filter((result) => result.status === 'failed')).toHaveLength(1);
    expect(harness.active.at(-1)).toBe(false);
  });

  it('fails the prior operation before starting a replacement instead of queueing', async () => {
    const harness = createHarness();
    let audioCount = 0;
    harness.dependencies.createAudio = () => {
      audioCount += 1;
      return new FakeAudio();
    };
    const playback = createSpeechPlayback(harness.dependencies);

    await playback.play(PAYLOAD);
    await playback.play({ id: 'speech-2', wavBytes: new Uint8Array([1, 2]) });

    expect(audioCount).toBe(2);
    expect(harness.results).toContainEqual({
      id: 'speech-1',
      status: 'failed',
      message: 'Speech playback was replaced.',
    });
    expect(harness.results).toContainEqual({ id: 'speech-2', status: 'started' });
  });

  it('stop cancels playback and reports one terminal result', async () => {
    const harness = createHarness();
    await harness.playback.play(PAYLOAD);

    harness.playback.stop();
    harness.playback.stop();
    await Promise.resolve();

    expect(harness.audio.paused).toBe(1);
    expect(harness.cancelledFrames).toHaveLength(1);
    expect(harness.results.filter((result) => result.status !== 'started')).toEqual([
      { id: 'speech-1', status: 'failed', message: 'Speech playback stopped.' },
    ]);
    expect(harness.active.at(-1)).toBe(false);
    expect(harness.levels.at(-1)).toBe(0);
  });

  it('ignores a cancellation for another speech operation', async () => {
    const harness = createHarness();
    await harness.playback.play(PAYLOAD);

    harness.playback.stop('speech-other');

    expect(harness.audio.paused).toBe(0);
    expect(harness.results.at(-1)).toEqual({ id: 'speech-1', status: 'started' });
  });
});
