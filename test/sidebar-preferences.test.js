import { describe, it, expect } from 'vitest';

const { getInitialSidebarState, getNextSidebarVisibilityState } = require('../src/sidebar-preferences');

describe('getInitialSidebarState', () => {
  it('keeps collapsed and hidden state separate', () => {
    expect(getInitialSidebarState({
      sidebarWidth: 320,
      sidebarCollapsed: true,
      sidebarHidden: false,
    })).toEqual({
      lastExpandedSidebarWidth: 320,
      sidebarCollapsed: true,
      sidebarHidden: false,
    });
  });

  it('defaults hidden state to false', () => {
    expect(getInitialSidebarState({ sidebarWidth: 280 })).toEqual({
      lastExpandedSidebarWidth: 280,
      sidebarCollapsed: false,
      sidebarHidden: false,
    });
  });
});

describe('getNextSidebarVisibilityState', () => {
  it('remembers whether the visible sidebar was collapsed when hiding it', () => {
    expect(getNextSidebarVisibilityState({
      sidebarCollapsed: true,
      sidebarCollapsedBeforeHidden: false,
    }, true)).toEqual({
      sidebarHidden: true,
      sidebarCollapsed: false,
      sidebarCollapsedBeforeHidden: true,
    });
  });

  it('restores the remembered collapsed state when unhiding', () => {
    expect(getNextSidebarVisibilityState({
      sidebarCollapsed: false,
      sidebarCollapsedBeforeHidden: true,
    }, false)).toEqual({
      sidebarHidden: false,
      sidebarCollapsed: true,
      sidebarCollapsedBeforeHidden: true,
    });
  });
});
