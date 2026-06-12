import { BrowserView, BrowserWindow } from 'electron';

interface BrowserSession {
  id: string;
  view: BrowserView;
  url: string;
  sessionId: string;
}

export class EmbeddedBrowser {
  private browsers = new Map<string, BrowserSession>();
  private mainWindow: BrowserWindow;
  private nextId = 1;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  create(url: string, sessionId: string): Omit<BrowserSession, 'view'> {
    const id = `browser-${this.nextId++}`;
    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    this.mainWindow.addBrowserView(view);

    const bounds = this.mainWindow.getBounds();
    view.setBounds({
      x: Math.floor(bounds.width * 0.5),
      y: Math.floor(bounds.height * 0.5),
      width: Math.floor(bounds.width * 0.5),
      height: Math.floor(bounds.height * 0.5),
    });
    view.setAutoResize({ width: true, height: true, horizontal: true, vertical: true });

    view.webContents.loadURL(url);

    const session: BrowserSession = { id, view, url, sessionId };
    this.browsers.set(id, session);

    view.webContents.on('did-navigate', (_e, navUrl) => {
      session.url = navUrl;
    });

    return { id: session.id, url: session.url, sessionId: session.sessionId };
  }

  navigate(id: string, url: string): void {
    const session = this.browsers.get(id);
    if (session) {
      session.view.webContents.loadURL(url);
      session.url = url;
    }
  }

  async evaluate(id: string, code: string): Promise<unknown> {
    const session = this.browsers.get(id);
    if (!session) throw new Error(`Browser ${id} not found`);
    return session.view.webContents.executeJavaScript(code);
  }

  async screenshot(id: string): Promise<string> {
    const session = this.browsers.get(id);
    if (!session) throw new Error(`Browser ${id} not found`);
    const image = await session.view.webContents.capturePage();
    return image.toDataURL();
  }

  resize(id: string, bounds: { x: number; y: number; width: number; height: number }): void {
    const session = this.browsers.get(id);
    if (session) session.view.setBounds(bounds);
  }

  setVisible(id: string, visible: boolean): void {
    const session = this.browsers.get(id);
    if (!session) return;
    if (visible) {
      this.mainWindow.addBrowserView(session.view);
    } else {
      this.mainWindow.removeBrowserView(session.view);
    }
  }

  destroy(id: string): void {
    const session = this.browsers.get(id);
    if (!session) return;
    this.mainWindow.removeBrowserView(session.view);
    (session.view.webContents as any).destroy?.() ?? session.view.webContents.close();
    this.browsers.delete(id);
  }

  destroyAll(): void {
    for (const id of this.browsers.keys()) this.destroy(id);
  }

  get(id: string): Omit<BrowserSession, 'view'> | undefined {
    const s = this.browsers.get(id);
    if (!s) return undefined;
    return { id: s.id, url: s.url, sessionId: s.sessionId };
  }

  list(): Omit<BrowserSession, 'view'>[] {
    return Array.from(this.browsers.values()).map(s => ({
      id: s.id, url: s.url, sessionId: s.sessionId,
    }));
  }
}
