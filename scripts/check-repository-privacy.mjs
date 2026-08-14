import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const forbiddenStrings = [
  ["10", "11", "11", "1"].join("."),
  ["root@docker", ".lan"].join(""),
  ["docker", ".lan"].join(""),
  ["🤖 OpenCode", "调度"].join(""),
  ["🤖 OpenCode", "调度-test"].join(""),
];

const excludedPrefixes = [".git/", "node_modules/", "build/", ".next/", "dist/"];

function isExcluded(file) {
  return excludedPrefixes.some((prefix) => file.startsWith(prefix));
}

function lineNumberAt(content, offset) {
  return content.slice(0, offset).split("\n").length;
}

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => !isExcluded(file));

const findings = [];
for (const file of trackedFiles) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;

  for (const forbidden of forbiddenStrings) {
    let offset = content.indexOf(forbidden);
    while (offset !== -1) {
      findings.push({ file, line: lineNumberAt(content, offset), forbidden });
      offset = content.indexOf(forbidden, offset + forbidden.length);
    }
  }
}

if (findings.length > 0) {
  console.error("Repository privacy check failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} contains a forbidden private-environment string`);
  }
  process.exitCode = 1;
} else {
  console.log("Repository privacy check passed.");
}
