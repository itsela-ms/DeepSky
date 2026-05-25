function getInitialSidebarState(settings = {}) {
  return {
    lastExpandedSidebarWidth: settings.sidebarWidth || 280,
    sidebarCollapsed: !!settings.sidebarCollapsed,
    sidebarHidden: !!settings.sidebarHidden,
  };
}

function getNextSidebarVisibilityState({ sidebarCollapsed, sidebarCollapsedBeforeHidden }, hidden) {
  if (hidden) {
    return {
      sidebarHidden: true,
      sidebarCollapsed: false,
      sidebarCollapsedBeforeHidden: !!sidebarCollapsed,
    };
  }

  return {
    sidebarHidden: false,
    sidebarCollapsed: !!sidebarCollapsedBeforeHidden,
    sidebarCollapsedBeforeHidden: !!sidebarCollapsedBeforeHidden,
  };
}

module.exports = { getInitialSidebarState, getNextSidebarVisibilityState };
