import { describe, it, expect } from 'vitest';

const { shouldApplyStatusPanelUpdate } = require('../src/status-panel-state');

describe('shouldApplyStatusPanelUpdate', () => {
  it('accepts the latest request for the active session', () => {
    expect(shouldApplyStatusPanelUpdate({
      requestId: 4,
      currentRequestId: 4,
      requestedSessionId: 'session-a',
      activeSessionId: 'session-a',
      panelCollapsed: false,
    })).toBe(true);
  });

  it('rejects stale request ids after a tab switch', () => {
    expect(shouldApplyStatusPanelUpdate({
      requestId: 3,
      currentRequestId: 4,
      requestedSessionId: 'session-a',
      activeSessionId: 'session-b',
      panelCollapsed: false,
    })).toBe(false);
  });

  it('rejects updates when the panel is collapsed', () => {
    expect(shouldApplyStatusPanelUpdate({
      requestId: 5,
      currentRequestId: 5,
      requestedSessionId: 'session-a',
      activeSessionId: 'session-a',
      panelCollapsed: true,
    })).toBe(false);
  });
});
