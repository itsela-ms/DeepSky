const fs = require('fs');
const path = require('path');
const { isValidSessionId } = require('./app-support');

function resolveSessionPath(sessionStateDir, sessionId, relativePath = '', deps = {}) {
  const {
    realpathImpl = fs.promises.realpath,
    lstatImpl = fs.promises.lstat,
  } = deps;
  if (!isValidSessionId(sessionId)) {
    throw new Error('Invalid session ID.');
  }

  const sessionRoot = path.resolve(sessionStateDir);
  const baseSessionDir = path.resolve(sessionRoot, sessionId);
  const targetPath = path.resolve(baseSessionDir, relativePath);
  if (!targetPath.startsWith(baseSessionDir + path.sep) && targetPath !== baseSessionDir) {
    throw new Error('Invalid session directory.');
  }

  return Promise.all([
    realpathImpl(sessionRoot),
    realpathImpl(targetPath),
    lstatImpl(targetPath),
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

function resolveSessionDirectory(sessionStateDir, sessionId, deps = {}) {
  return resolveSessionPath(sessionStateDir, sessionId, '', deps);
}

function resolveSessionFilesDirectory(sessionStateDir, sessionId, deps = {}) {
  return resolveSessionPath(sessionStateDir, sessionId, 'files', deps);
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

async function getSessionDirectoryAvailability(sessionStateDir, sessionId, deps = {}) {
  const [sessionDirectoryResult, filesDirectoryResult] = await Promise.allSettled([
    Promise.resolve().then(() => resolveSessionDirectory(sessionStateDir, sessionId, deps)),
    Promise.resolve().then(() => resolveSessionFilesDirectory(sessionStateDir, sessionId, deps)),
  ]);

  return {
    sessionDirectoryAvailable: sessionDirectoryResult.status === 'fulfilled',
    filesDirectoryAvailable: filesDirectoryResult.status === 'fulfilled',
  };
}

module.exports = {
  getSessionDirectoryAvailability,
  resolveGeneratedFilePath,
  resolveSessionDirectory,
  resolveSessionFilesDirectory,
};
