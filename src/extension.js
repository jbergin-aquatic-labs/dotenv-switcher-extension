const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let statusBarItem;
let envFilesProvider;
let projectFoldersProvider;
let globalStoragePath;

const DEFAULT_EXCLUDED = new Set([
  'node_modules', '.git', '.vscode', 'dist', 'build',
  '.next', 'coverage', '__pycache__', '.cache',
]);

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

function getEnvFolderPath(workspaceRoot, config) {
  const name = config.get('envFolder', '.envs');
  return path.join(workspaceRoot, name);
}

function getExcludedFolders(config) {
  const configured = config.get('excludedFolders');
  if (Array.isArray(configured)) return new Set(configured);
  return DEFAULT_EXCLUDED;
}

/**
 * List direct children (files and dirs) of a directory inside .envs.
 * Returns { files: string[], dirs: string[] } with just the names.
 */
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

/**
 * Recursively collect all env files under envFolderPath.
 * Returns relative paths like ["backend/.env.prod", "frontend/.env.test"].
 */
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

/**
 * Check what env file is symlinked as .env in a given folder.
 * Returns the relative path within .envs (e.g. "backend/.env.prod"), or null.
 */
function getAssignedEnv(folderAbsPath, envFolderPath, config) {
  const targetFile = config.get('targetFile', '.env');
  const targetPath = path.join(folderAbsPath, targetFile);
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

// ─── Env Files Tree (top section) ────────────────────────────────

class EnvFilesTreeDataProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    if (element.type === 'dir') {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'envDir';
      item.tooltip = element.relPath;
      return item;
    }

    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('file');
    item.contextValue = 'envFile';
    item.tooltip = element.absPath;
    item.description = element.relPath !== element.name ? element.relPath : '';
    item.command = {
      command: 'envSwitcher.openEnvFile',
      title: 'Open in Editor',
      arguments: [element.absPath],
    };
    return item;
  }

  getChildren(element) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return [];
    const config = vscode.workspace.getConfiguration('envSwitcher');
    const envFolderPath = getEnvFolderPath(workspaceRoot, config);
    if (!fs.existsSync(envFolderPath)) return [];

    const dirAbsPath = element ? element.absPath : envFolderPath;
    const parentRel = element ? element.relPath : '';

    const { files, dirs } = listEnvDirContents(dirAbsPath);
    const children = [];

    for (const d of dirs) {
      const rel = parentRel ? `${parentRel}/${d}` : d;
      children.push({
        type: 'dir',
        name: d,
        relPath: rel,
        absPath: path.join(dirAbsPath, d),
      });
    }

    for (const f of files) {
      const rel = parentRel ? `${parentRel}/${f}` : f;
      children.push({
        type: 'file',
        name: f,
        relPath: rel,
        absPath: path.join(dirAbsPath, f),
      });
    }

    return children;
  }
}

// ─── Project Folders Tree (bottom section) ───────────────────────

class ProjectFoldersTreeDataProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    const hasChildren = this._hasSubdirectories(element.absPath, element.excluded);
    const collapsible = hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const isRoot = element.isRoot;
    const label = isRoot ? 'Workspace root' : element.name;

    const item = new vscode.TreeItem(label, collapsible);
    item.iconPath = new vscode.ThemeIcon('folder');
    item.resourceUri = vscode.Uri.file(element.absPath);

    if (element.assignedEnv) {
      item.description = `← ${element.assignedEnv}`;
      item.contextValue = 'projectFolderAssigned';
      item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.green'));
    } else {
      item.contextValue = 'projectFolder';
    }

    item.tooltip = isRoot
      ? element.absPath
      : `${element.relPath}${element.assignedEnv ? ` (→ ${element.assignedEnv})` : ''}`;

    return item;
  }

  getChildren(element) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return [];

    const config = vscode.workspace.getConfiguration('envSwitcher');
    const envFolderPath = getEnvFolderPath(workspaceRoot, config);
    const envFolderName = config.get('envFolder', '.envs');
    const excluded = getExcludedFolders(config);

    if (!element) {
      const assignedEnv = getAssignedEnv(workspaceRoot, envFolderPath, config);
      return [
        {
          name: path.basename(workspaceRoot),
          absPath: workspaceRoot,
          relPath: '.',
          isRoot: true,
          assignedEnv,
          excluded,
          envFolderName,
        },
      ];
    }

    return this._getSubdirectories(element.absPath, workspaceRoot, excluded, envFolderName, envFolderPath, config);
  }

  _getSubdirectories(parentAbsPath, workspaceRoot, excluded, envFolderName, envFolderPath, config) {
    try {
      const entries = fs.readdirSync(parentAbsPath, { withFileTypes: true });
      return entries
        .filter((ent) => {
          if (!ent.isDirectory()) return false;
          if (excluded.has(ent.name)) return false;
          if (ent.name === envFolderName) return false;
          if (ent.name.startsWith('.')) return false;
          return true;
        })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((ent) => {
          const absPath = path.join(parentAbsPath, ent.name);
          const relPath = path.relative(workspaceRoot, absPath);
          const assignedEnv = getAssignedEnv(absPath, envFolderPath, config);
          return {
            name: ent.name,
            absPath,
            relPath,
            isRoot: false,
            assignedEnv,
            excluded,
            envFolderName,
          };
        });
    } catch {
      return [];
    }
  }

  _hasSubdirectories(parentAbsPath, excluded) {
    try {
      const entries = fs.readdirSync(parentAbsPath, { withFileTypes: true });
      return entries.some(
        (ent) => ent.isDirectory() && !excluded.has(ent.name) && !ent.name.startsWith('.')
      );
    } catch {
      return false;
    }
  }
}

// ─── Symlink operations ──────────────────────────────────────────

/**
 * envFileRelPath is relative to envFolderPath, e.g. "backend/.env.prod"
 */
