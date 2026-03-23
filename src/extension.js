const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const core = require('./lib/core');

let statusBarItem;
let envFilesProvider;
let projectFoldersProvider;
let globalStoragePath;

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

function readConfig() {
  return vscode.workspace.getConfiguration('envSwitcher');
}

function envFolderAbs(workspaceRoot, config) {
  return core.getEnvFolderPath(workspaceRoot, config.get('envFolder', '.envs'));
}

function buildEnvQuickPickItems(envFolderPath, currentlyAssigned) {
  const descriptors = core.buildEnvQuickPickDescriptors(envFolderPath, currentlyAssigned);
  return descriptors.map((d) => {
    if (d.kind === 'separator') {
      return { label: d.label, kind: vscode.QuickPickItemKind.Separator };
    }
    return {
      label: d.label,
      description: d.description,
      detail: d.detail,
      envRelPath: d.envRelPath,
    };
  });
}

function runBackupIfEnabled(workspaceRoot, config) {
  if (!config.get('autoBackup', true)) return;
  const efp = envFolderAbs(workspaceRoot, config);
  if (fs.existsSync(efp)) {
    core.backupEnvs(workspaceRoot, efp, {
      globalStoragePath,
      envFolderName: config.get('envFolder', '.envs'),
      targetFile: config.get('targetFile', '.env'),
      targetDirectories: config.get('targetDirectories'),
    });
  }
}

// ─── Env Files Tree ────────────────────────────────────────────────

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
    const config = readConfig();
    const envFolderPath = envFolderAbs(workspaceRoot, config);
    if (!fs.existsSync(envFolderPath)) return [];

    const dirAbsPath = element ? element.absPath : envFolderPath;
    const parentRel = element ? element.relPath : '';

    const { files, dirs } = core.listEnvDirContents(dirAbsPath);
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

// ─── Project Folders Tree (per targetDirectories) ─────────────────

class ProjectFoldersTreeDataProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('folder');
    item.resourceUri = vscode.Uri.file(element.absPath);

    if (!element.exists) {
      item.description = 'missing path';
      item.contextValue = 'projectFolderMissing';
    } else if (element.assignedEnv) {
      item.description = `← ${element.assignedEnv}`;
      item.contextValue = 'projectFolderAssigned';
      item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.green'));
    } else {
      item.contextValue = 'projectFolder';
    }

    item.tooltip = element.exists
      ? `${element.absPath}${element.assignedEnv ? ` (→ ${element.assignedEnv})` : ''}`
      : `Path does not exist: ${element.absPath}`;

    return item;
  }

  getChildren(element) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return [];

    const config = readConfig();
    const envFolderPath = envFolderAbs(workspaceRoot, config);
    const targetFile = config.get('targetFile', '.env');
    const targetDirs = core.getTargetDirectories(config.get('targetDirectories'));

    if (!element) {
      return targetDirs.map((rel) => {
        const absPath = core.resolveTargetFolderAbs(workspaceRoot, rel);
        const exists = fs.existsSync(absPath);
        const assignedEnv = exists ? core.getAssignedEnv(absPath, envFolderPath, targetFile) : null;
        const name = rel === '.'
          ? `Workspace root (${path.basename(workspaceRoot)})`
          : rel;
        return {
          name,
          absPath,
          relPath: rel === '.' ? '.' : rel,
          isRoot: rel === '.',
          assignedEnv,
          exists,
        };
      });
    }

    return [];
  }
}

// ─── Status bar ────────────────────────────────────────────────────

function refreshStatusBar() {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    statusBarItem.hide();
    return;
  }

  const config = readConfig();
  const envFolderPath = envFolderAbs(workspaceRoot, config);

  if (!fs.existsSync(envFolderPath)) {
    statusBarItem.hide();
    return;
  }

  const targetFile = config.get('targetFile', '.env');
  const targetDirs = core.getTargetDirectories(config.get('targetDirectories'));
  const parts = [];

  for (const rel of targetDirs) {
    const folderAbs = core.resolveTargetFolderAbs(workspaceRoot, rel);
    if (!fs.existsSync(folderAbs)) continue;
    const active = core.getAssignedEnv(folderAbs, envFolderPath, targetFile);
    const label = rel === '.' ? 'root' : rel;
    parts.push(active ? `${label}: ${active}` : `${label}: —`);
  }

  if (parts.length === 0) {
    statusBarItem.text = '$(gear) env: —';
  } else {
    statusBarItem.text = `$(gear) ${parts.join(' · ')}`;
  }
  statusBarItem.show();
}

