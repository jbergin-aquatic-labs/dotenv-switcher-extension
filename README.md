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
- **Local env vault**: Versioned snapshots of the whole `.envs` tree (paths under `.envs` preserved) stored outside the repo. Use **Save Vault Snapshot Now**, **Restore from Vault…**, or right-click a file → **Restore This File from Vault…**. Open your workspace’s vault folder from the Env Files view title.

The currently active environment is shown with a checkmark in the sidebar and displayed in the status bar.

## Settings

| Setting                         | Default   | Description                                                                 |
| ------------------------------- | --------- | --------------------------------------------------------------------------- |
| `envSwitcher.envFolder`         | `.envs`   | Folder containing your env files (at workspace root)                        |
| `envSwitcher.targetFile`        | `.env`    | Target filename for the symlink in each directory                           |
| `envSwitcher.targetDirectories` | `["."]`   | Directories (relative to workspace root) that receive a symlink. Example: `[".", "frontend", "backend"]` |
| `envSwitcher.backupDebounceMs`  | `500`     | Delay before refreshing views and auto-backup after `.env` / `.envs` changes (`0` = no debounce) |
| `envSwitcher.autoBackup`        | `true`    | Mirror `.envs` into VS Code local storage for restore after clone/delete    |
| `envSwitcher.vaultEnabled`      | `true`    | Enable the local vault (plaintext snapshots; see below)                     |
| `envSwitcher.vaultAutoSnapshot` | `true`  | Append vault snapshots when `.envs` changes (debounced) and after symlink actions |
| `envSwitcher.vaultLocation`     | `globalStorage` | `globalStorage` (with the extension) or `userHome` (`~/.env-switcher-vault`, chmod `700` on Unix) |
| `envSwitcher.vaultMaxVersions`  | `100`     | Keep at most this many snapshots per workspace (oldest removed automatically) |
| `envSwitcher.vaultSkipUnchanged`| `true`    | For auto-snapshots, skip when content matches the latest snapshot (SHA-256 fingerprint) |

### Local vault and security

The vault stores **plain copies** of env files on disk for recovery and history. It is meant for accidental deletion, not for strong secrecy on a shared machine. Turn off `envSwitcher.vaultEnabled` if you do not want that. Prefer full-disk encryption and a locked user account on laptops. The existing **auto backup** (VS Code global storage) and the vault are separate: backups are a single latest mirror; the vault keeps **ordered snapshots** with manifests (file hashes, symlink assignments).

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