async function createEnvSymlink(folderAbsPath, envFolderPath, envFileRelPath, config) {
  const targetFile = config.get('targetFile', '.env');
  const targetPath = path.join(folderAbsPath, targetFile);
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

function removeEnvSymlink(folderAbsPath, config) {
  const targetFile = config.get('targetFile', '.env');
  const targetPath = path.join(folderAbsPath, targetFile);
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

// ─── Backup & Restore ────────────────────────────────────────────

function workspaceBackupDir(workspaceRoot) {
  const hash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
  const safeName = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(globalStoragePath, 'backups', `${safeName}-${hash}`);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Recursively copy the contents of srcDir into destDir, preserving structure.
 * Returns the number of files copied.
 */
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

/**
 * Recursively remove a directory and all its contents.
 */
function rmrfSync(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Snapshot the .envs folder and current symlink assignments into the backup dir.
 * Preserves the full directory structure inside .envs.
 */
function backupEnvs(workspaceRoot, envFolderPath, config) {
  const allFiles = listAllEnvFiles(envFolderPath);
  if (allFiles.length === 0) return;

  const backupDir = workspaceBackupDir(workspaceRoot);
  const filesDir = path.join(backupDir, 'files');

  // Wipe previous backup files dir to remove stale entries, then recopy
  rmrfSync(filesDir);
  copyDirRecursive(envFolderPath, filesDir);

  const assignments = collectAssignments(workspaceRoot, envFolderPath, config);

  const manifest = {
    workspacePath: workspaceRoot,
    envFolder: config.get('envFolder', '.envs'),
    targetFile: config.get('targetFile', '.env'),
    backedUpAt: new Date().toISOString(),
    files: allFiles,
    assignments,
  };

  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

/**
 * Walk the project tree and record every folder that has a symlink pointing
 * into the .envs folder. Returns { "relative/path": "envFileRelPath", ... }.
 */
function collectAssignments(workspaceRoot, envFolderPath, config) {
  const excluded = getExcludedFolders(config);
  const envFolderName = config.get('envFolder', '.envs');
  const result = {};

  function walk(dir) {
    const relPath = path.relative(workspaceRoot, dir) || '.';
    const assigned = getAssignedEnv(dir, envFolderPath, config);
    if (assigned) {
      result[relPath] = assigned;
    }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (excluded.has(ent.name) || ent.name === envFolderName || ent.name.startsWith('.')) continue;
        walk(path.join(dir, ent.name));
      }
    } catch {
      // skip unreadable dirs
    }
  }

  walk(workspaceRoot);
  return result;
}

function getBackupManifest(workspaceRoot) {
  const backupDir = workspaceBackupDir(workspaceRoot);
  const manifestPath = path.join(backupDir, 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Restore .envs files (with full directory structure) and optionally symlink assignments.
 */
async function restoreFromBackup(workspaceRoot, config, restoreAssignments) {
  const backupDir = workspaceBackupDir(workspaceRoot);
  const manifest = getBackupManifest(workspaceRoot);
  if (!manifest) throw new Error('No backup found for this workspace');

  const envFolderName = config.get('envFolder', '.envs');
  const envFolderPath = path.join(workspaceRoot, envFolderName);
  const filesDir = path.join(backupDir, 'files');

  mkdirp(envFolderPath);
  const restoredCount = copyDirRecursive(filesDir, envFolderPath);

  if (restoreAssignments && manifest.assignments) {
    for (const [relPath, envFileRelPath] of Object.entries(manifest.assignments)) {
      const folderAbsPath = relPath === '.' ? workspaceRoot : path.join(workspaceRoot, relPath);
      if (!fs.existsSync(folderAbsPath)) continue;
      try {
        await createEnvSymlink(folderAbsPath, envFolderPath, envFileRelPath, config);
      } catch {
        // skip missing dirs/files
      }
    }
  }

  return { restoredCount, assignments: manifest.assignments };
}

// ─── Status bar ──────────────────────────────────────────────────

function refreshStatusBar() {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    statusBarItem.hide();
    return;
  }

  const config = vscode.workspace.getConfiguration('envSwitcher');
  const envFolderPath = getEnvFolderPath(workspaceRoot, config);

  if (!fs.existsSync(envFolderPath)) {
    statusBarItem.hide();
    return;
  }

  const rootActive = getAssignedEnv(workspaceRoot, envFolderPath, config);
  if (rootActive) {
    statusBarItem.text = `$(gear) env: ${rootActive}`;
  } else {
    statusBarItem.text = '$(gear) env: none';
  }
  statusBarItem.show();
}

// ─── Quick-pick helpers ──────────────────────────────────────────

/**
 * Build quick-pick items from the .envs hierarchy, with directory separators.
 */
function buildEnvQuickPickItems(envFolderPath, currentlyAssigned) {
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
      items.push({ label: dir, kind: vscode.QuickPickItemKind.Separator });
    }

    for (const rel of byDir.get(dir)) {
      const fileName = path.basename(rel);
      const isCurrent = rel === currentlyAssigned;
      items.push({
        label: isCurrent ? `$(check) ${fileName}` : fileName,
        description: dir ? dir : (isCurrent ? 'currently assigned' : ''),
        detail: isCurrent && dir ? 'currently assigned' : undefined,
        envRelPath: rel,
      });
    }
  }

  return items;
}

// ─── Activation ──────────────────────────────────────────────────

function activate(context) {
  globalStoragePath = context.globalStorageUri.fsPath;

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'envSwitcher.switchEnv';
  statusBarItem.tooltip = 'Click to switch .env file';
  context.subscriptions.push(statusBarItem);

  envFilesProvider = new EnvFilesTreeDataProvider();
  projectFoldersProvider = new ProjectFoldersTreeDataProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('envSwitcher.envFiles', envFilesProvider),
    vscode.window.registerTreeDataProvider('envSwitcher.projectFolders', projectFoldersProvider),
  );

  // On activation: check if .envs is missing but a backup exists
  const workspaceRootInit = getWorkspaceRoot();
  if (workspaceRootInit) {
    const configInit = vscode.workspace.getConfiguration('envSwitcher');
    const envFolderPathInit = getEnvFolderPath(workspaceRootInit, configInit);

    if (!fs.existsSync(envFolderPathInit)) {
      const manifest = getBackupManifest(workspaceRootInit);
      if (manifest && manifest.files && manifest.files.length > 0) {
        const age = manifest.backedUpAt
          ? `backed up ${new Date(manifest.backedUpAt).toLocaleDateString()}`
          : 'backup available';
        vscode.window
          .showInformationMessage(
            `Env Switcher: .envs folder not found, but a local backup exists (${manifest.files.length} files, ${age}). Restore it?`,
            'Restore All',
            'Restore Files Only',
            'Dismiss'
          )
          .then(async (choice) => {
            if (choice === 'Restore All' || choice === 'Restore Files Only') {
              try {
                const result = await restoreFromBackup(
                  workspaceRootInit,
                  configInit,
                  choice === 'Restore All'
                );
                envFilesProvider.refresh();
                projectFoldersProvider.refresh();
                refreshStatusBar();
                const msg = choice === 'Restore All'
                  ? `Restored ${result.restoredCount} env files and symlink assignments.`
                  : `Restored ${result.restoredCount} env files.`;
                vscode.window.showInformationMessage(`Env Switcher: ${msg}`);
              } catch (err) {
                vscode.window.showErrorMessage(`Env Switcher: Restore failed — ${err.message}`);
              }
            }
          });
      }
    } else if (configInit.get('autoBackup', true)) {
      backupEnvs(workspaceRootInit, envFolderPathInit, configInit);
    }
  }

  // Refresh both trees
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.refreshEnvList', () => {
      envFilesProvider.refresh();
      projectFoldersProvider.refresh();
      refreshStatusBar();
    })
  );

  // Open an env file in the editor
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.openEnvFile', async (absPathOrNode) => {
      const filePath = typeof absPathOrNode === 'string' ? absPathOrNode : absPathOrNode?.absPath;
      if (!filePath) return;
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    })
  );

  // Right-click → Assign .env File
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.assignEnv', async (node) => {
      if (!node) return;
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return;

      const config = vscode.workspace.getConfiguration('envSwitcher');
      const envFolderPath = getEnvFolderPath(workspaceRoot, config);
      const currentlyAssigned = getAssignedEnv(node.absPath, envFolderPath, config);
      const items = buildEnvQuickPickItems(envFolderPath, currentlyAssigned);

      if (items.length === 0) {
        vscode.window.showWarningMessage('No env files found in .envs folder.');
        return;
      }

      const dirLabel = node.isRoot ? 'workspace root' : node.relPath;
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select env file for ${dirLabel}`,
      });

      if (!selected || !selected.envRelPath) return;

      try {
        await createEnvSymlink(node.absPath, envFolderPath, selected.envRelPath, config);
        projectFoldersProvider.refresh();
        refreshStatusBar();
        if (config.get('autoBackup', true)) {
          backupEnvs(workspaceRoot, envFolderPath, config);
        }
        vscode.window.showInformationMessage(
          `Env Switcher: Assigned ${selected.envRelPath} → ${dirLabel}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Env Switcher: ${err.message}`);
      }
    })
  );

  // Right-click → Remove .env Assignment
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.unassignEnv', async (node) => {
      if (!node) return;

      const config = vscode.workspace.getConfiguration('envSwitcher');
      const dirLabel = node.isRoot ? 'workspace root' : node.relPath;

      const confirm = await vscode.window.showWarningMessage(
        `Remove .env symlink from ${dirLabel}?`,
        { modal: true },
        'Remove'
      );

      if (confirm !== 'Remove') return;

      if (removeEnvSymlink(node.absPath, config)) {
        projectFoldersProvider.refresh();
        refreshStatusBar();
        const wr = getWorkspaceRoot();
        if (wr && config.get('autoBackup', true)) {
          backupEnvs(wr, getEnvFolderPath(wr, config), config);
        }
        vscode.window.showInformationMessage(`Env Switcher: Removed .env from ${dirLabel}`);
      } else {
        vscode.window.showWarningMessage(`No .env symlink found in ${dirLabel}`);
      }
    })
  );

  // Quick-pick switch command (status bar click / command palette)
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.switchEnv', async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('Env Switcher: No workspace folder open.');
        return;
      }

      const config = vscode.workspace.getConfiguration('envSwitcher');
      const envFolderPath = getEnvFolderPath(workspaceRoot, config);

      if (!fs.existsSync(envFolderPath)) {
        vscode.window.showErrorMessage(
          `Env Switcher: "${config.get('envFolder', '.envs')}" folder not found. Create it and add your .env files there.`
        );
        return;
      }

      const currentActive = getAssignedEnv(workspaceRoot, envFolderPath, config);
      const items = buildEnvQuickPickItems(envFolderPath, currentActive);

      if (items.length === 0) {
        vscode.window.showErrorMessage('Env Switcher: No files found in .envs folder.');
        return;
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select environment for workspace root',
      });

      if (!selected || !selected.envRelPath) return;

      try {
        await createEnvSymlink(workspaceRoot, envFolderPath, selected.envRelPath, config);
        projectFoldersProvider.refresh();
        refreshStatusBar();
        if (config.get('autoBackup', true)) {
          backupEnvs(workspaceRoot, envFolderPath, config);
        }
        vscode.window.showInformationMessage(`Env Switcher: Switched root to ${selected.envRelPath}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Env Switcher: ${err.message}`);
      }
    })
  );

  // Manual backup command
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.backupNow', () => {
      const wr = getWorkspaceRoot();
      if (!wr) return;
      const cfg = vscode.workspace.getConfiguration('envSwitcher');
      const efp = getEnvFolderPath(wr, cfg);
      if (!fs.existsSync(efp)) {
        vscode.window.showWarningMessage('Env Switcher: No .envs folder to back up.');
        return;
      }
      backupEnvs(wr, efp, cfg);
      vscode.window.showInformationMessage('Env Switcher: Backup saved to local storage.');
    })
  );

  // Manual restore command
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.restoreBackup', async () => {
      const wr = getWorkspaceRoot();
      if (!wr) return;
      const cfg = vscode.workspace.getConfiguration('envSwitcher');
      const manifest = getBackupManifest(wr);

      if (!manifest) {
        vscode.window.showWarningMessage('Env Switcher: No backup found for this workspace.');
        return;
      }

      const age = manifest.backedUpAt
        ? new Date(manifest.backedUpAt).toLocaleString()
        : 'unknown date';
      const choice = await vscode.window.showInformationMessage(
        `Restore from backup? (${manifest.files.length} files, ${age})`,
        { modal: true },
        'Restore All',
        'Restore Files Only'
      );

      if (!choice) return;

      try {
        const result = await restoreFromBackup(wr, cfg, choice === 'Restore All');
        envFilesProvider.refresh();
        projectFoldersProvider.refresh();
        refreshStatusBar();
        const msg = choice === 'Restore All'
          ? `Restored ${result.restoredCount} env files and symlink assignments.`
          : `Restored ${result.restoredCount} env files.`;
        vscode.window.showInformationMessage(`Env Switcher: ${msg}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Env Switcher: Restore failed — ${err.message}`);
      }
    })
  );

  refreshStatusBar();

  // File watcher for live updates
  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '{.envs/**,**/.env}')
    );
    const refreshAll = () => {
      envFilesProvider.refresh();
      projectFoldersProvider.refresh();
      refreshStatusBar();

      const cfg = vscode.workspace.getConfiguration('envSwitcher');
      if (cfg.get('autoBackup', true)) {
        const efp = getEnvFolderPath(workspaceRoot, cfg);
        if (fs.existsSync(efp)) {
          backupEnvs(workspaceRoot, efp, cfg);
        }
      }
    };
    watcher.onDidChange(refreshAll);
    watcher.onDidCreate(refreshAll);
    watcher.onDidDelete(refreshAll);
    context.subscriptions.push(watcher);
  }
}

function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

module.exports = { activate, deactivate };
