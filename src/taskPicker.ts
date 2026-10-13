import * as vscode from 'vscode';
import { getLaunchConfigs, LaunchConfig, startLaunch } from './launchConfigs';

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

  // Group tasks by source, Workspace first then alphabetical
  const groups = new Map<string, vscode.Task[]>();
  for (const task of tasks) {
    const bucket = groups.get(task.source) ?? [];
    bucket.push(task);
    groups.set(task.source, bucket);
  }
  const sortedSources = [...groups.keys()].sort((a, b) => {
    if (a === 'Workspace') { return -1; }
    if (b === 'Workspace') { return 1; }
    return a.localeCompare(b);
  });

  const items: vscode.QuickPickItem[] = [];
  for (const source of sortedSources) {
    items.push({ label: source, kind: vscode.QuickPickItemKind.Separator });

    const sourceTasks = (groups.get(source) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
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
    await vscode.tasks.executeTask((selected as TaskQuickPickItem).task);
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
