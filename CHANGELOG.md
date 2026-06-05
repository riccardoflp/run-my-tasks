# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Rename groups via right-click context menu → **Rename Group**, or by pressing **F2** with a group selected; also available from the command palette

### Fixed

- Clicking a task item in the tree no longer starts the task — tasks start and stop only via the play/stop inline icon buttons

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

[Unreleased]: https://github.com/riccardoflp/run-my-tasks/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/riccardoflp/run-my-tasks/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/riccardoflp/run-my-tasks/releases/tag/v0.1.0
