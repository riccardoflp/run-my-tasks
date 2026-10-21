# Run My Tasks

A VS Code extension that gives you fast access to all workspace tasks and launch configurations via a status bar button, a keyboard shortcut, and a dedicated side panel with virtual groups.

## Features

**Status bar button** — a `▶ Tasks` button appears in the status bar. Click it to open a searchable picker with all tasks defined in the workspace (including tasks from extensions like npm, gulp, etc.) and the launch configurations of `launch.json`.

**Keyboard shortcut** — press `Ctrl+Shift+T` (or `Cmd+Shift+T` on macOS) to open the same picker from anywhere.

**Side panel** — a "Run My Tasks" view in the Activity Bar is split into three sections:

- **Groups** — virtual groups you create to organize and batch-run tasks and launch configurations. Each group has inline **Run All** and **Stop All** buttons. Tasks within a group can be reordered with **Move Up** / **Move Down** (right-click menu) or by dragging. Groups themselves can also be reordered the same way. Groups belong to the git repository: every window opened on it, worktrees included, shows the same groups.
- **Tasks** — all workspace tasks listed by source. Tasks show a green spinning indicator while running and have inline **Run** / **Stop** buttons. Right-click a task to add it to a group.
- **Launch Configurations** — the configurations and compounds of `launch.json`. They show the same indicator while a debug session is running and have inline **Start Debugging** / **Stop** buttons; right-click one to **Run Without Debugging** or to add it to a group.

Click a running task to focus the terminal it is running in, or a running launch configuration to show the Debug Console.

**Terminals in the editor** — the terminals of the tasks started from Run My Tasks can open in the editor area instead of the panel (`runMyTasks.terminalLocation`): each in its own split after the files you are working on, all together as tabs of one group next to the files, or as full tabs of the current group (`runMyTasks.editorTerminalLayout`); the splits go to the right or downwards (`runMyTasks.editorTerminalPosition`). Right-click a task to **Run in Editor** or **Run in Panel**, whichever is not the default.

**Launch configurations in groups** — a group lists its tasks first, then its launch configurations, and **Run All** starts them in that order: handy to start the servers and then attach the debugger. A compound counts as running while all its configurations are.

**Search** — the search button in the title of each section filters all three sections as you type; every word must appear in the name of the item or of its group (or source). The **Clear Search** button shows everything again.

**Drag and drop** — drag a task from the **Tasks** view, or a launch configuration from the **Launch Configurations** view, onto a group header in the **Groups** view to add it to that group. Drag a task within the **Groups** view onto another task to reorder, or onto a different group header to move it; the same goes for launch configurations.

**Import and export groups** — **Export Groups...** in the `...` menu of the **Groups** view saves the groups you pick to a JSON file; **Import Groups...** adds the groups of such a file to the ones you have, in another workspace or on another machine. For a group named as an existing one you choose whether to merge the two (adding the tasks and launch configurations it lacks), replace it or skip it. Groups refer to tasks and launch configurations by name: the import tells you which ones the workspace lacks.

The picker groups tasks by source (Workspace tasks first, then extension-contributed tasks in alphabetical order), lists the launch configurations last, and optionally shows the underlying shell command, npm script or debugger type as a detail line.

## Requirements

- VS Code 1.90.0 or later
- At least one task defined in `.vscode/tasks.json` or contributed by an installed extension, or a launch configuration in `.vscode/launch.json`

## Configuration

All settings are under the `runMyTasks` namespace and can be changed in **Settings** (`Ctrl+,`) by searching for "Run My Tasks".

| Setting | Type | Default | Description |
|---|---|---|---|
| `runMyTasks.statusBarAlignment` | `"left"` \| `"right"` | `"left"` | Side of the status bar where the Tasks button appears. |
| `runMyTasks.statusBarPriority` | `number` | `100` | Position priority within the chosen side. Higher numbers place the button further left on the Left side (VS Code default behavior). |
| `runMyTasks.showTaskType` | `boolean` | `true` | Show the shell command or npm script (the debugger type for launch configurations) as a detail line below each name in the picker. Disable if you prefer a cleaner list. |
| `runMyTasks.terminalLocation` | `"panel"` \| `"editor"` | `"panel"` | Where the terminals of the tasks started from Run My Tasks (side panel, picker, **Run Group**) open. Tasks whose `presentation.reveal` is not `always` keep their terminal in the panel. |
| `runMyTasks.editorTerminalLayout` | `"split"` \| `"group"` \| `"tab"` | `"split"` | When the terminals open in the editor: `split` opens each one in its own editor group, after the files you are working on and the other terminals; `group` opens them all as tabs of one group next to the files; `tab` opens them as full tabs of the current group, without creating a new group. |
| `runMyTasks.editorTerminalPosition` | `"right"` \| `"below"` | `"right"` | With the `split` and `group` layouts, whether the terminals open to the right of the files or below them. With `split` every terminal is split in this direction: `right` puts them all side by side, `below` stacks them all one under the other. |

### Example `settings.json`

```json
{
  "runMyTasks.statusBarAlignment": "right",
  "runMyTasks.statusBarPriority": 200,
  "runMyTasks.showTaskType": false,
  "runMyTasks.terminalLocation": "editor",
  "runMyTasks.editorTerminalLayout": "split",
  "runMyTasks.editorTerminalPosition": "below"
}
```

## Commands

| Command | Default keybinding | Description |
|---|---|---|
| `Run My Tasks: Run Task...` | `Ctrl+Shift+T` / `Cmd+Shift+T` | Open the task picker |
| `Run My Tasks: Search...` | — | Filter the side panel as you type |
| `Run My Tasks: Clear Search` | — | Remove the side panel filter |
| `Run My Tasks: Refresh` | — | Refresh the side panel task list |
| `Run My Tasks: Collapse All Groups` / `Expand All Groups` | — | Collapse or expand every group in the **Groups** view |
| `Run My Tasks: Collapse All Tasks` / `Expand All Tasks` | — | Collapse or expand every task source in the **Tasks** view |
| `Run My Tasks: Create Group` | — | Create a new virtual group |
| `Run My Tasks: Rename Group` | `F2` (when group focused) | Rename the selected group |
| `Run My Tasks: Delete Group` | — | Delete the selected group |
| `Run My Tasks: Run Group` | — | Run all tasks and launch configurations in the selected group |
| `Run My Tasks: Stop Group` | — | Stop all running tasks and debug sessions in the selected group |
| `Run My Tasks: Export Groups...` | — | Save the picked groups to a JSON file |
| `Run My Tasks: Import Groups...` | — | Add the groups of an exported JSON file to the existing ones |
| `Run My Tasks: Open tasks.json` | — | Open the workspace `tasks.json` file |
| `Run My Tasks: Open launch.json` | — | Open the workspace `launch.json` file |

## License

MIT
