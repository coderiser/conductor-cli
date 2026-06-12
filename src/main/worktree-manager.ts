import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { WorktreeInfo, ResolvedRef, CleanupOptions, ConflictReport, WorktreeRow } from '../common/worktree-types';

export class WorktreeManager {
  private gitInstances = new Map<string, SimpleGit>();
  private activeWorktrees = new Map<string, WorktreeInfo>();

  static worktreesRoot(): string {
    return path.join(homedir(), '.conductor', 'worktrees');
  }

  static projectHash(projectPath: string): string {
    return crypto.createHash('sha256')
      .update(path.resolve(projectPath))
      .digest('hex').slice(0, 12);
  }

  static worktreeDir(projectPath: string, agentId: string): string {
    const hash = WorktreeManager.projectHash(projectPath);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const shortId = crypto.randomBytes(4).toString('hex');
    return path.join(WorktreeManager.worktreesRoot(), hash,
      `${agentId}-${date}-${shortId}`);
  }

  private getGit(projectPath: string): SimpleGit {
    let git = this.gitInstances.get(projectPath);
    if (!git) {
      git = simpleGit(projectPath);
      this.gitInstances.set(projectPath, git);
    }
    return git;
  }

  // ═══ Git Ref Resolution ═══

  async resolveRef(
    git: SimpleGit, input: string, remote: string = 'origin'
  ): Promise<ResolvedRef | null> {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const localRef = `refs/heads/${trimmed}`;
    if (await this.refExists(git, localRef)) {
      return { kind: 'local', fullRef: localRef, shortName: trimmed };
    }

    const prefix = `${remote}/`;
    const remoteName = trimmed.startsWith(prefix)
      ? trimmed.slice(prefix.length) : trimmed;
    const remoteRef = `refs/remotes/${remote}/${remoteName}`;
    if (await this.refExists(git, remoteRef)) {
      return { kind: 'remote-tracking', fullRef: remoteRef,
        shortName: remoteName, remote };
    }

    const tagRef = `refs/tags/${trimmed}`;
    if (await this.refExists(git, tagRef)) {
      return { kind: 'tag', fullRef: tagRef, shortName: trimmed };
    }

    return null;
  }

  private async refExists(git: SimpleGit, fullRef: string): Promise<boolean> {
    try {
      const out = await git.raw(['rev-parse', '--verify', `${fullRef}^{commit}`]);
      return /^[0-9a-f]{40,}/.test(out.trim());
    } catch { return false; }
  }

  // ═══ Worktree Creation ═══

  async createForAgent(
    sessionId: string, agentId: string, projectPath: string,
    baseBranch: string = 'main',
  ): Promise<WorktreeInfo> {
    const git = this.getGit(projectPath);
    const worktreePath = WorktreeManager.worktreeDir(projectPath, agentId);
    const branchName = `conductor/${agentId}/${Date.now().toString(36)}`;

    await git.raw(['worktree', 'prune']).catch(() => {});
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    let startPoint: ResolvedRef = { kind: 'head' };
    const resolved = await this.resolveRef(git, baseBranch);
    if (resolved) startPoint = resolved;

    if (startPoint.kind === 'remote-tracking') {
      await git.fetch([startPoint.remote, startPoint.shortName, '--quiet', '--no-tags'])
        .catch((err: unknown) => console.warn(
          `[worktree] fetch ${startPoint.remote}/${startPoint.shortName} failed:`, err));
    }

    const startPointArg = startPoint.kind === 'head' ? 'HEAD'
      : startPoint.kind === 'remote-tracking'
        ? `${startPoint.remote}/${startPoint.shortName}`
      : startPoint.shortName;

    let worktreeCreated = false;
    try {
      await git.raw([
        'worktree', 'add', '--no-track', '-b', branchName,
        worktreePath, startPointArg,
      ]);
      worktreeCreated = true;
      await git.cwd(worktreePath)
        .raw(['config', 'push.autoSetupRemote', 'true']).catch(() => {});
    } catch (err) {
      await this.rollbackCreation(git, worktreePath, branchName, worktreeCreated);
      throw new Error(`Failed to create worktree for ${agentId}: ` +
        `${err instanceof Error ? err.message : String(err)}`);
    }

    const info: WorktreeInfo = {
      id: crypto.randomUUID(), sessionId, agentId,
      worktreePath, branch: branchName, baseBranch,
      projectPath, createdAt: Date.now(), status: 'ready',
    };
    this.activeWorktrees.set(sessionId, info);
    return info;
  }

  private async rollbackCreation(
    git: SimpleGit, worktreePath: string, branchName: string, worktreeCreated: boolean,
  ): Promise<void> {
    if (worktreeCreated) {
      await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {});
    }
    try {
      await git.raw(['rev-parse', '--verify', `refs/heads/${branchName}`]);
      await git.raw(['branch', '-D', branchName]);
    } catch { /* already deleted — satisfied */ }
  }

  // ═══ Accessors ═══

  list(): WorktreeInfo[] { return Array.from(this.activeWorktrees.values()); }
  getBySession(sessionId: string): WorktreeInfo | undefined { return this.activeWorktrees.get(sessionId); }

  restoreFromRow(row: WorktreeRow): void {
    const info: WorktreeInfo = {
      id: row.id, sessionId: row.session_id, agentId: row.agent_id,
      worktreePath: row.worktree_path, branch: row.branch,
      baseBranch: row.base_branch, projectPath: row.project_path,
      createdAt: row.created_at, status: row.status as WorktreeInfo['status'],
    };
    this.activeWorktrees.set(row.session_id, info);
  }

  dispose(): void { this.gitInstances.clear(); this.activeWorktrees.clear(); }
}
