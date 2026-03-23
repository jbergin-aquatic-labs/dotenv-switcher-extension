const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('./lib/core');
const vault = require('./lib/vault');

let statusBarItem;
let envFilesProvider;
let projectFoldersProvider;
let guideActionsProvider;
let globalStoragePath;

function refreshAllTreeViews() {
  envFilesProvider?.refresh();
  projectFoldersProvider?.refresh();
  guideActionsProvider?.refresh();
}

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

function vaultRootForConfig(config) {
  return vault.getVaultRoot({
    globalStoragePath,
    location: config.get('vaultLocation', 'globalStorage'),
    homeDir: os.homedir(),
  });
}

function runVaultSnapshotIfEnabled(workspaceRoot, config) {
  if (!config.get('vaultEnabled', true)) return;
  if (!config.get('vaultAutoSnapshot', true)) return;
  snapshotVault(workspaceRoot, config, { respectSkipUnchanged: true });
}

/**
 * @param {{ respectSkipUnchanged?: boolean }} opts
 */
function snapshotVault(workspaceRoot, config, opts = {}) {
  if (!config.get('vaultEnabled', true)) return null;
  const efp = envFolderAbs(workspaceRoot, config);
  if (!fs.existsSync(efp)) return null;
  const skipIfUnchanged = opts.respectSkipUnchanged !== false && config.get('vaultSkipUnchanged', true);
  try {
    return vault.createSnapshot(workspaceRoot, efp, {
      vaultRoot: vaultRootForConfig(config),
      envFolderName: config.get('envFolder', '.envs'),
      targetFile: config.get('targetFile', '.env'),
      targetDirectories: config.get('targetDirectories'),
      maxVersions: config.get('vaultMaxVersions', 100),
      skipIfUnchanged,
    });
  } catch (err) {
    console.error('Env Switcher vault snapshot failed', err);
    return null;
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

async function assignEnvViaWizard() {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Env Switcher: No workspace folder open.');
    return;
  }
  const config = readConfig();
  const pickedDir = await pickTargetDirectory(workspaceRoot, config);
  if (!pickedDir) return;
  const node = {
    absPath: pickedDir.absPath,
    relPath: pickedDir.rel === '.' ? '.' : pickedDir.rel,
    isRoot: pickedDir.rel === '.',
    exists: true,
  };
  await vscode.commands.executeCommand('envSwitcher.assignEnv', node);
}

async function unassignEnvViaWizard() {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Env Switcher: No workspace folder open.');
    return;
  }
  const config = readConfig();
  const pickedDir = await pickTargetDirectory(workspaceRoot, config);
  if (!pickedDir) return;
  const envFolderPath = envFolderAbs(workspaceRoot, config);
  const targetFile = config.get('targetFile', '.env');
  const assigned = core.getAssignedEnv(pickedDir.absPath, envFolderPath, targetFile);
  if (!assigned) {
    vscode.window.showInformationMessage(
      `Env Switcher: No ${targetFile} symlink in that folder — nothing to remove.`
    );
    return;
  }
  const node = {
    absPath: pickedDir.absPath,
    relPath: pickedDir.rel === '.' ? '.' : pickedDir.rel,
    isRoot: pickedDir.rel === '.',
    exists: true,
  };
  await vscode.commands.executeCommand('envSwitcher.unassignEnv', node);
}

async function openEnvSwitcherSettings() {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'envSwitcher');
}

/**
 * @param {string|null} presetSnapshotId
 */
