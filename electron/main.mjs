// Electron shell: a transparent, frameless, always-on-top window that sits on the
// desktop above other apps. The renderer is the exact same page the browser version
// loads, served over http from the in-process static server — MediaPipe's WASM and the
// ES modules both refuse to load from file://.
//
//   npm run pet
//
// Note: launch must not inherit ELECTRON_RUN_AS_NODE, or the binary starts as plain
// node and no window ever appears. The npm script strips it.
import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, screen, shell } from 'electron';
import { VoiceSidecar } from './voice.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startStatic } from '../serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Pet-only footprint vs. pet plus the control panel. The window physically resizes,
// because a transparent window still swallows clicks wherever it covers the screen.
const PET_SIZE = { width: 300, height: 340 };
const PANEL_SIZE = { width: 820, height: 560 };

let win = null;
let tray = null;
let statics = null;
let panelOpen = false;

function createWindow(origin) {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...PET_SIZE,
    x: workArea.x + workArea.width - PET_SIZE.width - 40,
    y: workArea.y + workArea.height - PET_SIZE.height - 40,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 'screen-saver' keeps the pet above full-screen apps, which is the whole point of
    // a desktop pet; 'floating' alone loses to fullscreen windows.
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Click-through by default: the window is mostly empty pixels, and without this the
  // user cannot click the desktop or the app behind the pet. `forward: true` still
  // delivers move events, so the renderer can tell us when the cursor is over the pet
  // and we can briefly take the mouse back.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadURL(origin);
  win.once('ready-to-show', () => win.show());

  // The camera prompt has to be answered before getUserMedia resolves.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

function setPanel(open) {
  if (!win) return;
  panelOpen = open;
  const target = open ? PANEL_SIZE : PET_SIZE;
  const [x, y] = win.getPosition();
  const { workArea } = screen.getPrimaryDisplay();
  // Grow leftward and upward so the pet itself does not jump across the screen.
  const nx = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - target.width));
  const ny = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - target.height));
  win.setBounds({ x: nx, y: ny, ...target }, false);
  // With the panel open the window has real UI in it, so it must receive clicks
  // everywhere; closed, it goes back to being mostly a hole.
  win.setIgnoreMouseEvents(!open, open ? undefined : { forward: true });
  win.webContents.send('pet:panel', open);
  if (open) win.focus();
}

function buildTray() {
  // An empty image plus a title is the macOS-friendly way to get a menu-bar entry
  // without shipping an icon file.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('🐾');
  tray.setToolTip('Desk Pet');
  const refresh = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: panelOpen ? '收起控制面板' : '打开控制面板', click: () => { setPanel(!panelOpen); refresh(); } },
      { type: 'separator' },
      { label: '切换角色', click: () => win?.webContents.send('pet:next-character') },
      { label: '重新校准坐姿', click: () => win?.webContents.send('pet:recalibrate') },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  };
  refresh();
  tray.on('click', () => { setPanel(!panelOpen); refresh(); });
}

app.whenReady().then(async () => {
  // Hide from the Dock: a desktop pet belongs in the menu bar.
  app.dock?.hide();
  statics = await startStatic({ quiet: true, root: ROOT });
  createWindow(statics.origin);
  buildTray();

  globalShortcut.register('CommandOrControl+Shift+P', () => setPanel(!panelOpen));

  // The renderer reports whether the cursor is over an opaque part of the pet. Only
  // then do we accept clicks, so dragging and clicking the pet work while the
  // surrounding transparent area stays click-through.
  ipcMain.on('pet:hover', (_e, over) => {
    if (!win || panelOpen) return;
    win.setIgnoreMouseEvents(!over, over ? undefined : { forward: true });
  });
  ipcMain.on('pet:panel', (_e, open) => setPanel(Boolean(open)));
  ipcMain.on('pet:quit', () => app.quit());
  ipcMain.handle('pet:origin', () => statics.origin);

  // Voice sidecar, started on request rather than at launch: it opens the microphone, and
  // that should be a thing the user turns on, not a side effect of running the pet.
  const voice = new VoiceSidecar({
    dir: join(HERE, '..', 'native'),
    onLine: (line) => win?.webContents.send('pet:voice', line),
    onExit: () => win?.webContents.send('pet:voice', { type: 'stopped' }),
  });
  ipcMain.handle('pet:voice-start', () => voice.start());
  ipcMain.on('pet:voice-stop', () => voice.stop());
  ipcMain.on('pet:voice-context', (_e, strings) => voice.setContext(strings));
  app.on('before-quit', () => voice.stop());
});

app.on('window-all-closed', () => { /* tray keeps the app alive */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  statics?.server.close();
});
