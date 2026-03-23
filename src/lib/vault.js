const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const core = require('./core');

/**
 * Root directory for all workspace vaults.
 * @param {{ globalStoragePath: string, location: string, homeDir?: string }} opts
 */
function getVaultRoot(opts) {
  const { globalStoragePath, location, homeDir } = opts;
  if (location === 'userHome') {
    return path.join(homeDir || os.homedir(), '.env-switcher-vault');
  }
  return path.join(globalStoragePath, 'env-vault');
}

function ensureSecureVaultRoot(vaultRoot) {
  core.mkdirp(vaultRoot);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(vaultRoot, 0o700);
    } catch {
      // ignore
    }
  }
}

function workspaceVaultDir(vaultRoot, workspaceRoot) {
  return path.join(vaultRoot, core.workspaceScopedDirName(workspaceRoot));
}

function snapshotsDir(vaultRoot, workspaceRoot) {
  return path.join(workspaceVaultDir(vaultRoot, workspaceRoot), 'snapshots');
}

function makeSnapshotId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}_${process.pid}`;
}

function readManifestAt(snapshotPath) {
  const manifestPath = path.join(snapshotPath, 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function listSnapshotIdsDesc(snapshotsRootPath) {
  if (!fs.existsSync(snapshotsRootPath)) return [];
  return fs
    .readdirSync(snapshotsRootPath, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => b.localeCompare(a));
}

function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashFilesMap(envFolderPath, relativePaths) {
  const map = {};
  for (const rel of relativePaths) {
    const p = path.join(envFolderPath, rel);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        map[rel] = hashFile(p);
      }
    } catch {
      // skip
    }
  }
  return map;
}

function contentFingerprint(fileHashes) {
  const keys = Object.keys(fileHashes).sort();
  const h = crypto.createHash('sha256');
  for (const k of keys) {
    h.update(k);
    h.update('\0');
    h.update(fileHashes[k]);
    h.update('\0');
  }
  return h.digest('hex');
}

function pruneSnapshots(snapshotsRootPath, maxVersions) {
  const n = Number(maxVersions);
  if (!Number.isFinite(n) || n < 1) return;
  const ids = listSnapshotIdsDesc(snapshotsRootPath);
  const victims = ids.slice(n);
  for (const id of victims) {
    core.rmrfSync(path.join(snapshotsRootPath, id));
  }
}

/**
 * @returns {{ skipped: boolean, reason?: string, snapshotId: string|null, fileCount: number }}
 */
function createSnapshot(workspaceRoot, envFolderPath, options) {
  const {
    vaultRoot,
    envFolderName,
    targetFile,
    targetDirectories,
    maxVersions,
    skipIfUnchanged,
  } = options;

  const allFiles = core.listAllEnvFiles(envFolderPath);
  if (allFiles.length === 0) {
    return { skipped: true, reason: 'no-files', snapshotId: null, fileCount: 0 };
  }

  ensureSecureVaultRoot(vaultRoot);

  const snapRoot = snapshotsDir(vaultRoot, workspaceRoot);
  core.mkdirp(snapRoot);

  const fileHashes = hashFilesMap(envFolderPath, allFiles);
  const fingerprint = contentFingerprint(fileHashes);

  if (skipIfUnchanged) {
    const ids = listSnapshotIdsDesc(snapRoot);
    if (ids.length > 0) {
      const latestManifest = readManifestAt(path.join(snapRoot, ids[0]));
      if (latestManifest && latestManifest.contentFingerprint === fingerprint) {
        return {
          skipped: true,
          reason: 'unchanged',
          snapshotId: ids[0],
          fileCount: allFiles.length,
        };
      }
    }
  }

  const snapshotId = makeSnapshotId();
  const dest = path.join(snapRoot, snapshotId);
  const filesDest = path.join(dest, 'files');
  core.mkdirp(filesDest);
  core.copyDirRecursive(envFolderPath, filesDest);

  const targetDirs = core.getTargetDirectories(targetDirectories);
  const assignments = core.collectAssignments(workspaceRoot, envFolderPath, targetFile, targetDirs);

  const manifest = {
    snapshotId,
    createdAt: new Date().toISOString(),
    workspacePath: workspaceRoot,
    envFolder: envFolderName,
    targetFile,
    targetDirectories: targetDirs,
    files: allFiles,
    fileHashes,
    contentFingerprint: fingerprint,
    assignments,
  };

  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));

  pruneSnapshots(snapRoot, maxVersions);

  return { skipped: false, snapshotId, fileCount: allFiles.length };
}

function listSnapshots(vaultRoot, workspaceRoot) {
  const snapRoot = snapshotsDir(vaultRoot, workspaceRoot);
  const ids = listSnapshotIdsDesc(snapRoot);
  return ids.map((id) => {
    const m = readManifestAt(path.join(snapRoot, id));
    return {
      snapshotId: id,
      createdAt: m?.createdAt || null,
      fileCount: Array.isArray(m?.files) ? m.files.length : 0,
    };
  });
}

function getSnapshotManifest(vaultRoot, workspaceRoot, snapshotId) {
  const snapRoot = snapshotsDir(vaultRoot, workspaceRoot);
  return readManifestAt(path.join(snapRoot, snapshotId));
}

function snapshotFilesRoot(vaultRoot, workspaceRoot, snapshotId) {
  return path.resolve(path.join(snapshotsDir(vaultRoot, workspaceRoot), snapshotId, 'files'));
}

/**
 * Restore one file from a snapshot into the live .envs folder (overwrites).
 */
function restoreFileToEnvFolder(workspaceRoot, envFolderPath, vaultRoot, snapshotId, fileRelPath) {
  const filesRoot = snapshotFilesRoot(vaultRoot, workspaceRoot, snapshotId);
  const src = path.join(filesRoot, fileRelPath);
  const resolvedSrc = path.resolve(src);
  if (!resolvedSrc.startsWith(filesRoot + path.sep) && resolvedSrc !== filesRoot) {
    throw new Error('Invalid snapshot file path');
  }
  if (!fs.existsSync(resolvedSrc) || !fs.statSync(resolvedSrc).isFile()) {
    throw new Error('Snapshot file not found');
  }
  const dest = path.join(envFolderPath, fileRelPath);
  core.mkdirp(path.dirname(dest));
  fs.copyFileSync(resolvedSrc, dest);
}

/**
 * Replace the entire .envs tree with the snapshot copy.
 */
function restoreFullToEnvFolder(workspaceRoot, envFolderPath, vaultRoot, snapshotId) {
  const snapRoot = snapshotsDir(vaultRoot, workspaceRoot);
  const filesSrc = path.join(snapRoot, snapshotId, 'files');
  if (!fs.existsSync(filesSrc)) {
    throw new Error('Snapshot has no files directory');
  }
  const manifest = readManifestAt(path.join(snapRoot, snapshotId));
  core.rmrfSync(envFolderPath);
  core.mkdirp(envFolderPath);
  const restoredCount = core.copyDirRecursive(filesSrc, envFolderPath);
  return { restoredCount, manifest };
}

module.exports = {
  getVaultRoot,
  ensureSecureVaultRoot,
  workspaceVaultDir,
  snapshotsDir,
  createSnapshot,
  listSnapshots,
  getSnapshotManifest,
  restoreFileToEnvFolder,
  restoreFullToEnvFolder,
  listSnapshotIdsDesc,
};
