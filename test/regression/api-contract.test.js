/**
 * Regression / compatibility checks: manifest consistency and stable library surface.
 * Run in CI (plain Node, no VS Code) to catch accidental removals before integration tests.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const pkgPath = path.join(repoRoot, 'package.json');

function loadPackage() {
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

describe('regression: package.json contract', () => {
  it('keeps extension entrypoint and publisher id stable', () => {
    const pkg = loadPackage();
    assert.strictEqual(pkg.main, './src/extension.js');
    assert.strictEqual(pkg.name, 'env-switcher');
    assert.strictEqual(pkg.publisher, 'aquatic-labs');
  });

  it('declares only envSwitcher-prefixed configuration keys', () => {
    const pkg = loadPackage();
    const props = pkg.contributes?.configuration?.properties || {};
    const keys = Object.keys(props);
    assert.ok(keys.length > 0);
    for (const k of keys) {
      assert.ok(
        k.startsWith('envSwitcher.'),
        `Configuration key must use envSwitcher prefix: ${k}`
      );
    }
  });

  it('declares sidebar views with stable envSwitcher.* ids', () => {
    const pkg = loadPackage();
    const views = pkg.contributes?.views?.['env-switcher'] || [];
    const ids = views.map((v) => v.id);
    for (const id of ids) {
      assert.ok(id.startsWith('envSwitcher.'), `View id should be envSwitcher.*: ${id}`);
    }
    assert.ok(ids.includes('envSwitcher.guide'));
    assert.ok(ids.includes('envSwitcher.envFiles'));
    assert.ok(ids.includes('envSwitcher.projectFolders'));
  });

  it('declares only envSwitcher-prefixed commands', () => {
    const pkg = loadPackage();
    const cmds = pkg.contributes?.commands || [];
    assert.ok(cmds.length > 0);
    for (const c of cmds) {
      assert.ok(
        c.command && c.command.startsWith('envSwitcher.'),
        `Command id must use envSwitcher prefix: ${c.command}`
      );
    }
  });

  it('lists command ids uniquely', () => {
    const pkg = loadPackage();
    const cmds = (pkg.contributes?.commands || []).map((c) => c.command);
    const uniq = new Set(cmds);
    assert.strictEqual(uniq.size, cmds.length, 'Duplicate command ids in package.json');
  });
});

describe('regression: core library exports (backward compatible surface)', () => {
  const core = require('../../src/lib/core');

  const requiredFunctions = [
    'getEnvFolderPath',
    'getExcludedFolders',
    'getTargetDirectories',
    'listEnvDirContents',
    'listAllEnvFiles',
    'getAssignedEnv',
    'createEnvSymlink',
    'removeEnvSymlink',
    'workspaceScopedDirName',
    'workspaceBackupDir',
    'mkdirp',
    'copyDirRecursive',
    'rmrfSync',
    'collectAssignments',
    'backupEnvs',
    'getBackupManifest',
    'restoreFromBackup',
    'buildEnvQuickPickDescriptors',
    'duplicateEnvFileInFolder',
    'resolveTargetFolderAbs',
    'createAdaptiveDebouncedScheduler',
  ];

  it('exports all required functions', () => {
    for (const name of requiredFunctions) {
      assert.strictEqual(typeof core[name], 'function', `core.${name} should remain a function`);
    }
  });

  it('exports DEFAULT_EXCLUDED set', () => {
    assert.ok(core.DEFAULT_EXCLUDED instanceof Set);
  });
});

describe('regression: vault library exports', () => {
  const vault = require('../../src/lib/vault');

  const requiredFunctions = [
    'getVaultRoot',
    'ensureSecureVaultRoot',
    'workspaceVaultDir',
    'snapshotsDir',
    'snapshotAbsPath',
    'createSnapshot',
    'listSnapshots',
    'getSnapshotManifest',
    'restoreFileToEnvFolder',
    'restoreFullToEnvFolder',
    'listSnapshotIdsDesc',
  ];

  it('exports all required functions', () => {
    for (const name of requiredFunctions) {
      assert.strictEqual(typeof vault[name], 'function', `vault.${name} should remain a function`);
    }
  });
});
