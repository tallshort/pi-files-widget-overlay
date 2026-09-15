import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import type { DiffStats } from "./types";

const GIT_MAX_BUFFER = 32 * 1024 * 1024;
type GitErrorReporter = (operation: string) => void;
const execFileAsync = promisify(execFile);

function runGitSync(cwd: string, args: string[], timeout: number): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout, stdio: "pipe", maxBuffer: GIT_MAX_BUFFER }).toString();
}

async function runGit(cwd: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", timeout, maxBuffer: GIT_MAX_BUFFER, signal });
  return stdout.toString();
}

export function isGitRepo(cwd: string): boolean {
  try {
    runGitSync(cwd, ["rev-parse", "--is-inside-work-tree"], 2000);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepoAsync(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], 2000, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Path of `cwd` relative to the repository top-level (e.g. "app/"), or "" when
 * at the top level. Git status reports paths relative to the repository root,
 * while this widget's node keys are relative to `cwd`.
 */
function getGitPathPrefix(cwd: string): string {
  try {
    return runGitSync(cwd, ["rev-parse", "--show-prefix"], 2000).trim();
  } catch {
    return "";
  }
}

async function getGitPathPrefixAsync(cwd: string): Promise<string> {
  try {
    return (await runGit(cwd, ["rev-parse", "--show-prefix"], 2000)).trim();
  } catch {
    return "";
  }
}

/** Convert a repo-root-relative path to a cwd-relative one; null if outside cwd. */
function stripPathPrefix(filePath: string, prefix: string): string | null {
  if (!prefix) return filePath;
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return null;
}

function isRenameOrCopy(statusCode: string): boolean {
  return statusCode.includes("R") || statusCode.includes("C");
}

/** Parse porcelain v1 -z output. Rename/copy records contain destination then source. */
function parseGitStatus(output: string, prefix: string): Map<string, string> {
  const status = new Map<string, string>();
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 3) continue;
    const statusCode = entry.slice(0, 2).trim() || "?";
    const filePath = entry.slice(3);
    if (isRenameOrCopy(statusCode)) index += 1; // Consume the source path; retain the destination.
    const relativePath = stripPathPrefix(filePath, prefix)?.replace(/\/+$/, "");
    if (relativePath) status.set(relativePath, statusCode);
  }
  return status;
}

function mergeDiffStat(target: Map<string, DiffStats>, path: string, additions: number, deletions: number): void {
  const existing = target.get(path);
  target.set(path, existing ? { additions: existing.additions + additions, deletions: existing.deletions + deletions } : { additions, deletions });
}

/** Parse --numstat -z output, including rename/copy records with old and new NUL fields. */
function parseGitDiffStats(output: string, target: Map<string, DiffStats>): void {
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const firstTab = entry.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : entry.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;

    const additions = parseInt(entry.slice(0, firstTab), 10) || 0;
    const deletions = parseInt(entry.slice(firstTab + 1, secondTab), 10) || 0;
    let filePath = entry.slice(secondTab + 1);
    if (filePath === "") {
      index += 1; // Old path.
      filePath = entries[++index] ?? ""; // New path.
    }
    if (filePath) mergeDiffStat(target, filePath, additions, deletions);
  }
}

export function getGitStatus(cwd: string, options: { includeIgnored?: boolean } = {}, onError?: GitErrorReporter): Map<string, string> {
  try {
    const args = ["status", "--porcelain=v1", "-z"];
    if (options.includeIgnored !== false) args.push("--ignored");
    return parseGitStatus(runGitSync(cwd, args, 5000), getGitPathPrefix(cwd));
  } catch {
    onError?.("Git status");
    return new Map();
  }
}

export function getGitFileList(cwd: string, onError?: GitErrorReporter): string[] {
  const files = new Set<string>();
  try {
    for (const entry of runGitSync(cwd, ["ls-files", "-z"], 5000).split("\0")) {
      if (entry) files.add(entry);
    }
  } catch {
    onError?.("tracked file list");
  }

  try {
    const prefix = getGitPathPrefix(cwd);
    for (const filePath of parseGitStatus(runGitSync(cwd, ["status", "--porcelain=v1", "-uall", "-z"], 5000), prefix).keys()) {
      files.add(filePath);
    }
  } catch {
    onError?.("Git status");
  }

  return Array.from(files);
}

export async function getGitFileListAsync(cwd: string, signal?: AbortSignal): Promise<{ files: string[]; failed: boolean; trackedFailed: boolean; statusFailed: boolean }> {
  const [trackedResult, statusResult] = await Promise.allSettled([
    runGit(cwd, ["ls-files", "-z"], 5000, signal),
    getGitStatusAsync(cwd, { includeIgnored: false, includeUntracked: true }, signal),
  ]);
  const trackedFailed = trackedResult.status === "rejected";
  const statusFailed = statusResult.status === "rejected" || (statusResult.status === "fulfilled" && statusResult.value.failed);
  const files = new Set(trackedResult.status === "fulfilled" ? trackedResult.value.split("\0").filter(Boolean) : []);
  if (statusResult.status === "fulfilled") {
    for (const filePath of statusResult.value.status.keys()) files.add(filePath);
  }
  return { files: Array.from(files), failed: trackedFailed || statusFailed, trackedFailed, statusFailed };
}

export function getGitBranch(cwd: string): string {
  try {
    return runGitSync(cwd, ["branch", "--show-current"], 2000).trim();
  } catch {
    return "";
  }
}

export function getGitDiffStats(cwd: string, onError?: GitErrorReporter): Map<string, DiffStats> {
  const stats = new Map<string, DiffStats>();
  try {
    parseGitDiffStats(runGitSync(cwd, ["diff", "--relative", "--numstat", "-z", "HEAD"], 5000), stats);
  } catch {
    onError?.("Git diff statistics");
  }
  return stats;
}

export async function getGitStatusAsync(cwd: string, options: { includeIgnored?: boolean; includeUntracked?: boolean } = {}, signal?: AbortSignal): Promise<{ status: Map<string, string>; failed: boolean }> {
  try {
    const args = ["status", "--porcelain=v1", "-z"];
    if (options.includeIgnored !== false) args.push("--ignored");
    if (options.includeUntracked) args.push("-uall");
    const [prefix, output] = await Promise.all([getGitPathPrefixAsync(cwd), runGit(cwd, args, 5000, signal)]);
    return { status: parseGitStatus(output, prefix), failed: false };
  } catch {
    return { status: new Map(), failed: true };
  }
}

export async function getGitBranchAsync(cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    return (await runGit(cwd, ["branch", "--show-current"], 2000, signal)).trim();
  } catch {
    return "";
  }
}

export async function getGitDiffStatsAsync(cwd: string, signal?: AbortSignal): Promise<{ stats: Map<string, DiffStats>; failed: boolean }> {
  const stats = new Map<string, DiffStats>();
  try {
    const output = await runGit(cwd, ["diff", "--relative", "--numstat", "-z", "HEAD"], 5000, signal);
    parseGitDiffStats(output, stats);
    return { stats, failed: false };
  } catch {
    return { stats, failed: true };
  }
}
