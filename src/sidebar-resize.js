function resolveSidebarDragWidth(rawWidth, { minWidth, maxWidth }) {
  if (rawWidth < minWidth) {
    return { mode: 'collapsed' };
  }

  return {
    mode: 'expanded',
    width: Math.min(maxWidth, rawWidth)
  };
}

module.exports = { resolveSidebarDragWidth };
