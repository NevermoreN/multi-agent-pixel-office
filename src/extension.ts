import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BrokerClient } from './brokerClient.js';
import { installHooks } from './hooksInstaller.js';
import { PixelOfficeViewProvider } from './viewProvider.js';

const VIEW_ID = 'multiAgentPixelOffice.officeView';
const CONFIG_SECTION = 'multiAgentPixelOffice';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const port = config.get<number>('port', 7933);
  const configuredPython = config.get<string>('pythonPath', '').trim();
  const pythonPath = configuredPython || process.env.PYTHON || process.env.PYTHON3 || 'python3';
  const channel = vscode.window.createOutputChannel('Multi-Agent Pixel Office');
  context.subscriptions.push(channel);

  await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  const runtimeDir = path.join(os.homedir(), '.multi-agent-pixel-office');
  const tokenPath = path.join(runtimeDir, 'token');
  const userDataDir = path.dirname(path.dirname(context.globalStorageUri.fsPath));
  const broker = new BrokerClient(port, channel, {
    brokerPath: context.asAbsolutePath(path.join('broker', 'pixel-agent-broker.py')),
    pythonPath,
    tokenPath,
    env: {
      ...process.env,
      MULTI_AGENT_PIXEL_OFFICE_PORT: String(port),
      MULTI_AGENT_PIXEL_OFFICE_USER_DATA: userDataDir,
      MULTI_AGENT_PIXEL_OFFICE_CLAUDE_HOME: path.join(os.homedir(), '.claude'),
      MULTI_AGENT_PIXEL_OFFICE_STATE: path.join(context.globalStorageUri.fsPath, 'state.json'),
      MULTI_AGENT_PIXEL_OFFICE_TOKEN: tokenPath,
    },
  });
  const provider = new PixelOfficeViewProvider(context, broker, port);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('multiAgentPixelOffice.showPanel', () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand('multiAgentPixelOffice.installHooks', async () => {
      try {
        await installHooks(context.extensionPath, port, pythonPath);
        await context.globalState.update('hooksInstalled', true);
        void vscode.window.showInformationMessage('Multi-Agent Pixel Office hooks installed for GitHub Copilot and Claude Code.');
      } catch (error) {
        void vscode.window.showErrorMessage(`Multi-Agent Pixel Office hook installation failed: ${formatError(error)}`);
      }
    }),
    vscode.commands.registerCommand('multiAgentPixelOffice.showHooksConfig', async () => {
      const hookScript = path.join(runtimeDir, 'hook.py');
      const document = await vscode.workspace.openTextDocument({
        content: [
          `Broker: http://127.0.0.1:${port}`,
          `Runtime directory: ${runtimeDir}`,
          `Hook script: ${hookScript}`,
          `GitHub Copilot hooks: ${path.join(os.homedir(), '.copilot', 'hooks', 'hooks.json')}`,
          `Claude Code settings: ${path.join(os.homedir(), '.claude', 'settings.json')}`,
        ].join('\n'),
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(document);
    }),
    { dispose: () => broker.stop() },
  );

  broker.start();

  if (!hooksPresent(runtimeDir)) {
    const action = await vscode.window.showInformationMessage(
      'Multi-Agent Pixel Office needs local hooks to receive agent activity.',
      'Install Hooks',
      'Later',
    );
    if (action === 'Install Hooks') await vscode.commands.executeCommand('multiAgentPixelOffice.installHooks');
  }

  if (config.get<boolean>('autoShowPanel', false)) void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  channel.appendLine(`Using broker endpoint 127.0.0.1:${port}`);
}

export function deactivate(): void {}

function hooksPresent(runtimeDir: string): boolean {
  const hookScript = path.join(runtimeDir, 'hook.py');
  if (!fs.existsSync(hookScript)) return false;
  const configs = [
    path.join(os.homedir(), '.copilot', 'hooks', 'hooks.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  return configs.every((file) => {
    try { return fs.readFileSync(file, 'utf8').includes(hookScript); }
    catch { return false; }
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
