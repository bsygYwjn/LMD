import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function discover(directory) {
  const entries = await readdir(path.join(project, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? discover(relative) : /\.test\.(mjs|ts)$/.test(entry.name) ? [relative] : [];
  }));
  return files.flat();
}

// Run standalone suites serially: integration suites start their own isolated
// servers and FFmpeg processes. New suites cannot silently miss the full gate.
const suites = (await Promise.all([discover("server"), discover("src")])).flat().sort();
const failures = [];
for (const suite of suites) {
  console.log(`\n[${suites.indexOf(suite) + 1}/${suites.length}] ${suite}`);
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(project, suite)], {
      cwd: project, stdio: "inherit", windowsHide: true,
    });
    child.once("error", error => { console.error(error.message); resolve(1); });
    child.once("close", exitCode => resolve(exitCode ?? 1));
  });
  if (code !== 0) failures.push(suite);
}
console.log(`\n${suites.length - failures.length}/${suites.length} suites passed.`);
if (failures.length) {
  console.error(`Failed suites:\n${failures.join("\n")}`);
  process.exitCode = 1;
}
