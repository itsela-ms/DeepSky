import { describe, it, expect, vi } from 'vitest';

const {
  processSessionInput,
  isMetadataRefreshCommand,
  extractMetadataCommand,
} = require('../src/session-input-tracker');

describe('session-input-tracker', () => {
  it('recognizes /rename submissions when enter is pressed', () => {
    const onCommand = vi.fn();
    const state = processSessionInput({}, '/rename New name\r', onCommand);

    expect(state.line).toBe('');
    expect(onCommand).toHaveBeenCalledWith('/rename New name');
    expect(isMetadataRefreshCommand(onCommand.mock.calls[0][0])).toBe(true);
  });

  it('recognizes /cwd submissions as metadata refresh commands', () => {
    const onCommand = vi.fn();
    processSessionInput({}, '/cwd C:\\src\\DeepSky\r', onCommand);

    expect(onCommand).toHaveBeenCalledWith('/cwd C:\\src\\DeepSky');
    expect(isMetadataRefreshCommand('/cwd C:\\src\\DeepSky')).toBe(true);
  });

  it('tracks typing across chunks and applies word-delete edits', () => {
    const onCommand = vi.fn();
    let state = processSessionInput({}, '/rena', onCommand);
    state = processSessionInput(state, 'me old', onCommand);
    state = processSessionInput(state, '\x17new\r', onCommand);

    expect(onCommand).toHaveBeenCalledWith('/rename new');
  });

  it('ignores unrelated commands', () => {
    const onCommand = vi.fn();
    processSessionInput({}, '/help\r', onCommand);

    expect(onCommand).toHaveBeenCalledWith('/help');
    expect(isMetadataRefreshCommand('/help')).toBe(false);
  });

  it('handles pasted multiline input one command at a time', () => {
    const onCommand = vi.fn();
    const state = processSessionInput({}, '/rename First\r\n/status\r\n', onCommand);

    expect(state.line).toBe('');
    expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
      '/rename First',
      '/status',
    ]);
  });

  it('extracts metadata command details for cwd', () => {
    expect(extractMetadataCommand('/cwd "C:\\src\\DeepSky"')).toEqual({
      type: 'cwd',
      value: 'C:\\src\\DeepSky',
    });
  });

  it('extracts metadata command details for rename', () => {
    expect(extractMetadataCommand('/rename Better Session')).toEqual({
      type: 'rename',
      value: 'Better Session',
    });
  });
});
