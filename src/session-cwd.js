const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

async function readOptionalFileWithMtime(filePath) {
  try {
    const [content, stat] = await Promise.all([
      fs.promises.readFile(filePath, 'utf8'),
      fs.promises.stat(filePath),
    ]);
    const value = content.trim();
    return value ? { value, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function readWorkspaceCwdWithMtime(sessionDir) {
  const workspacePath = path.join(sessionDir, 'workspace.yaml');
  try {
    const [content, stat] = await Promise.all([
      fs.promises.readFile(workspacePath, 'utf8'),
      fs.promises.stat(workspacePath),
    ]);
    const meta = yaml.load(content) || {};
    const value = typeof meta.cwd === 'string' ? meta.cwd.trim() : '';
    return value ? { value, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function readPreferredSessionCwd(sessionDir) {
  const [overrideCwd, workspaceCwd] = await Promise.all([
    readOptionalFileWithMtime(path.join(sessionDir, '.deepsky-cwd')),
    readWorkspaceCwdWithMtime(sessionDir),
  ]);

  if (overrideCwd && (!workspaceCwd || overrideCwd.mtimeMs >= workspaceCwd.mtimeMs)) {
    return overrideCwd.value;
  }

  if (workspaceCwd) {
    return workspaceCwd.value;
  }

  return overrideCwd?.value || '';
}

module.exports = {
  readPreferredSessionCwd,
};