async function pickTargetDirectory(workspaceRoot, config) {
  const targetDirs = core.getTargetDirectories(config.get('targetDirectories'));
  const choices = targetDirs.map((rel) => {
    const abs = core.resolveTargetFolderAbs(workspaceRoot, rel);
    return {
      label: rel === '.' ? 'Workspace root (.)' : rel,
      description: fs.existsSync(abs) ? undefined : 'Path does not exist',
      rel,
      absPath: abs,
    };
  });

  if (choices.length === 0) {
    vscode.window.showErrorMessage('Env Switcher: No target directories configured.');
    return null;
  }

  if (choices.length === 1) {
    const c = choices[0];
    if (!fs.existsSync(c.absPath)) {
      vscode.window.showErrorMessage(`Env Switcher: Target directory does not exist: ${c.rel}`);
      return null;
    }
    return { rel: c.rel, absPath: c.absPath, label: c.rel === '.' ? 'workspace root' : c.rel };
  }

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select target directory for .env symlink',
  });

  if (!picked) return null;
  if (!fs.existsSync(picked.absPath)) {
    vscode.window.showErrorMessage(`Env Switcher: Target directory does not exist: ${picked.rel}`);
    return null;
  }
  return {
    rel: picked.rel,
    absPath: picked.absPath,
    label: picked.rel === '.' ? 'workspace root' : picked.rel,
  };
}

