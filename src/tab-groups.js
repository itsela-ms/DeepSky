function pruneSessionFromGroups(groups, sessionId) {
  let changed = false;
  const nextGroups = [];

  for (const group of groups) {
    if (!group || !Array.isArray(group.tabIds)) {
      nextGroups.push(group);
      continue;
    }

    if (!group.tabIds.includes(sessionId)) {
      nextGroups.push(group);
      continue;
    }

    changed = true;
    const nextTabIds = group.tabIds.filter((id) => id !== sessionId);
    if (nextTabIds.length === 0) {
      continue;
    }

    nextGroups.push({ ...group, tabIds: nextTabIds });
  }

  return changed ? nextGroups : groups;
}

module.exports = {
  pruneSessionFromGroups,
};
