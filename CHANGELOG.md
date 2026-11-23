# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Multi-root workspaces: the **Groups** view shows one node per project (the folders of one git repository make one project) with the groups of that project, the same ones the windows opened on the repository show; the **+** button on a project creates a group in it
- Groups mixing the projects of a multi-root workspace, under **Workspace**: their tasks and launch configurations remember the folder they come from, shown next to their name
- The **Groups** and **Tasks** views of a multi-root workspace show only the projects whose repository is selected in the **Repositories** view of Source Control; the `runMyTasks.followScmSelection` setting turns it off
- The **Tasks** view of a multi-root workspace lists the tasks by folder, then by source, with the tasks of the `.code-workspace` file (named after the file) and the user tasks last; the picker tells the folder in its separators, and the search matches the folder names

### Changed

- The groups a multi-root workspace had so far are its **Workspace** groups
- **Open tasks.json** / **Open launch.json** ask which folder's file to open in a multi-root workspace
- **Export Groups...** exports the groups of one project at a time in a multi-root workspace, and **Import Groups...** asks which project to import them into

### Fixed

- In a multi-root workspace a group no longer runs, stops or shows the task of another folder that has the same name
- **Stop** and **Stop Group** stop a task started a moment before too: VS Code refused to stop a task it had not finished starting, which went on running while shown as stopped

## [0.8.1] - 2026-11-18

### Fixed

- **Run Group** starts the tasks and launch configurations in the order of the group, and a task that fails to start no longer keeps the others from starting
- Tasks with the same name from different sources (a task of `tasks.json` and the npm script `build`, say) are no longer mixed up: the group runs, stops and shows as running only the task of `tasks.json`, and the stop button stops the task it is on
- **Rename Group** no longer accepts the name of another group written with spaces around it, which gave two groups the same name
- **Move Up** / **Move Down** in a group move past the next task shown, skipping the tasks of the group this workspace lacks, instead of seeming to do nothing
- The views show the tasks added, renamed or removed in `tasks.json` as soon as it is saved
- Searching for the name of a group shows it also when it has no tasks
- A task already running, run again with `runMyTasks.terminalLocation` set to `editor`, no longer moves its terminal to the editor area the next time it is started from elsewhere
- The task list is no longer fetched again every time a task starts or ends

## [0.8.0] - 2026-10-22

### Added

- **Export Groups...** and **Import Groups...** in the `...` menu of the **Groups** view and in the command palette: export the picked groups to a JSON file and import them in another workspace. An imported group named as an existing one can be merged with it, replace it or be skipped, and the import tells which tasks and launch configurations the workspace lacks

### Changed

- With the `split` layout every terminal is split in the direction of `runMyTasks.editorTerminalPosition`: `below` now stacks the terminals one under the other, instead of putting them side by side in a row below the files
- The panel is closed once the terminal of a task has moved to the editor area, also when it holds other terminals

## [0.7.0] - 2026-10-20

### Added

- **Collapse All** and **Expand All** buttons in the title of the **Groups** and **Tasks** views
- Task terminals can open in the editor area: the `runMyTasks.terminalLocation` setting picks the panel or the editor, and `runMyTasks.editorTerminalLayout` whether they open side by side, each in its own split next to the files, all together in one group next to the files, or as full tabs of the current group; `runMyTasks.editorTerminalPosition` puts them to the right of the files or below them
- **Run in Editor** / **Run in Panel** in the right-click menu of a task, to run it in the place that is not the default

## [0.6.0] - 2026-10-15

### Changed

- Groups are shared by all the windows opened on the same git repository, worktrees included; the groups saved so far in a workspace move to its repository. Workspaces outside a git repository and multi-root workspaces keep their own groups

## [0.5.0] - 2026-10-13

### Added

- Search button in the side panel: filters the **Groups**, **Tasks** and **Launch Configurations** views as you type, matching the name of the item or of its group
- **Launch Configurations** view listing the configurations and compounds of `launch.json`, with inline **Start Debugging** / **Stop** buttons, **Run Without Debugging** in the right-click menu and an **Open launch.json** button
- Launch configurations can be added to groups (right-click, drag and drop or command palette), reordered, and are started and stopped by **Run Group** / **Stop Group**
- The task picker lists the launch configurations after the tasks
- Clicking a running launch configuration shows the Debug Console

### Changed

- **Delete Group** moved from the inline buttons of a group to its right-click context menu

## [0.4.0] - 2026-10-08

### Added

- Clicking a running task in the tree focuses the terminal it is running in

### Fixed

- The task picker now shows the command of `shell` and `process` tasks defined in `tasks.json` as the detail line

## [0.3.0] - 2026-06-05

### Added

- Drag and drop tasks from the **Tasks** view onto a group in the **Groups** view to add them; drag tasks between groups to move them
- Rename groups via right-click context menu → **Rename Group**, or by pressing **F2** with a group selected; also available from the command palette
- Open `tasks.json` button in the panel title bar
- Reorder tasks within a group via **Move Up** / **Move Down** in the right-click context menu, or by dragging a task onto another task in the same group
- Reorder groups via **Move Up** / **Move Down** in the right-click context menu, or by dragging a group header onto another group

### Fixed

- Clicking a task item in the tree no longer starts the task — tasks start and stop only via the play/stop inline icon buttons
- Tasks no longer reorder when running — list order now stays stable regardless of execution state
- Task stopped via the inline button was not shown as running when restarted immediately after
- **Run Group** now correctly relaunches tasks that were manually stopped but not yet fully terminated
- Tasks inside a group were displayed in VS Code's internal cache order instead of the user-defined order

## [0.2.0] - 2026-06-04

### Added

- Virtual groups: create named groups, assign tasks to them, and run or stop all tasks in a group at once via inline buttons or command palette
- Side panel split into two sections: **Groups** (virtual groups and their tasks) and **Tasks** (all workspace tasks by source)

### Fixed

- Task stayed in a running state in the activity bar after being stopped via the stop inline action

## [0.1.0] - 2026-06-04

### Added

- Status bar button to open a quick-pick task launcher (`Ctrl+Shift+T` / `Cmd+Shift+T`)
- Activity bar side panel listing all workspace tasks with run/stop inline actions
- Refresh button in the Tasks panel to reload the task list
- `runMyTasks.statusBarAlignment` setting to place the button on the left or right side of the status bar
- `runMyTasks.statusBarPriority` setting to control the button position within its alignment group
- `runMyTasks.showTaskType` setting to show/hide task source and type detail lines in the picker

[Unreleased]: https://github.com/riccardoflp/run-my-tasks/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/riccardoflp/run-my-tasks/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/riccardoflp/run-my-tasks/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/riccardoflp/run-my-tasks/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/riccardoflp/run-my-tasks/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/riccardoflp/run-my-tasks/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/riccardoflp/run-my-tasks/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/riccardoflp/run-my-tasks/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/riccardoflp/run-my-tasks/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/riccardoflp/run-my-tasks/releases/tag/v0.1.0
