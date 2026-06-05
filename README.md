# Run My Tasks

A VS Code extension that gives you fast access to all workspace tasks via a status bar button, a keyboard shortcut, and a dedicated side panel with virtual groups.

## Features

**Status bar button** — a `▶ Tasks` button appears in the status bar. Click it to open a searchable picker with all tasks defined in the workspace (including tasks from extensions like npm, gulp, etc.).

**Keyboard shortcut** — press `Ctrl+Shift+T` (or `Cmd+Shift+T` on macOS) to open the same picker from anywhere.

**Side panel** — a "Run My Tasks" view in the Activity Bar is split into two sections:

- **Groups** — virtual groups you create to organize and batch-run tasks. Each group has inline **Run All** and **Stop All** buttons. Tasks within a group can be reordered with **Move Up** / **Move Down** (right-click menu) or by dragging. Groups themselves can also be reordered the same way.
- **Tasks** — all workspace tasks listed by source. Tasks show a green spinning indicator while running and have inline **Run** / **Stop** buttons. Right-click a task to add it to a group.

**Drag and drop** — drag a task from the **Tasks** view onto a group header in the **Groups** view to add it to that group. Drag a task within the **Groups** view onto another task to reorder, or onto a different group header to move it.

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
| `Run My Tasks: Create Group` | — | Create a new virtual group |
| `Run My Tasks: Rename Group` | `F2` (when group focused) | Rename the selected group |
| `Run My Tasks: Delete Group` | — | Delete the selected group |
| `Run My Tasks: Run Group` | — | Run all tasks in the selected group |
| `Run My Tasks: Stop Group` | — | Stop all running tasks in the selected group |
| `Run My Tasks: Open tasks.json` | — | Open the workspace `tasks.json` file |

## License

MIT
