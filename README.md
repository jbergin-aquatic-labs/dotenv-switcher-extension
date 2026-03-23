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

Configure `envSwitcher.targetDirectories` to `[".", "frontend", "backend"]` to enable switching each directory independently.

## Usage

- **Activity Bar**: Open the Env Switcher view and click an environment under each directory
- **Command Palette**: `Env Switcher: Select Environment` (selects target directory first if multiple)
- **Status Bar**: Click the `env: <name>` item in the bottom status bar

The currently active environment is shown with a checkmark in the sidebar and displayed in the status bar.

## Settings

| Setting                       | Default  | Description                                                                 |
| ----------------------------- | -------- | --------------------------------------------------------------------------- |
| `envSwitcher.envFolder`       | `.envs`  | Folder containing your env files (at workspace root)                        |
| `envSwitcher.targetFile`      | `.env`   | Target filename for the symlink in each directory                           |
| `envSwitcher.targetDirectories` | `["."]` | Directories where symlinks are created. Use `"."` for root. Example: `[".", "frontend", "backend"]` |

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
