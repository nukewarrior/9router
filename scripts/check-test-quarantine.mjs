import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = process.cwd();
const testsRoot = path.join(repositoryRoot, "tests");
const registryPath = path.join(testsRoot, "quarantine.json");

function relativeRepositoryPath(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

async function collectQuarantineFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectQuarantineFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".quarantine.test.js")) {
      files.push(relativeRepositoryPath(entryPath));
    }
  }

  return files;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

let registry;
try {
  registry = JSON.parse(await readFile(registryPath, "utf8"));
} catch (error) {
  console.error(`Unable to read ${relativeRepositoryPath(registryPath)}: ${error.message}`);
  process.exit(1);
}

const actualFiles = sorted(await collectQuarantineFiles(testsRoot));
const registeredTests = registry?.tests;
const errors = [];

if (!registeredTests || typeof registeredTests !== "object" || Array.isArray(registeredTests)) {
  errors.push(`${relativeRepositoryPath(registryPath)} must contain an object at tests`);
} else {
  const registeredFiles = Object.keys(registeredTests);

  for (const file of actualFiles) {
    if (!Object.hasOwn(registeredTests, file)) {
      errors.push(`Quarantine file is not registered: ${file}`);
    }
  }

  for (const file of registeredFiles) {
    if (!actualFiles.includes(file)) {
      errors.push(`Quarantine registry entry does not exist: ${file}`);
    }

    const metadata = registeredTests[file];
    if (!metadata || typeof metadata !== "object") {
      errors.push(`Quarantine metadata must be an object: ${file}`);
      continue;
    }
    if (typeof metadata.reason !== "string" || metadata.reason.trim() === "") {
      errors.push(`Quarantine entry needs a non-empty reason: ${file}`);
    }
    if (typeof metadata.baseline !== "string" || metadata.baseline.trim() === "") {
      errors.push(`Quarantine entry needs a non-empty baseline: ${file}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Test quarantine registry check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Test quarantine registry is consistent: ${actualFiles.length} file(s)`);
