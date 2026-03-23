const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_EXCLUDED = new Set([
  'node_modules', '.git', '.vscode', 'dist', 'build',
  '.next', 'coverage', '__pycache__', '.cache',
]);

function getEnvFolderPath(workspaceRoot, envFolderName) {
  const name = envFolderName || '.envs';
  return path.join(workspaceRoot, name);
}

function getExcludedFolders(configured) {
  if (Array.isArray(configured)) return new Set(configured);
  return DEFAULT_EXCLUDED;
}

/**
 * Normalized list of target directory paths relative to workspace (e.g. ".", "frontend").
 */
function getTargetDirectories(targetDirectoriesConfig) {
  const raw = targetDirectoriesConfig;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((s) => String(s).trim()).filter((s) => s.length > 0);
  }
  return ['.'];
}

function listEnvDirContents(dirAbsPath) {
  if (!fs.existsSync(dirAbsPath)) return { files: [], dirs: [] };
  try {
    const entries = fs.readdirSync(dirAbsPath, { withFileTypes: true });
    const files = [];
    const dirs = [];
    for (const ent of entries) {
      if (ent.isFile()) files.push(ent.name);
      else if (ent.isDirectory()) dirs.push(ent.name);
    }
    files.sort();
    dirs.sort();
    return { files, dirs };
  } catch {
    return { files: [], dirs: [] };
  }
}

function listAllEnvFiles(envFolderPath) {
  const results = [];
  function walk(dir, prefix) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isFile()) results.push(rel);
        else if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
      }
    } catch {
      // skip unreadable dirs
    }
  }
  if (fs.existsSync(envFolderPath)) walk(envFolderPath, '');
  results.sort();
  return results;
}

function getAssignedEnv(folderAbsPath, envFolderPath, targetFile) {
  const tf = targetFile || '.env';
  const targetPath = path.join(folderAbsPath, tf);
  try {
    const stats = fs.lstatSync(targetPath);
    if (stats.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(targetPath);
      const resolved = path.resolve(path.dirname(targetPath), linkTarget);
      const envFolderResolved = path.resolve(envFolderPath);
      if (resolved.startsWith(envFolderResolved + path.sep) || resolved === envFolderResolved) {
        return path.relative(envFolderResolved, resolved);
      }
    }
  } catch {
    // no symlink
  }
  return null;
}

function createEnvSymlink(folderAbsPath, envFolderPath, envFileRelPath, targetFile) {
  const tf = targetFile || '.env';
  const targetPath = path.join(folderAbsPath, tf);
  const sourcePath = path.join(envFolderPath, envFileRelPath);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Env file "${envFileRelPath}" not found in .envs folder`);
  }

  try {
    const stats = fs.lstatSync(targetPath);
    if (stats.isSymbolicLink() || stats.isFile()) {
      fs.unlinkSync(targetPath);
    }
  } catch {
    // doesn't exist yet
  }

  const relativeSource = path.relative(folderAbsPath, sourcePath);
  fs.symlinkSync(relativeSource, targetPath);
}

function removeEnvSymlink(folderAbsPath, targetFile) {
  const tf = targetFile || '.env';
  const targetPath = path.join(folderAbsPath, tf);
  try {
    const stats = fs.lstatSync(targetPath);
    if (stats.isSymbolicLink()) {
      fs.unlinkSync(targetPath);
      return true;
    }
  } catch {
    // nothing to remove
  }
  return false;
}

function workspaceScopedDirName(workspaceRoot) {
  const hash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
  const safeName = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safeName}-${hash}`;
}

function workspaceBackupDir(globalStoragePath, workspaceRoot) {
  return path.join(globalStoragePath, 'backups', workspaceScopedDirName(workspaceRoot));
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirRecursive(srcDir, destDir) {
  let count = 0;
  mkdirp(destDir);
  try {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const ent of entries) {
      const srcPath = path.join(srcDir, ent.name);
      const destPath = path.join(destDir, ent.name);
      if (ent.isFile()) {
        try { fs.copyFileSync(srcPath, destPath); count++; } catch { /* skip */ }
      } else if (ent.isDirectory()) {
        count += copyDirRecursive(srcPath, destPath);
      }
    }
  } catch {
    // skip unreadable
  }
  return count;
}

