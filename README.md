# Run My Tasks

A VS Code extension that gives you fast access to all workspace tasks via a status bar button, a keyboard shortcut, and a dedicated side panel.

## Features

**Status bar button** — a `▶ Tasks` button appears in the status bar. Click it to open a searchable picker with all tasks defined in the workspace (including tasks from extensions like npm, gulp, etc.).

**Keyboard shortcut** — press `Ctrl+Shift+T` (or `Cmd+Shift+T` on macOS) to open the same picker from anywhere.

**Side panel** — a "Run My Tasks" view in the Activity Bar lists all tasks grouped by source. Tasks are sorted alphabetically within each group, with currently running tasks shown at the top with a green spinning indicator. Each task has inline buttons to run or stop it directly from the tree.

The picker groups tasks by source (Workspace tasks first, then extension-contributed tasks in alphabetical order) and optionally shows the underlying shell command or npm script as a detail line.

## Requirements

- VS Code 1.90.0 or later
- At least one task defined in `.vscode/tasks.json` or contributed by an installed extension

## Configuration

All settings are under the `runMyTasks` namespace and can be changed in **Settings** (`Ctrl+,`) by searching for "Run My Tasks".

| Setting | Type | Default | Description |
|---|---|---|---|
| `runMyTasks.statusBarAlignment` | `"left"` \| `"right"` | `"left"` | Side of the status bar where the Tasks button appears. |
| `runMyTasks.statusBarPriority` | `number` | `100` | Position priority within the chosen side. Higher numbers place the button further left on the Left side (VS Code default behavior). |
| `runMyTasks.showTaskType` | `boolean` | `true` | Show the shell command or npm script as a detail line below each task name in the picker. Disable if you prefer a cleaner list. |

### Example `settings.json`

```json
{
  "runMyTasks.statusBarAlignment": "right",
  "runMyTasks.statusBarPriority": 200,
  "runMyTasks.showTaskType": false
}
```

## Commands

| Command | Default keybinding | Description |
|---|---|---|
| `Run My Tasks: Run Task...` | `Ctrl+Shift+T` / `Cmd+Shift+T` | Open the task picker |
| `Run My Tasks: Refresh` | — | Refresh the side panel task list |

## License

MIT
