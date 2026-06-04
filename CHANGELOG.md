# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Task stayed in a running state in the activity bar after being stopped via the stop inline action

## [0.1.0] - 2026-06-04

### Added

- Status bar button to open a quick-pick task launcher (`Ctrl+Shift+T` / `Cmd+Shift+T`)
- Activity bar side panel listing all workspace tasks with run/stop inline actions
- Task grouping: create named virtual groups, add/remove tasks, run or stop the entire group at once
- Refresh button in the Tasks panel to reload the task list
- `runMyTasks.statusBarAlignment` setting to place the button on the left or right side of the status bar
- `runMyTasks.statusBarPriority` setting to control the button position within its alignment group
- `runMyTasks.showTaskType` setting to show/hide task source and type detail lines in the picker

[Unreleased]: https://github.com/riccardoflp/run-my-tasks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/riccardoflp/run-my-tasks/releases/tag/v0.1.0