async function restoreFromVaultFlow(wr, cfg, presetSnapshotId) {
  if (!cfg.get('vaultEnabled', true)) {
    vscode.window.showWarningMessage('Env Switcher vault is disabled in settings.');
    return;
  }
  const vr = vaultRootForConfig(cfg);
  const snaps = vault.listSnapshots(vr, wr);
  if (snaps.length === 0) {
    vscode.window.showWarningMessage('Env Switcher: No vault snapshots for this workspace.');
    return;
  }

  let pick;
  if (presetSnapshotId) {
    if (!snaps.some((s) => s.snapshotId === presetSnapshotId)) {
      vscode.window.showWarningMessage(`Env Switcher: Snapshot not found: ${presetSnapshotId}`);
      return;
    }
    pick = { snapshotId: presetSnapshotId };
  } else {
    pick = await vscode.window.showQuickPick(
      snaps.map((s) => ({
        label: s.snapshotId,
        description: s.createdAt ? new Date(s.createdAt).toLocaleString() : '',
        detail: `${s.fileCount} file(s)`,
        snapshotId: s.snapshotId,
      })),
      { placeHolder: 'Choose a vault snapshot (newest first)' }
    );
  }
  if (!pick) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: 'Restore entire .envs folder', value: 'full' },
      { label: 'Restore a single file…', value: 'one' },
    ],
    { placeHolder: 'What should be restored from the vault?' }
  );
  if (!action) return;

  const envFolderPath = envFolderAbs(wr, cfg);
  const targetFile = cfg.get('targetFile', '.env');

  if (action.value === 'full') {
    const ok = await vscode.window.showWarningMessage(
      'Replace the whole .envs folder with this vault snapshot? Symlinks for target directories will be reapplied when the snapshot recorded them.',
      { modal: true },
      'Replace .envs'
    );
    if (ok !== 'Replace .envs') return;
    try {
      const { restoredCount, manifest } = vault.restoreFullToEnvFolder(wr, envFolderPath, vr, pick.snapshotId);
      if (manifest?.assignments) {
        for (const [relPath, envFileRelPath] of Object.entries(manifest.assignments)) {
          const folderAbsPath = relPath === '.' ? wr : path.join(wr, relPath);
          if (!fs.existsSync(folderAbsPath)) continue;
          try {
            core.createEnvSymlink(folderAbsPath, envFolderPath, envFileRelPath, targetFile);
          } catch {
            // skip
          }
        }
      }
      refreshAllTreeViews();
      refreshStatusBar();
      runBackupIfEnabled(wr, cfg);
      runVaultSnapshotIfEnabled(wr, cfg);
      vscode.window.showInformationMessage(`Env Switcher: Restored ${restoredCount} file(s) from vault.`);
    } catch (err) {
      vscode.window.showErrorMessage(`Env Switcher: ${err.message}`);
    }
    return;
  }

  const man = vault.getSnapshotManifest(vr, wr, pick.snapshotId);
  if (!man?.files?.length) {
    vscode.window.showWarningMessage('Env Switcher: Snapshot has no file list.');
    return;
  }
  const filePick = await vscode.window.showQuickPick(
    man.files.map((f) => ({ label: f, fileRel: f })),
    { placeHolder: 'Pick a file to copy into .envs (overwrites if it exists)' }
  );
  if (!filePick) return;
  try {
    vault.restoreFileToEnvFolder(wr, envFolderPath, vr, pick.snapshotId, filePick.fileRel);
    refreshAllTreeViews();
    runBackupIfEnabled(wr, cfg);
    runVaultSnapshotIfEnabled(wr, cfg);
    vscode.window.showInformationMessage(`Env Switcher: Restored ${filePick.fileRel} from vault.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Env Switcher: ${err.message}`);
  }
}

// ─── Guide & actions tree ──────────────────────────────────────────

const GUIDE_SNAPSHOT_ROWS = 20;

function guideAction(domId, label, description, commandSuffix, iconId) {
  return {
    kind: 'action',
    domId,
    label,
    description,
    tooltip: description,
    command: `envSwitcher.${commandSuffix}`,
    title: label,
    icon: iconId,
  };
}

class GuideActionsTreeDataProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    if (element.kind === 'section') {
      let state = vscode.TreeItemCollapsibleState.Expanded;
      if (element.id === 'vault:snaps') {
        state = element.snapCount > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;
      }
      const item = new vscode.TreeItem(element.label, state);
      item.id = element.domId;
      item.iconPath = new vscode.ThemeIcon(element.icon || 'folder');
      item.description = element.description;
      item.tooltip = element.tooltip;
      item.contextValue = 'guideSection';
      return item;
    }

    if (element.kind === 'action') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = element.domId;
      item.iconPath = new vscode.ThemeIcon(element.icon || 'symbol-event');
      item.description = element.description;
      item.tooltip = element.tooltip || element.description;
      item.command = {
        command: element.command,
        title: element.title || element.label,
        arguments: element.args,
      };
      return item;
    }

    if (element.kind === 'snapshot') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = element.domId;
      item.iconPath = new vscode.ThemeIcon('history');
      item.description = element.description;
      item.tooltip = element.tooltip;
      item.command = {
        command: 'envSwitcher.vaultSnapshotMenu',
        title: 'Vault snapshot actions',
        arguments: [element.snapshotId],
      };
      return item;
    }

    if (element.kind === 'hint') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = element.domId;
      item.iconPath = new vscode.ThemeIcon('info');
      item.description = element.description;
      return item;
    }

    return new vscode.TreeItem(String(element));
  }

  getChildren(element) {
    const wr = getWorkspaceRoot();
    if (!element) {
      if (!wr) return [];
      return [
        {
          kind: 'section',
          id: 'symlinks',
          domId: 'envSwitcher.guide.symlinks',
          label: 'Symlinks',
          description: 'Point .env at a profile in .envs',
          tooltip: 'Each target directory (see settings: targetDirectories) can symlink its .env to one file under .envs.',
          icon: 'link',
        },
        {
          kind: 'section',
          id: 'vault',
          domId: 'envSwitcher.guide.vault',
          label: 'Vault',
          description: 'Version history off-repo',
          tooltip: 'Snapshots keep copies of .envs outside the project. Plaintext on disk — disable in settings if unwanted.',
          icon: 'archive',
        },
        {
          kind: 'section',
          id: 'backup',
          domId: 'envSwitcher.guide.backup',
          label: 'Editor backup',
          description: 'Latest mirror in VS Code storage',
          tooltip: 'One rolling backup for quick restore after re-clone. Different from the vault’s version list.',
          icon: 'save-all',
        },
        {
          kind: 'section',
          id: 'help',
          domId: 'envSwitcher.guide.help',
          label: 'Help',
          description: 'Settings & refresh',
          icon: 'question',
        },
      ];
    }

    if (element.kind !== 'section') return [];

    if (element.id === 'symlinks') {
      return [
        guideAction(
          'envSwitcher.guide.a1',
          'Switch active profile…',
          'Pick target folder, then a file in .envs',
          'switchEnv',
          'arrow-swap'
        ),
        guideAction(
          'envSwitcher.guide.a2',
          'Link a profile to a folder…',
          'Same as right-click Assign on Target directories',
          'assignEnvWizard',
          'add'
        ),
        guideAction(
          'envSwitcher.guide.a3',
          'Remove .env symlink…',
          'Pick folder; confirms before removing link',
          'unassignEnvWizard',
          'close'
        ),
      ];
    }

    if (element.id === 'vault') {
      const cfg = readConfig();
      const rows = [
        guideAction(
          'envSwitcher.guide.v1',
          'Save vault snapshot now',
          'Record current .envs (manual checkpoint)',
          'vaultSnapshotNow',
          'save-as'
        ),
        guideAction(
          'envSwitcher.guide.v2',
          'Restore from vault…',
          'Browse snapshots, restore all or one file',
          'restoreFromVault',
          'repo-pull'
        ),
        guideAction(
          'envSwitcher.guide.v3',
          'Open vault folder on disk',
          'Workspace-scoped vault directory',
          'openVaultFolder',
          'folder-opened'
        ),
      ];
      if (cfg.get('vaultEnabled', true)) {
        const vr = vaultRootForConfig(cfg);
        const snaps = vault.listSnapshots(vr, wr);
        rows.push({
          kind: 'section',
          id: 'vault:snaps',
          domId: 'envSwitcher.guide.vaultSnaps',
          label: 'Recent snapshots',
          snapCount: snaps.length,
          description: snaps.length ? `${snaps.length}` : '0',
          tooltip: 'Expand, then click a snapshot for open folder or restore',
          icon: 'timeline',
        });
      }
      return rows;
    }

    if (element.id === 'vault:snaps') {
      const cfg = readConfig();
      if (!cfg.get('vaultEnabled', true)) return [];
      const vr = vaultRootForConfig(cfg);
      const snaps = vault.listSnapshots(vr, wr).slice(0, GUIDE_SNAPSHOT_ROWS);
      if (snaps.length === 0) {
        return [
          {
            kind: 'hint',
            domId: 'envSwitcher.guide.vaultEmpty',
            label: 'No snapshots yet',
            description: 'Save one above, or edit .envs with vault auto-snapshot on',
          },
        ];
      }
      return snaps.map((s) => ({
        kind: 'snapshot',
        domId: `envSwitcher.guide.snap.${s.snapshotId}`,
        snapshotId: s.snapshotId,
        label: s.createdAt ? new Date(s.createdAt).toLocaleString() : s.snapshotId,
        description: `${s.fileCount} files`,
        tooltip: `Id: ${s.snapshotId}\nClick → open folder or restore`,
      }));
    }

    if (element.id === 'backup') {
      return [
        guideAction(
          'envSwitcher.guide.b1',
          'Save editor backup now',
          'Mirror .envs into VS Code local storage',
          'backupNow',
          'cloud-upload'
        ),
        guideAction(
          'envSwitcher.guide.b2',
          'Restore from editor backup…',
          'Rolling backup (not versioned like vault)',
          'restoreBackup',
          'cloud-download'
        ),
      ];
    }

    if (element.id === 'help') {
      return [
        guideAction(
          'envSwitcher.guide.h1',
          'Open Env Switcher settings',
          'Vault, paths, debounce, auto-backup…',
          'openEnvSwitcherSettings',
          'gear'
        ),
        guideAction(
          'envSwitcher.guide.h2',
          'Refresh all Env Switcher views',
          'Reload trees and status bar',
          'refreshEnvList',
          'refresh'
        ),
      ];
    }

    return [];
  }
}

