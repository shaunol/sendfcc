const fs = require('fs');
const path = require('path');

const worker = fs.readFileSync(path.join(__dirname, 'src', 'worker.js'), 'utf8');
const homepage = fs.readFileSync(path.join(__dirname, 'src', 'index.html'), 'utf8');

// Escape template literal chars for embedding in JS
const escaped = homepage.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

const output = worker.replace("'%%HOMEPAGE%%'", '`' + escaped + '`');

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'worker.js'), output);

console.log('Build complete: dist/worker.js');
