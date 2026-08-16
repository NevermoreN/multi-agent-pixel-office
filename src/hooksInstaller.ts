import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function installHooks(extensionPath: string, port: number, pythonPath: string): Promise<void> {
  const installer = path.join(extensionPath, 'hooks', 'install.py');
  const hook = path.join(extensionPath, 'hooks', 'hook.py');
  await execFileAsync(pythonPath, [installer, '--home', os.homedir(), '--source', hook, '--port', String(port)], {
    timeout: 30_000,
    maxBuffer: 1_000_000,
  });
}
