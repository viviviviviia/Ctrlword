import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const rustBin = join(homedir(), '.cargo', 'bin');
const environment = { ...process.env };
if (existsSync(join(rustBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo'))) {
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') || 'PATH';
    environment[pathKey] = rustBin + delimiter + (environment[pathKey] || '');
}
const child = spawn(
    process.execPath,
    [join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), ...process.argv.slice(2)],
    { cwd: root, env: environment, stdio: 'inherit' }
);
child.on('error', (error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
});
child.on('exit', (code) => {
    process.exitCode = code ?? 1;
});
