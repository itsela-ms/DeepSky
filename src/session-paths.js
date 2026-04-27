const fs = require('fs');
const path = require('path');
const { isValidSessionId } = require('./app-support');

function resolveSessionDirectory(sessionStateDir, sessionId, deps = {}) {
  const {
    realpathImpl = fs.promises.realpath,
    lstatImpl = fs.promises.lstat,
  } = deps;
  if (!isValidSessionId(sessionId)) {
    throw new Error('Invalid session ID.');
  }

  const sessionRoot = path.resolve(sessionStateDir);
  const sessionDir = path.resolve(sessionRoot, sessionId);
  if (!sessionDir.startsWith(sessionRoot + path.sep) && sessionDir !== sessionRoot) {
    throw new Error('Invalid session directory.');
  }

  return Promise.all([
    realpathImpl(sessionRoot),
    realpathImpl(sessionDir),
    lstatImpl(sessionDir),
  ]).then(([sessionRootRealPath, resolvedDir, sessionStat]) => {
    if (
      sessionStat.isSymbolicLink() ||
      !sessionStat.isDirectory()
    ) {
      throw new Error('Session directory no longer exists.');
    }
    if (!resolvedDir.startsWith(sessionRootRealPath + path.sep) && resolvedDir !== sessionRootRealPath) {
      throw new Error('Invalid session directory.');
    }
    return resolvedDir;
  });
}

function resolveGeneratedFilePath(sessionStateDir, sessionId, relativePath, deps = {}) {
  const {
    realpathImpl = fs.promises.realpath,
    lstatImpl = fs.promises.lstat,
  } = deps;

  if (!isValidSessionId(sessionId) || typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Invalid generated file request.');
  }

  const sessionRoot = path.resolve(sessionStateDir);
  const sessionDir = path.resolve(sessionRoot, sessionId);
  const filesRoot = path.resolve(sessionDir, 'files');
  const targetPath = path.resolve(sessionDir, relativePath);
  if (!targetPath.startsWith(filesRoot + path.sep) && targetPath !== filesRoot) {
    throw new Error('Generated file must be inside the session files folder.');
  }

  return Promise.all([
    realpathImpl(sessionRoot),
    realpathImpl(filesRoot),
    realpathImpl(targetPath),
    lstatImpl(filesRoot),
    lstatImpl(targetPath),
  ]).then(([sessionRootRealPath, filesRootRealPath, targetRealPath, filesRootStat, targetStat]) => {
    if (
      filesRootStat.isSymbolicLink() ||
      !filesRootStat.isDirectory() ||
      (!filesRootRealPath.startsWith(sessionRootRealPath + path.sep) && filesRootRealPath !== sessionRootRealPath) ||
      (!targetRealPath.startsWith(filesRootRealPath + path.sep) && targetRealPath !== filesRootRealPath) ||
      targetStat.isSymbolicLink() ||
      !targetStat.isFile()
    ) {
      throw new Error('Generated file no longer exists.');
    }
    return targetRealPath;
  });
}

module.exports = {
  resolveGeneratedFilePath,
  resolveSessionDirectory,
};