function activate(context) {
  globalStoragePath = context.globalStorageUri.fsPath;

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'envSwitcher.switchEnv';
  const statusTip = new vscode.MarkdownString(
    '**Env Switcher** — active `.envs` profile per target directory.\n\n'
      + 'Click to pick a folder (if you have several), then the env file to symlink as `.env`.\n\n'
      + 'Use the **Guide & actions** view in this sidebar for step-by-step flows, vault history, and backups.'
  );
  statusTip.isTrusted = true;
  statusBarItem.tooltip = statusTip;
  context.subscriptions.push(statusBarItem);

  envFilesProvider = new EnvFilesTreeDataProvider();
  projectFoldersProvider = new ProjectFoldersTreeDataProvider();
  guideActionsProvider = new GuideActionsTreeDataProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('envSwitcher.guide', guideActionsProvider),
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
                refreshAllTreeViews();
                refreshStatusBar();
                runVaultSnapshotIfEnabled(workspaceRootInit, configInit);
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
    } else {
      if (configInit.get('autoBackup', true)) {
        runBackupIfEnabled(workspaceRootInit, configInit);
      }
      runVaultSnapshotIfEnabled(workspaceRootInit, configInit);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.refreshEnvList', () => {
      refreshAllTreeViews();
      refreshStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.assignEnvWizard', assignEnvViaWizard)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.unassignEnvWizard', unassignEnvViaWizard)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.openEnvSwitcherSettings', openEnvSwitcherSettings)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.vaultSnapshotMenu', async (snapshotId) => {
      const wr = getWorkspaceRoot();
      if (!wr || !snapshotId) return;
      const cfg = readConfig();
      if (!cfg.get('vaultEnabled', true)) {
        vscode.window.showWarningMessage('Env Switcher vault is disabled in settings.');
        return;
      }
      const snapPath = vault.snapshotAbsPath(vaultRootForConfig(cfg), wr, snapshotId);
      if (!fs.existsSync(snapPath)) {
        vscode.window.showErrorMessage('Env Switcher: Snapshot folder not found.');
        return;
      }
      const step = await vscode.window.showQuickPick(
        [
          {
            label: '$(folder-opened) Open snapshot folder on disk',
            value: 'open',
            description: snapPath,
          },
          {
            label: '$(history) Restore from this snapshot…',
            value: 'restore',
            description: 'Full .envs or one file',
          },
        ],
        { placeHolder: `Vault snapshot: ${snapshotId}` }
      );
      if (!step) return;
      if (step.value === 'open') {
        const ok = await vscode.env.openExternal(vscode.Uri.file(snapPath));
        if (!ok) {
          vscode.window.showInformationMessage(`Snapshot path: ${snapPath}`);
        }
        return;
      }
      await restoreFromVaultFlow(wr, cfg, snapshotId);
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
        refreshAllTreeViews();
        runBackupIfEnabled(wr, cfg);
        runVaultSnapshotIfEnabled(wr, cfg);
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
        refreshAllTreeViews();
        refreshStatusBar();
        runBackupIfEnabled(workspaceRoot, config);
        runVaultSnapshotIfEnabled(workspaceRoot, config);
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
        refreshAllTreeViews();
        refreshStatusBar();
        const wr = getWorkspaceRoot();
        if (wr) {
          runBackupIfEnabled(wr, config);
          runVaultSnapshotIfEnabled(wr, config);
        }
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
        refreshAllTreeViews();
        refreshStatusBar();
        runBackupIfEnabled(workspaceRoot, config);
        runVaultSnapshotIfEnabled(workspaceRoot, config);
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
      runVaultSnapshotIfEnabled(wr, cfg);
      vscode.window.showInformationMessage('Env Switcher: Backup saved to local storage.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.vaultSnapshotNow', () => {
      const wr = getWorkspaceRoot();
      if (!wr) return;
      const cfg = readConfig();
      if (!cfg.get('vaultEnabled', true)) {
        vscode.window.showWarningMessage('Env Switcher vault is disabled in settings.');
        return;
      }
      const efp = envFolderAbs(wr, cfg);
      if (!fs.existsSync(efp)) {
        vscode.window.showWarningMessage('Env Switcher: No .envs folder to snapshot.');
        return;
      }
      const result = snapshotVault(wr, cfg, { respectSkipUnchanged: false });
      if (!result) {
        vscode.window.showErrorMessage('Env Switcher: Vault snapshot failed.');
        return;
      }
      if (result.skipped && result.reason === 'no-files') {
        vscode.window.showWarningMessage('Env Switcher: No env files to snapshot.');
        return;
      }
      const msg = result.skipped && result.reason === 'unchanged'
        ? 'Vault already has this content (identical fingerprint).'
        : `Vault snapshot saved (${result.fileCount} files). ID: ${result.snapshotId}`;
      refreshAllTreeViews();
      vscode.window.showInformationMessage(`Env Switcher: ${msg}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.openVaultFolder', async () => {
      const wr = getWorkspaceRoot();
      if (!wr) {
        vscode.window.showErrorMessage('Env Switcher: No workspace folder open.');
        return;
      }
      const cfg = readConfig();
      const vr = vaultRootForConfig(cfg);
      vault.ensureSecureVaultRoot(vr);
      const dir = vault.workspaceVaultDir(vr, wr);
      core.mkdirp(dir);
      const ok = await vscode.env.openExternal(vscode.Uri.file(dir));
      if (!ok) {
        vscode.window.showInformationMessage(`Env Switcher vault path: ${dir}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.restoreFromVault', async () => {
      const wr = getWorkspaceRoot();
      if (!wr) return;
      await restoreFromVaultFlow(wr, readConfig(), null);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envSwitcher.restoreEnvFileFromVault', async (node) => {
      if (!node || node.type !== 'file' || !node.relPath) return;
      const wr = getWorkspaceRoot();
      if (!wr) return;
      const cfg = readConfig();
      if (!cfg.get('vaultEnabled', true)) {
        vscode.window.showWarningMessage('Env Switcher vault is disabled in settings.');
        return;
      }
      const vr = vaultRootForConfig(cfg);
      const snaps = vault.listSnapshots(vr, wr).filter((s) => {
        const m = vault.getSnapshotManifest(vr, wr, s.snapshotId);
        return m?.files?.includes(node.relPath);
      });
      if (snaps.length === 0) {
        vscode.window.showWarningMessage(`Env Switcher: No vault snapshot contains "${node.relPath}".`);
        return;
      }
      const pick = await vscode.window.showQuickPick(
        snaps.map((s) => ({
          label: s.snapshotId,
          description: s.createdAt ? new Date(s.createdAt).toLocaleString() : '',
          snapshotId: s.snapshotId,
        })),
        { placeHolder: `Restore "${node.relPath}" from which snapshot?` }
      );
      if (!pick) return;
      const envFolderPath = envFolderAbs(wr, cfg);
      try {
        vault.restoreFileToEnvFolder(wr, envFolderPath, vr, pick.snapshotId, node.relPath);
        refreshAllTreeViews();
        runBackupIfEnabled(wr, cfg);
        runVaultSnapshotIfEnabled(wr, cfg);
        vscode.window.showInformationMessage(`Env Switcher: Restored ${node.relPath} from vault.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Env Switcher: ${err.message}`);
      }
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
        refreshAllTreeViews();
        refreshStatusBar();
        runVaultSnapshotIfEnabled(wr, cfg);
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
        refreshAllTreeViews();
        refreshStatusBar();
        const cfg = readConfig();
        runBackupIfEnabled(workspaceRoot, cfg);
        runVaultSnapshotIfEnabled(workspaceRoot, cfg);
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
