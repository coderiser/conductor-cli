import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import simpleGit from 'simple-git';
import { WorktreeManager } from '../src/main/worktree-manager';

describe('WorktreeManager', () => {
  let manager: WorktreeManager;
  let testRepo: string;
  let git: ReturnType<typeof simpleGit>;

  beforeEach(async () => {
    testRepo = path.join(os.tmpdir(), 'conductor-wt-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(testRepo, { recursive: true });
    git = simpleGit(testRepo);
    await git.init();
    await git.addConfig('user.name', 'test');
    await git.addConfig('user.email', 'test@test.com');
    fs.writeFileSync(path.join(testRepo, 'README.md'), '# Test');
    await git.add('README.md');
    await git.commit('initial');
    manager = new WorktreeManager();
  });

  afterEach(() => {
    manager.dispose();
    try { fs.rmSync(testRepo, { recursive: true, force: true }); } catch {}
  });

  it('should create a worktree for an agent', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    expect(info.sessionId).toBe('S1');
    expect(info.status).toBe('ready');
    expect(fs.existsSync(info.worktreePath)).toBe(true);
    expect(info.worktreePath).toContain(path.join(os.homedir(), '.conductor', 'worktrees'));
    expect(info.branch).toMatch(/^conductor\/claude\//);
  });

  it('should create worktrees with unique paths and branches', async () => {
    const a = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const b = await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branch).not.toBe(b.branch);
  });

  it('should return empty list when no worktrees', () => {
    expect(manager.list()).toEqual([]);
  });

  it('should list all active worktrees', async () => {
    await manager.createForAgent('S1', 'claude', testRepo, 'main');
    await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    expect(manager.list().length).toBe(2);
  });

  it('should get worktree by session id', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const found = manager.getBySession('S1');
    expect(found).toBeDefined();
    expect(found!.branch).toBe(info.branch);
  });

  it('should return undefined for unknown session', () => {
    expect(manager.getBySession('unknown')).toBeUndefined();
  });

  it('should create branch from base commit', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const wtGit = simpleGit(info.worktreePath);
    const log = await wtGit.log();
    expect(log.all.length).toBeGreaterThanOrEqual(1);
    const branches = await git.branch();
    expect(branches.all).toContain(info.branch);
  });
});
