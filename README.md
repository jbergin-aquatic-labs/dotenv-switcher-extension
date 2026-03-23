# Env Switcher

A Cursor extension that lets you quickly swap between `.env` configurations by symlinking from a folder of env files.

## How It Works

1. Create a `.envs/` folder in your project root
2. Add your environment files there (e.g., `.env.dev`, `.env.staging`, `.env.prod`)
3. Use the command palette, Activity Bar, or status bar to switch between them
4. The extension creates symlinks: `<targetDir>/.env` → `.envs/<selected file>`

## Project Structure

**Single directory (default):**
```
your-project/
├── .envs/
│   ├── .env.dev
│   ├── .env.staging
│   └── .env.prod
├── .env              ← symlink managed by the extension (workspace root)
└── ...
```

**Monorepo (frontend + backend):**
```
your-project/
├── .envs/
│   ├── .env.dev
│   ├── .env.staging
│   └── .env.prod
├── frontend/
│   └── .env          ← symlink to .envs/.env.dev
├── backend/
│   └── .env          ← symlink to .envs/.env.prod
└── ...
```

Configure `envSwitcher.targetDirectories` to `[".", "frontend", "backend"]` so each listed folder gets its own `.env` symlink. The sidebar **Target directories** view lists exactly those paths (missing paths are shown so you can fix typos).

## Usage

- **Activity Bar**: Open the Env Switcher view; use **Env Files** to browse `.envs`, and **Target directories** to assign a file per configured folder (right-click → Assign).
- **Command Palette**: `Env Switcher: Select Environment` (picks a target directory when several are configured, then the env file).
- **Status Bar**: Click the env summary (shows each target directory and its active file when multiple are configured).
- **Duplicate**: Right-click an env file → **Duplicate Env File**.
- **Reveal / OS folder**: Right-click an env file → **Reveal in Explorer**; use the view title **Open .envs Folder in System File Manager** to open `.envs` in your file manager.

The currently active environment is shown with a checkmark in the sidebar and displayed in the status bar.

## Settings

| Setting                         | Default   | Description                                                                 |
| ------------------------------- | --------- | --------------------------------------------------------------------------- |
| `envSwitcher.envFolder`         | `.envs`   | Folder containing your env files (at workspace root)                        |
| `envSwitcher.targetFile`        | `.env`    | Target filename for the symlink in each directory                           |
| `envSwitcher.targetDirectories` | `["."]`   | Directories (relative to workspace root) that receive a symlink. Example: `[".", "frontend", "backend"]` |
| `envSwitcher.backupDebounceMs`  | `500`     | Delay before refreshing views and auto-backup after `.env` / `.envs` changes (`0` = no debounce) |
| `envSwitcher.autoBackup`        | `true`    | Mirror `.envs` into VS Code local storage for restore after clone/delete    |

## Development

Run `npm test` to execute unit tests, smoke checks, and VS Code extension tests (integration plus end-to-end flows against a fixture workspace). Use `npm run test:integration` or `npm run test:e2e` to run a single VS Code suite.

## Installation (from .vsix)

```bash
# In Cursor, open the command palette and run:
# Extensions: Install from VSIX...
# Then select the env-switcher-0.1.0.vsix file
```

## Notes

- The symlink is **relative**, so it works across machines if the project structure is the same.
- If a `.env` file already exists (not a symlink), the extension will replace it when you select an environment. Back up first if needed.
- The extension only activates when a `.envs` folder exists in your workspace.
