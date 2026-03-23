const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

describe('Integration: extension host', function () {
  this.timeout(60_000);

  it('exposes the extension and activates', async () => {
    const ext = vscode.extensions.getExtension('aquatic-labs.env-switcher');
    assert.ok(ext, 'Extension aquatic-labs.env-switcher should be present');
    await ext.activate();
  });

  it('registers env switcher commands', async () => {
    const cmds = await vscode.commands.getCommands(true);
    const required = [
      'envSwitcher.switchEnv',
      'envSwitcher.refreshEnvList',
      'envSwitcher.assignEnv',
      'envSwitcher.unassignEnv',
      'envSwitcher.openEnvFile',
      'envSwitcher.revealEnvInExplorer',
      'envSwitcher.duplicateEnvFile',
      'envSwitcher.openEnvFolderExternally',
      'envSwitcher.backupNow',
      'envSwitcher.restoreBackup',
    ];
    for (const c of required) {
      assert.ok(cmds.includes(c), `Missing command: ${c}`);
    }
  });

  it('loads workspace fixture with a .envs directory', () => {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length >= 1);
    const root = folders[0].uri.fsPath;
    assert.ok(fs.existsSync(path.join(root, '.envs')));
  });
});