function activate(context) {
  globalStoragePath = context.globalStorageUri.fsPath;

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'envSwitcher.switchEnv';
  statusBarItem.tooltip = 'Click to switch .env symlink for a target directory';
  context.subscriptions.push(statusBarItem);

  envFilesProvider = new EnvFilesTreeDataProvider();
  projectFoldersProvider = new ProjectFoldersTreeDataProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('envSwitcher.envFiles', envFilesProvider),
    vscode.window.registerTreeDataProvider('envSwitcher.projectFolders', projectFoldersProvider),
  );

  const configInit = readConfig();
  const workspaceRootInit = getWorkspaceRoot();
  if (workspaceRootInit) {
    const envFolderPathInit = envFolderAbs(workspaceRootInit, configInit);

    if (!fs.existsSync(envFolderPathInit)) {
      const manifest = core.getBackupManifest(globalStoragePath, workspaceRootInit);
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
                const result = await core.restoreFromBackup(
                  workspaceRootInit,
                  configInit.get('envFolder', '.envs'),
                  configInit.get('targetFile', '.env'),
                  globalStoragePath,
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
      runBackupIfEnabled(workspaceRootInit, configInit);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.refreshEnvList', () => {
      envFilesProvider.refresh();
      projectFoldersProvider.refresh();
      refreshStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.openEnvFile', async (absPathOrNode) => {
      const filePath = typeof absPathOrNode === 'string' ? absPathOrNode : absPathOrNode?.absPath;
      if (!filePath) return;
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.revealEnvInExplorer', async (node) => {
      const filePath = typeof node === 'string' ? node : node?.absPath;
      if (!filePath) return;
      const uri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand('revealInExplorer', uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.openEnvFolderExternally', async () => {
      const wr = getWorkspaceRoot();
      if (!wr) {
        vscode.window.showErrorMessage('Env Switcher: No workspace folder open.');
        return;
      }
      const cfg = readConfig();
      const efp = envFolderAbs(wr, cfg);
      if (!fs.existsSync(efp)) {
        vscode.window.showWarningMessage('Env Switcher: No .envs folder found.');
        return;
      }
      const uri = vscode.Uri.file(efp);
      const ok = await vscode.env.openExternal(uri);
      if (!ok) {
        vscode.window.showInformationMessage('Env Switcher: Could not open folder (unsupported on this platform).');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.duplicateEnvFile', async (node) => {
      if (!node || node.type !== 'file' || !node.relPath) return;
      const wr = getWorkspaceRoot();
      if (!wr) return;
      const cfg = readConfig();
      const envFolderPath = envFolderAbs(wr, cfg);
      const suggested = `${path.basename(node.relPath, path.extname(node.relPath))}.copy${path.extname(node.relPath) || ''}`;
      const destName = await vscode.window.showInputBox({
        title: 'Duplicate env file',
        prompt: 'New file path relative to .envs (e.g. staging/.env.local)',
        value: suggested,
        validateInput: (v) => (v && v.trim() ? null : 'Enter a relative path'),
      });
      if (!destName) return;
      const normalized = destName.replace(/\\/g, '/').replace(/^\/+/, '');
      try {
        core.duplicateEnvFileInFolder(envFolderPath, node.relPath, normalized);
        envFilesProvider.refresh();
        runBackupIfEnabled(wr, cfg);
        vscode.window.showInformationMessage(`Env Switcher: Created ${normalized}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Env Switcher: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.assignEnv', async (node) => {
      if (!node || !node.exists) return;
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return;

      const config = readConfig();
      const envFolderPath = envFolderAbs(workspaceRoot, config);
      const targetFile = config.get('targetFile', '.env');
      const currentlyAssigned = core.getAssignedEnv(node.absPath, envFolderPath, targetFile);
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
        core.createEnvSymlink(node.absPath, envFolderPath, selected.envRelPath, targetFile);
        projectFoldersProvider.refresh();
        refreshStatusBar();
        runBackupIfEnabled(workspaceRoot, config);
        vscode.window.showInformationMessage(
          `Env Switcher: Assigned ${selected.envRelPath} → ${dirLabel}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Env Switcher: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.unassignEnv', async (node) => {
      if (!node || !node.exists) return;

      const config = readConfig();
      const targetFile = config.get('targetFile', '.env');
      const dirLabel = node.isRoot ? 'workspace root' : node.relPath;

      const confirm = await vscode.window.showWarningMessage(
        `Remove .env symlink from ${dirLabel}?`,
        { modal: true },
        'Remove'
      );

      if (confirm !== 'Remove') return;

      if (core.removeEnvSymlink(node.absPath, targetFile)) {
        projectFoldersProvider.refresh();
        refreshStatusBar();
        const wr = getWorkspaceRoot();
        if (wr) runBackupIfEnabled(wr, config);
        vscode.window.showInformationMessage(`Env Switcher: Removed .env from ${dirLabel}`);
      } else {
        vscode.window.showWarningMessage(`No .env symlink found in ${dirLabel}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.switchEnv', async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('Env Switcher: No workspace folder open.');
        return;
      }

      const config = readConfig();
      const envFolderPath = envFolderAbs(workspaceRoot, config);
      const targetFile = config.get('targetFile', '.env');

      if (!fs.existsSync(envFolderPath)) {
        vscode.window.showErrorMessage(
          `Env Switcher: "${config.get('envFolder', '.envs')}" folder not found. Create it and add your .env files there.`
        );
        return;
      }

      const pickedDir = await pickTargetDirectory(workspaceRoot, config);
      if (!pickedDir) return;

      const currentActive = core.getAssignedEnv(pickedDir.absPath, envFolderPath, targetFile);
      const items = buildEnvQuickPickItems(envFolderPath, currentActive);

      if (items.length === 0) {
        vscode.window.showErrorMessage('Env Switcher: No files found in .envs folder.');
        return;
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select environment for ${pickedDir.label}`,
      });

      if (!selected || !selected.envRelPath) return;

      try {
        core.createEnvSymlink(pickedDir.absPath, envFolderPath, selected.envRelPath, targetFile);
        projectFoldersProvider.refresh();
        refreshStatusBar();
        runBackupIfEnabled(workspaceRoot, config);
        vscode.window.showInformationMessage(
          `Env Switcher: Switched ${pickedDir.label} → ${selected.envRelPath}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Env Switcher: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.backupNow', () => {
      const wr = getWorkspaceRoot();
      if (!wr) return;
      const cfg = readConfig();
      const efp = envFolderAbs(wr, cfg);
      if (!fs.existsSync(efp)) {
        vscode.window.showWarningMessage('Env Switcher: No .envs folder to back up.');
        return;
      }
      core.backupEnvs(wr, efp, {
        globalStoragePath,
        envFolderName: cfg.get('envFolder', '.envs'),
        targetFile: cfg.get('targetFile', '.env'),
        targetDirectories: cfg.get('targetDirectories'),
      });
      vscode.window.showInformationMessage('Env Switcher: Backup saved to local storage.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.restoreBackup', async () => {
      const wr = getWorkspaceRoot();
      if (!wr) return;
      const cfg = readConfig();
      const manifest = core.getBackupManifest(globalStoragePath, wr);

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
        const result = await core.restoreFromBackup(
          wr,
          cfg.get('envFolder', '.envs'),
          cfg.get('targetFile', '.env'),
          globalStoragePath,
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
    })
  );

  refreshStatusBar();

  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '{.envs/**,**/.env}')
    );

    const scheduler = core.createAdaptiveDebouncedScheduler(
      () => Math.max(0, Number(readConfig().get('backupDebounceMs', 500)) || 0),
      () => {
        envFilesProvider.refresh();
        projectFoldersProvider.refresh();
        refreshStatusBar();
        runBackupIfEnabled(workspaceRoot, readConfig());
      }
    );

    watcher.onDidChange(() => scheduler.schedule());
    watcher.onDidCreate(() => scheduler.schedule());
    watcher.onDidDelete(() => scheduler.schedule());
    context.subscriptions.push(watcher);
    context.subscriptions.push({ dispose: () => scheduler.dispose() });
  }
}

function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

module.exports = { activate, deactivate };
