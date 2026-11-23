import * as vscode from 'vscode';
import { getLaunchConfigs, LaunchConfig, startLaunch } from './launchConfigs';
import { compareOrigins, isMultiRoot, TaskOrigin, taskOrigin, workspaceFileLabel } from './projects';
import { runTask } from './taskTerminals';

interface TaskQuickPickItem extends vscode.QuickPickItem {
  task: vscode.Task;
}

interface LaunchQuickPickItem extends vscode.QuickPickItem {
  launch: LaunchConfig;
}

export async function showTaskPicker(): Promise<void> {
  let tasks: vscode.Task[];
  try {
    tasks = await vscode.tasks.fetchTasks();
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to fetch tasks: ${err}`);
    return;
  }

  const launches = getLaunchConfigs();

  if (tasks.length === 0 && launches.length === 0) {
    vscode.window.showInformationMessage(
      'No tasks found. Add tasks to .vscode/tasks.json to get started.',
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('runMyTasks');
  const showType = config.get<boolean>('showTaskType', true);

  // Group tasks by source, Workspace first then alphabetical. In a multi-root workspace by
  // origin (folder, workspace file, user tasks) first, so the separators tell where each task comes from
  const multiRoot = isMultiRoot();
  const sections = new Map<string, { origin: TaskOrigin; source: string; tasks: vscode.Task[] }>();
  for (const task of tasks) {
    const origin = taskOrigin(task);
    const key = multiRoot ? `${origin.key}\u0000${task.source}` : task.source;
    const section = sections.get(key) ?? { origin, source: task.source, tasks: [] };
    section.tasks.push(task);
    sections.set(key, section);
  }
  const compareSources = (a: string, b: string): number => {
    if (a === b) { return 0; }
    if (a === 'Workspace') { return -1; }
    if (b === 'Workspace') { return 1; }
    return a.localeCompare(b);
  };
  const sortedSections = [...sections.values()].sort((a, b) =>
    (multiRoot ? compareOrigins(a.origin, b.origin) : 0) || compareSources(a.source, b.source));

  const items: vscode.QuickPickItem[] = [];
  for (const section of sortedSections) {
    const label = multiRoot ? `${section.origin.label} · ${section.source}` : section.source;
    items.push({ label, kind: vscode.QuickPickItemKind.Separator });

    const sourceTasks = section.tasks.sort((a, b) => a.name.localeCompare(b.name));
    for (const task of sourceTasks) {
      const item: TaskQuickPickItem = {
        label: `$(run) ${task.name}`,
        task,
      };
      if (showType) {
        item.detail = buildTaskDetail(task);
      }
      items.push(item);
    }
  }

  // Launch configurations last, in launch.json order
  if (launches.length > 0) {
    items.push({ label: 'Launch Configurations', kind: vscode.QuickPickItemKind.Separator });
    for (const launch of launches) {
      const item: LaunchQuickPickItem = {
        label: `$(debug-alt) ${launch.name}`,
        ...(multiRoot ? { description: launch.folder?.name ?? workspaceFileLabel() } : {}),
        launch,
      };
      if (showType) {
        item.detail = buildLaunchDetail(launch);
      }
      items.push(item);
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a task or launch configuration to run...',
    matchOnDetail: true,
  });

  if (selected && 'launch' in selected) {
    await startLaunch((selected as LaunchQuickPickItem).launch);
    return;
  }

  if (!selected || !('task' in selected)) {
    return;
  }

  try {
    await runTask((selected as TaskQuickPickItem).task);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to run task "${(selected as TaskQuickPickItem).task.name}": ${err}`);
  }
}

function buildTaskDetail(task: vscode.Task): string | undefined {
  const def = task.definition;
  if (def.type === 'npm' && def.script) {
    return `npm run ${def.script}`;
  }
  // tasks.json definitions carry only the type: the command lives on the execution
  const cmd = commandLineOf(task.execution);
  if (!cmd) { return undefined; }
  return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
}

function buildLaunchDetail(launch: LaunchConfig): string {
  if (launch.compound) { return `compound: ${launch.compound.join(', ')}`; }
  return [launch.type, launch.request].filter(Boolean).join(' ');
}

function commandLineOf(execution: vscode.Task['execution']): string | undefined {
  const text = (part: string | vscode.ShellQuotedString) => (typeof part === 'string' ? part : part.value);
  if (execution instanceof vscode.ShellExecution) {
    if (execution.commandLine) { return execution.commandLine; }
    if (!execution.command) { return undefined; }
    return [execution.command, ...(execution.args ?? [])].map(text).join(' ');
  }
  if (execution instanceof vscode.ProcessExecution) {
    return [execution.process, ...execution.args].join(' ');
  }
  return undefined;
}
