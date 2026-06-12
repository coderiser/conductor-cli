import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Electron before importing the module under test
vi.mock('electron', () => {
  const mockWebContents = {
    loadURL: vi.fn(),
    executeJavaScript: vi.fn(),
    capturePage: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
  };
  const MockBrowserView = vi.fn(function (this: any) {
    this.webContents = { ...mockWebContents };
    return this;
  });
  (MockBrowserView as any).prototype.setBounds = vi.fn();
  (MockBrowserView as any).prototype.setAutoResize = vi.fn();

  const MockBrowserWindow = vi.fn(function (this: any) {
    this.addBrowserView = vi.fn();
    this.removeBrowserView = vi.fn();
    this.getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1920, height: 1080 }));
    return this;
  });

  return { BrowserView: MockBrowserView, BrowserWindow: MockBrowserWindow };
});

import { EmbeddedBrowser } from '../src/main/embedded-browser';
import { BrowserWindow } from 'electron';

describe('EmbeddedBrowser', () => {
  let browser: EmbeddedBrowser;
  let mainWindow: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mainWindow = new BrowserWindow();
    browser = new EmbeddedBrowser(mainWindow);
  });

  it('should create a browser session and return metadata', () => {
    const info = browser.create('https://example.com', 'S1');
    expect(info.id).toMatch(/^browser-/);
    expect(info.url).toBe('https://example.com');
    expect(info.sessionId).toBe('S1');
  });

  it('should generate unique IDs for each browser', () => {
    const a = browser.create('https://a.com', 'S1');
    const b = browser.create('https://b.com', 'S2');
    const c = browser.create('https://c.com', 'S3');
    const ids = [a.id, b.id, c.id];
    expect(new Set(ids).size).toBe(3);
  });

  it('should get a browser by id', () => {
    const created = browser.create('https://example.com', 'S1');
    const found = browser.get(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.url).toBe('https://example.com');
  });

  it('should return undefined for unknown browser id', () => {
    expect(browser.get('nonexistent')).toBeUndefined();
  });

  it('should list all active browsers', () => {
    browser.create('https://a.com', 'S1');
    browser.create('https://b.com', 'S2');
    expect(browser.list()).toHaveLength(2);
  });

  it('should destroy a browser and remove from list', () => {
    const info = browser.create('https://example.com', 'S1');
    expect(browser.list()).toHaveLength(1);
    browser.destroy(info.id);
    expect(browser.list()).toHaveLength(0);
    expect(browser.get(info.id)).toBeUndefined();
  });

  it('should not throw when destroying unknown id', () => {
    expect(() => browser.destroy('nonexistent')).not.toThrow();
  });

  it('should destroy all browsers', () => {
    browser.create('https://a.com', 'S1');
    browser.create('https://b.com', 'S2');
    browser.create('https://c.com', 'S3');
    expect(browser.list()).toHaveLength(3);
    browser.destroyAll();
    expect(browser.list()).toHaveLength(0);
  });

  it('should throw when evaluating on unknown browser', async () => {
    await expect(browser.evaluate('nonexistent', '1+1')).rejects.toThrow('not found');
  });

  it('should throw when screenshot on unknown browser', async () => {
    await expect(browser.screenshot('nonexistent')).rejects.toThrow('not found');
  });
});
