const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vscode = require('vscode');
const core = require('../../src/lib/core');
const vault = require('../../src/lib/vault');

describe('E2E: symlink and duplicate flows', function () {
  this.timeout(60_000);

  function workspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length === 1, 'Expected exactly one workspace folder');
    return folders[0].uri.fsPath;
  }

  it('creates and removes a relative .env symlink at workspace root', () => {
    const root = workspaceRoot();
    const envFolder = path.join(root, '.envs');
    const targetFile = '.env';
    const linkPath = path.join(root, targetFile);

    try {
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    } catch {
      // ignore
    }

    core.createEnvSymlink(root, envFolder, 'dev.env', targetFile);
    const st = fs.lstatSync(linkPath);
    assert.ok(st.isSymbolicLink());
    const dest = fs.readlinkSync(linkPath);
    assert.ok(dest.includes('dev.env') || dest.includes('.envs'));

    assert.strictEqual(core.removeEnvSymlink(root, targetFile), true);
    assert.ok(!fs.existsSync(linkPath));
  });

  it('duplicates an env file and removes the copy', () => {
    const root = workspaceRoot();
    const envFolder = path.join(root, '.envs');
    const destRel = 'e2e-copy.env';
    const destAbs = path.join(envFolder, destRel);
    try {
      if (fs.existsSync(destAbs)) fs.unlinkSync(destAbs);
    } catch {
      // ignore
    }

    core.duplicateEnvFileInFolder(envFolder, 'dev.env', destRel);
    assert.ok(fs.existsSync(destAbs));
    assert.ok(fs.readFileSync(destAbs, 'utf8').includes('MODE=dev'));
    fs.unlinkSync(destAbs);
  });

  it('records assignments for configured target directories', () => {
    const root = workspaceRoot();
    const envFolder = path.join(root, '.envs');
    core.createEnvSymlink(root, envFolder, 'prod.env', '.env');
    try {
      const map = core.collectAssignments(root, envFolder, '.env', ['.']);
      assert.ok(map['.']);
      assert.ok(map['.'].includes('prod'));
    } finally {
      core.removeEnvSymlink(root, '.env');
    }
  });

  it('vault snapshots and restores a file with hierarchical path preserved', () => {
    const root = workspaceRoot();
    const envFolder = path.join(root, '.envs');
    const vaultRoot = path.join(os.tmpdir(), `env-switcher-e2e-vault-${Date.now()}`);
    try {
      const created = vault.createSnapshot(root, envFolder, {
        vaultRoot,
        envFolderName: '.envs',
        targetFile: '.env',
        targetDirectories: ['.'],
        maxVersions: 25,
        skipIfUnchanged: false,
      });
      assert.strictEqual(created.skipped, false);
      assert.ok(created.snapshotId);

      const snapFiles = path.join(vaultRoot, core.workspaceScopedDirName(root), 'snapshots', created.snapshotId, 'files');
      assert.ok(fs.existsSync(path.join(snapFiles, 'dev.env')));

      const original = fs.readFileSync(path.join(envFolder, 'dev.env'), 'utf8');
      fs.writeFileSync(path.join(envFolder, 'dev.env'), 'CORRUPTED=true');
      vault.restoreFileToEnvFolder(root, envFolder, vaultRoot, created.snapshotId, 'dev.env');
      assert.strictEqual(fs.readFileSync(path.join(envFolder, 'dev.env'), 'utf8'), original);
    } finally {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    }
  });
});
