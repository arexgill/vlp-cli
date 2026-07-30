import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const PORCELAIN_STATUS_RE = /^(?<index>.)(?<worktree>.?) (?<path>.*)$/s;

async function runGit(cwd, args, { invalidRef } = {}) {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const message = String(error?.stderr || error?.stdout || error?.message || error);
    if (/unknown revision|bad revision|ambiguous argument/i.test(message)) {
      throw new Error(`Invalid ref: ${invalidRef || 'HEAD'}`);
    }
    if (/not a git repository/i.test(message)) {
      throw new Error('Project operations require a Git repository or worktree');
    }
    throw new Error(message.trim() || 'git command failed');
  }
}

async function resolveGitRoot(root) {
  return realpath(String((await runGit(root, ['rev-parse', '--show-toplevel'])).trim()));
}

function parsePorcelainStatusOutput(output) {
  const records = output.split('\0').filter((entry) => entry.length > 0);
  const paths = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const match = record.match(PORCELAIN_STATUS_RE);
    if (!match) {
      continue;
    }

    const status = `${match.groups.index}${match.groups.worktree}`;
    const firstPath = match.groups.path;
    const isRenameOrCopy = status.includes('R') || status.includes('C');

    if (isRenameOrCopy) {
      paths.push(firstPath);
      index += 1;
      continue;
    }

    if (status.includes('D')) {
      continue;
    }

    paths.push(firstPath);
  }

  return paths;
}

function parseNameStatusOutput(output) {
  const records = output.split('\0').filter((entry) => entry.length > 0);
  const paths = [];

  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];

    if (status[0] === 'R' || status[0] === 'C') {
      index += 1;
      const newPath = records[++index] ?? '';
      if (newPath) {
        paths.push(newPath);
      }
      continue;
    }

    const changedPath = records[++index] ?? '';
    if (status[0] !== 'D' && changedPath) {
      paths.push(changedPath);
    }
  }

  return paths;
}

function toScopePath(repoRoot, scopeRoot, repoRelativePath) {
  const absolutePath = path.join(repoRoot, repoRelativePath);
  const relativePath = path.relative(scopeRoot, absolutePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return null;
  }

  return relativePath.split(path.sep).join('/');
}

function uniqueSorted(paths) {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function collectWorkingTreeChanges(repoRoot) {
  const status = await runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return parsePorcelainStatusOutput(status);
}

async function collectStagedChanges(repoRoot) {
  const status = await runGit(repoRoot, ['diff', '--cached', '--name-status', '-z', '--find-renames']);
  return parseNameStatusOutput(status);
}

async function collectBaseChanges(repoRoot, base) {
  const diff = await runGit(repoRoot, ['diff', '--name-status', '-z', '--find-renames', base], { invalidRef: base });
  const changed = parseNameStatusOutput(diff);
  const untracked = await runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...changed, ...untracked.split('\0').filter(Boolean)];
}

export async function selectChangedFiles(root, { staged = false, base } = {}) {
  const scopeRoot = await realpath(path.resolve(String(root ?? '.')));
  const repoRoot = await resolveGitRoot(scopeRoot);
  const changes = base
    ? await collectBaseChanges(repoRoot, base)
    : staged
      ? await collectStagedChanges(repoRoot)
      : await collectWorkingTreeChanges(repoRoot);

  const scoped = changes
    .map((repoRelativePath) => toScopePath(repoRoot, scopeRoot, repoRelativePath))
    .filter((entry) => entry !== null);

  return uniqueSorted(scoped);
}
