const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  if (process.argv.includes('--integration-only')) {
    process.env.VSCODE_TEST_GREP = 'Integration';
  } else if (process.argv.includes('--e2e-only')) {
    process.env.VSCODE_TEST_GREP = 'E2E';
  } else {
    delete process.env.VSCODE_TEST_GREP;
  }

  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'vscode-suite');
  const launchArgs = [path.resolve(__dirname, 'fixtures', 'e2e-workspace')];

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
