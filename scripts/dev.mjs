import { spawn } from 'node:child_process';
const children = ['@freedms/api', '@freedms/web'].map(workspace => spawn('npm', ['run', 'dev', '-w', workspace], { stdio: 'inherit' }));
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; children.forEach(child => child.kill('SIGTERM')); process.exitCode = code; }
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
children.forEach(child => child.on('exit', code => stop(code ?? 0)));
