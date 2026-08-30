export interface SpeechPayload {
  id: string;
  wavBytes: Uint8Array;
}

export type SpeechResult =
  | { id: string; status: 'started' }
  | { id: string; status: 'completed' }
  | { id: string; status: 'failed'; message: string };

interface AudioLike {
  src: string;
  addEventListener(name: 'ended' | 'error', listener: () => void): void;
  removeEventListener(name: 'ended' | 'error', listener: () => void): void;
  play(): Promise<void>;
  pause(): void;
}

interface AnalyserLike {
  fftSize: number;
  readonly frequencyBinCount: number;
  connect(destination: unknown): void;
  disconnect(): void;
  getByteTimeDomainData(data: Uint8Array): void;
}

interface MediaSourceLike {
  connect(destination: unknown): void;
  disconnect(): void;
}

interface AudioContextLike {
  readonly destination: unknown;
  createAnalyser(): AnalyserLike;
  createMediaElementSource(audio: AudioLike): MediaSourceLike;
  resume?(): Promise<void>;
  close(): Promise<void>;
}

export interface SpeechPlaybackDependencies {
  createAudio(): AudioLike;
  createAudioContext(): AudioContextLike;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  onActive(active: boolean): void;
  onLevel(level: number): void;
  reportResult(result: SpeechResult): void;
}

interface ActivePlayback {
  id: string;
  audio: AudioLike;
  context: AudioContextLike;
  analyser: AnalyserLike;
  source: MediaSourceLike;
  objectUrl: string;
  frameId: number | null;
  ended: () => void;
  errored: () => void;
  terminal: boolean;
}

const MAX_ERROR_LENGTH = 160;

function safely(action: () => void | Promise<void>) {
  try {
    const result = action();
    if (result instanceof Promise) void result.catch(() => {});
  } catch {
    // Cleanup is best-effort and must not mask the original playback result.
  }
}

function safeMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return (message.trim() || fallback).slice(0, MAX_ERROR_LENGTH);
}

function browserDependencies(
  callbacks: Pick<SpeechPlaybackDependencies, 'onActive' | 'onLevel' | 'reportResult'>,
): SpeechPlaybackDependencies {
  return {
    createAudio: () => new Audio(),
    createAudioContext: () => new AudioContext(),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    ...callbacks,
  };
}

export function createSpeechPlayback(
  dependencies:
    | SpeechPlaybackDependencies
    | Pick<SpeechPlaybackDependencies, 'onActive' | 'onLevel' | 'reportResult'>,
) {
  const deps =
    'createAudio' in dependencies ? dependencies : browserDependencies(dependencies);
  let active: ActivePlayback | null = null;

  function cleanupResources({
    audio,
    context,
    analyser,
    source,
    objectUrl,
    frameId,
  }: Partial<Pick<ActivePlayback, 'audio' | 'context' | 'analyser' | 'source' | 'objectUrl' | 'frameId'>>) {
    if (frameId != null) safely(() => deps.cancelFrame(frameId));
    if (audio) safely(() => audio.pause());
    if (source) safely(() => source.disconnect());
    if (analyser) safely(() => analyser.disconnect());
    if (context) safely(() => context.close());
    if (objectUrl) safely(() => deps.revokeObjectURL(objectUrl));
  }

  function release(operation: ActivePlayback, result: SpeechResult) {
    if (operation.terminal) return;
    operation.terminal = true;
    if (active === operation) active = null;
    operation.audio.removeEventListener('ended', operation.ended);
    operation.audio.removeEventListener('error', operation.errored);
    cleanupResources(operation);
    deps.onLevel(0);
    deps.onActive(false);
    deps.reportResult(result);
  }

  function fail(operation: ActivePlayback, message: string) {
    release(operation, { id: operation.id, status: 'failed', message });
  }

  function sampleLevel(operation: ActivePlayback) {
    if (active !== operation || operation.terminal) return;
    const values = new Uint8Array(operation.analyser.frequencyBinCount);
    operation.analyser.getByteTimeDomainData(values);
    let squareSum = 0;
    for (const value of values) {
      const normalized = (value - 128) / 128;
      squareSum += normalized * normalized;
    }
    const rms = Math.sqrt(squareSum / Math.max(1, values.length));
    deps.onLevel(Math.min(1, rms * 5));
    operation.frameId = deps.requestFrame(() => sampleLevel(operation));
  }

  async function play(payload: SpeechPayload) {
    if (!payload || typeof payload.id !== 'string' || !(payload.wavBytes instanceof Uint8Array)) {
      throw new TypeError('Invalid speech payload.');
    }
    if (active) fail(active, 'Speech playback was replaced.');

    let audio: AudioLike | undefined;
    let context: AudioContextLike | undefined;
    let analyser: AnalyserLike | undefined;
    let source: MediaSourceLike | undefined;
    let objectUrl: string | undefined;
    try {
      audio = deps.createAudio();
      context = deps.createAudioContext();
      analyser = context.createAnalyser();
      source = context.createMediaElementSource(audio);
      const bytes = payload.wavBytes.buffer.slice(
        payload.wavBytes.byteOffset,
        payload.wavBytes.byteOffset + payload.wavBytes.byteLength,
      ) as ArrayBuffer;
      objectUrl = deps.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(context.destination);
      audio.src = objectUrl;
    } catch (error) {
      cleanupResources({ audio, context, analyser, source, objectUrl });
      deps.onLevel(0);
      deps.onActive(false);
      deps.reportResult({
        id: payload.id,
        status: 'failed',
        message: safeMessage(error, 'Audio playback setup failed.'),
      });
      throw error;
    }

    const operation: ActivePlayback = {
      id: payload.id,
      audio,
      context,
      analyser,
      source,
      objectUrl,
      frameId: null,
      terminal: false,
      ended: () => {},
      errored: () => {},
    };
    operation.ended = () =>
      release(operation, { id: operation.id, status: 'completed' });
    operation.errored = () => fail(operation, 'Audio playback failed.');
    audio.addEventListener('ended', operation.ended);
    audio.addEventListener('error', operation.errored);
    active = operation;

    try {
      await context.resume?.();
      await audio.play();
    } catch (error) {
      const message = safeMessage(error, 'Audio playback failed.');
      fail(operation, message);
      throw error;
    }
    if (active !== operation || operation.terminal) {
      throw new Error('Speech playback was replaced.');
    }
    deps.onActive(true);
    deps.reportResult({ id: operation.id, status: 'started' });
    operation.frameId = deps.requestFrame(() => sampleLevel(operation));
  }

  function stop(operationId?: string) {
    if (operationId != null && active?.id !== operationId) return;
    if (active) fail(active, 'Speech playback stopped.');
  }

  return { play, stop };
}