function rmrfSync(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function collectAssignments(workspaceRoot, envFolderPath, targetFile, targetDirs) {
  const result = {};
  for (const rel of targetDirs) {
    const folderAbsPath = rel === '.' || rel === '' ? workspaceRoot : path.join(workspaceRoot, rel);
    if (!fs.existsSync(folderAbsPath)) continue;
    const assigned = getAssignedEnv(folderAbsPath, envFolderPath, targetFile);
    if (assigned) {
      const key = rel === '' ? '.' : rel;
      result[key] = assigned;
    }
  }
  return result;
}

function backupEnvs(workspaceRoot, envFolderPath, options) {
  const {
    globalStoragePath,
    envFolderName,
    targetFile,
    targetDirectories,
  } = options;

  const allFiles = listAllEnvFiles(envFolderPath);
  if (allFiles.length === 0) return;

  const backupDir = workspaceBackupDir(globalStoragePath, workspaceRoot);
  const filesDir = path.join(backupDir, 'files');

  rmrfSync(filesDir);
  copyDirRecursive(envFolderPath, filesDir);

  const targetDirs = getTargetDirectories(targetDirectories);
  const assignments = collectAssignments(workspaceRoot, envFolderPath, targetFile, targetDirs);

  const manifest = {
    workspacePath: workspaceRoot,
    envFolder: envFolderName,
    targetFile,
    targetDirectories: targetDirs,
    backedUpAt: new Date().toISOString(),
    files: allFiles,
    assignments,
  };

  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function getBackupManifest(globalStoragePath, workspaceRoot) {
  const backupDir = workspaceBackupDir(globalStoragePath, workspaceRoot);
  const manifestPath = path.join(backupDir, 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

async function restoreFromBackup(workspaceRoot, envFolderName, targetFile, globalStoragePath, restoreAssignments) {
  const manifest = getBackupManifest(globalStoragePath, workspaceRoot);
  if (!manifest) throw new Error('No backup found for this workspace');

  const envFolderPathResolved = path.join(workspaceRoot, envFolderName);
  const backupDir = workspaceBackupDir(globalStoragePath, workspaceRoot);
  const filesDir = path.join(backupDir, 'files');

  mkdirp(envFolderPathResolved);
  const restoredCount = copyDirRecursive(filesDir, envFolderPathResolved);

  if (restoreAssignments && manifest.assignments) {
    for (const [relPath, envFileRelPath] of Object.entries(manifest.assignments)) {
      const folderAbsPath = relPath === '.' ? workspaceRoot : path.join(workspaceRoot, relPath);
      if (!fs.existsSync(folderAbsPath)) continue;
      try {
        createEnvSymlink(folderAbsPath, envFolderPathResolved, envFileRelPath, targetFile);
      } catch {
        // skip missing dirs/files
      }
    }
  }

  return { restoredCount, assignments: manifest.assignments };
}

/**
 * Plain quick-pick descriptors (no vscode types). Extension maps separators to QuickPickItemKind.
 */
function buildEnvQuickPickDescriptors(envFolderPath, currentlyAssigned) {
  const allFiles = listAllEnvFiles(envFolderPath);
  if (allFiles.length === 0) return [];

  const byDir = new Map();
  for (const rel of allFiles) {
    const dir = path.dirname(rel);
    const key = dir === '.' ? '' : dir;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key).push(rel);
  }

  const items = [];
  const sortedDirs = [...byDir.keys()].sort();
  for (const dir of sortedDirs) {
    if (dir && items.length > 0) {
      items.push({ kind: 'separator', label: dir });
    }

    for (const rel of byDir.get(dir)) {
      const fileName = path.basename(rel);
      const isCurrent = rel === currentlyAssigned;
      items.push({
        kind: 'item',
        label: isCurrent ? `$(check) ${fileName}` : fileName,
        description: dir ? dir : (isCurrent ? 'currently assigned' : ''),
        detail: isCurrent && dir ? 'currently assigned' : undefined,
        envRelPath: rel,
      });
    }
  }

  return items;
}

/**
 * Copy a file inside .envs to a new relative path (no path traversal outside .envs).
 */
function duplicateEnvFileInFolder(envFolderPath, sourceRelPath, destRelPath) {
  const src = path.join(envFolderPath, sourceRelPath);
  const dest = path.join(envFolderPath, destRelPath);
  const resolvedSrc = path.resolve(src);
  const resolvedDest = path.resolve(dest);
  const resolvedEnv = path.resolve(envFolderPath);
  if (!resolvedSrc.startsWith(resolvedEnv + path.sep) && resolvedSrc !== resolvedEnv) {
    throw new Error('Source path must be inside .envs folder');
  }
  if (!resolvedDest.startsWith(resolvedEnv + path.sep) && resolvedDest !== resolvedEnv) {
    throw new Error('Destination path must be inside .envs folder');
  }
  if (!fs.existsSync(resolvedSrc) || !fs.statSync(resolvedSrc).isFile()) {
    throw new Error('Source env file not found');
  }
  mkdirp(path.dirname(resolvedDest));
  if (fs.existsSync(resolvedDest)) {
    throw new Error('A file already exists at the destination path');
  }
  fs.copyFileSync(resolvedSrc, resolvedDest);
  return resolvedDest;
}

function resolveTargetFolderAbs(workspaceRoot, rel) {
  if (rel === '.' || rel === '' || rel === undefined) return workspaceRoot;
  return path.join(workspaceRoot, rel);
}

/**
 * Debounces calls; delay is re-read from getDelayMs on each schedule() so settings can change.
 * @param {() => number} getDelayMs
 * @param {() => void} fn
 */
function createAdaptiveDebouncedScheduler(getDelayMs, fn) {
  let timer;
  return {
    schedule() {
      const delayMs = getDelayMs();
      if (delayMs <= 0) {
        clearTimeout(timer);
        fn();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(fn, delayMs);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

module.exports = {
  DEFAULT_EXCLUDED,
  getEnvFolderPath,
  getExcludedFolders,
  getTargetDirectories,
  listEnvDirContents,
  listAllEnvFiles,
  getAssignedEnv,
  createEnvSymlink,
  removeEnvSymlink,
  workspaceScopedDirName,
  workspaceBackupDir,
  mkdirp,
  copyDirRecursive,
  rmrfSync,
  collectAssignments,
  backupEnvs,
  getBackupManifest,
  restoreFromBackup,
  buildEnvQuickPickDescriptors,
  duplicateEnvFileInFolder,
  resolveTargetFolderAbs,
  createAdaptiveDebouncedScheduler,
};
