#!/usr/bin/env node
// Bundles engine/engine.py into a self-contained folder (build/engine) with PyInstaller,
// so end users don't need Python. Must run on each target OS (PyInstaller doesn't cross-compile).
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const isWin = process.platform === 'win32';
const venvPython = path.join(root, '.venv', isWin ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.LOCUS_PYTHON || (fs.existsSync(venvPython) ? venvPython : isWin ? 'python' : 'python3');

const run = (args, opts = {}) => execFileSync(python, args, { stdio: 'inherit', cwd: root, ...opts });

console.log(`Using Python: ${python}`);
run(['-m', 'pip', 'install', '--quiet', '-r', 'engine/requirements.txt', 'pyinstaller']);

const work = path.join(root, 'build', 'pyinstaller');
const dist = path.join(root, 'build', 'pyinstaller-dist');
run(['-m', 'PyInstaller', '--noconfirm', '--clean', '--workpath', work, '--distpath', dist, 'locus-engine.spec'], {
  cwd: path.join(root, 'engine'),
});

const out = path.join(root, 'build', 'engine');
fs.rmSync(out, { recursive: true, force: true });
fs.renameSync(path.join(dist, 'locus-engine'), out);
console.log(`Engine bundled at ${path.relative(root, out)}`);
