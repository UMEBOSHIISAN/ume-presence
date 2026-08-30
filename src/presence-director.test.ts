import { describe, expect, test } from 'vitest';
import {
  THINKING_TIMEOUT_MS,
  createInitialPresenceState,
  reducePresence,
  selectPresencePresentation,
} from './presence-director';

const listening = {
  activity: 'listening',
  microphoneMuted: false,
  outputMuted: false,
  phase: 'active',
} as const;

const speaking = { ...listening, activity: 'speaking' } as const;

describe('presence director', () => {
  test('derives rest, attention, thinking, and speaking without content', () => {
    let state = createInitialPresenceState();
    expect(selectPresencePresentation(state)).toEqual({
      animation: 'IDLE', cue: null, mode: 'rest', ritual: null,
    });

    state = reducePresence(state, { type: 'voice', voice: listening });
    expect(selectPresencePresentation(state).mode).toBe('attention');

    state = reducePresence(state, { type: 'cue', cue: 'thinking' });
    expect(selectPresencePresentation(state).mode).toBe('thinking');

    state = reducePresence(state, { type: 'voice', voice: speaking });
    expect(selectPresencePresentation(state)).toEqual({
      animation: 'TALK', cue: null, mode: 'speaking', ritual: null,
    });
  });

  test('maps ritual cues and ignores a second transient cue', () => {
    let state = reducePresence(createInitialPresenceState(), {
      type: 'cue', cue: 'break',
    });
    expect(selectPresencePresentation(state)).toEqual({
      animation: 'IDLE', cue: 'break', mode: 'rest', ritual: 'break',
    });

    state = reducePresence(state, { type: 'cue', cue: 'complete' });
    expect(selectPresencePresentation(state).ritual).toBe('break');

    state = reducePresence(state, { type: 'cue', cue: 'clear' });
    expect(selectPresencePresentation(state).cue).toBeNull();
  });

  test('clears a preview when a ritual takes presentation ownership', () => {
    let state = reducePresence(createInitialPresenceState(), {
      type: 'preview', animation: 'DANCE',
    });
    state = reducePresence(state, { type: 'cue', cue: 'complete' });
    state = reducePresence(state, { type: 'cue', cue: 'clear' });

    expect(selectPresencePresentation(state)).toEqual({
      animation: 'IDLE', cue: null, mode: 'rest', ritual: null,
    });
  });

  test('ignores previews while a ritual owns presentation', () => {
    let state = reducePresence(createInitialPresenceState(), {
      type: 'cue', cue: 'break',
    });
    state = reducePresence(state, { type: 'preview', animation: 'DANCE' });

    expect(selectPresencePresentation(state)).toEqual({
      animation: 'IDLE', cue: 'break', mode: 'rest', ritual: 'break',
    });
  });

  test('lets higher-priority presentation replace thinking without coexistence', () => {
    let state = reducePresence(createInitialPresenceState(), {
      type: 'voice', voice: listening,
    });
    state = reducePresence(state, { type: 'cue', cue: 'thinking' });
    state = reducePresence(state, { type: 'cue', cue: 'complete' });

    expect(selectPresencePresentation(state)).toEqual({
      animation: 'IDLE', cue: 'complete', mode: 'complete', ritual: 'work_complete',
    });

    state = reducePresence(state, { type: 'cue', cue: 'clear' });
    state = reducePresence(state, { type: 'cue', cue: 'thinking' });
    state = reducePresence(state, { type: 'preview', animation: 'DANCE' });
    expect(selectPresencePresentation(state)).toEqual({
      animation: 'DANCE', cue: null, mode: 'attention', ritual: null,
    });
  });

  test('speech and an active-to-inactive transition cancel transients', () => {
    let state = reducePresence(createInitialPresenceState(), {
      type: 'cue', cue: 'greeting',
    });
    state = reducePresence(state, { type: 'internal-speech', active: true });
    expect(selectPresencePresentation(state).mode).toBe('speaking');
    expect(selectPresencePresentation(state).cue).toBeNull();

    state = reducePresence(state, { type: 'internal-speech', active: false });
    state = reducePresence(state, { type: 'voice', voice: listening });
    state = reducePresence(state, { type: 'cue', cue: 'thinking' });
    state = reducePresence(state, {
      type: 'voice',
      voice: { ...listening, activity: 'idle', phase: 'inactive' },
    });
    expect(selectPresencePresentation(state).mode).toBe('rest');
    expect(selectPresencePresentation(state).cue).toBeNull();
  });

  test('does not latch a ritual cue received while speech is already active', () => {
    let state = reducePresence(createInitialPresenceState(), {
      type: 'voice', voice: speaking,
    });
    state = reducePresence(state, { type: 'cue', cue: 'break' });
    state = reducePresence(state, { type: 'voice', voice: listening });

    expect(selectPresencePresentation(state)).toEqual({
      animation: 'IDLE', cue: null, mode: 'attention', ritual: null,
    });
  });

  test('keeps generic previews separate and supersedes them on voice input', () => {
    let state = reducePresence(createInitialPresenceState(), {
      type: 'preview', animation: 'DANCE',
    });
    expect(selectPresencePresentation(state).animation).toBe('DANCE');
    state = reducePresence(state, { type: 'voice', voice: listening });
    expect(selectPresencePresentation(state).animation).toBe('IDLE');
  });

  test('exports the fixed thinking safety duration', () => {
    expect(THINKING_TIMEOUT_MS).toBe(30_000);
  });
});
