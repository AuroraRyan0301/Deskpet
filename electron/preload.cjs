// CommonJS on purpose: preload scripts run before the ESM loader is available, and
// the package is "type": "module", so the .cjs extension is what makes this load.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petShell', {
  // Present only under Electron. index.html checks for it to decide whether to draw
  // the desktop-pet chrome or the plain web layout.
  isElectron: true,
  // Tells main whether the cursor is over an opaque pixel of the pet, which is how
  // click-through is toggled without losing the ability to drag the pet.
  hover: (over) => ipcRenderer.send('pet:hover', Boolean(over)),
  setPanel: (open) => ipcRenderer.send('pet:panel', Boolean(open)),
  quit: () => ipcRenderer.send('pet:quit'),
  onPanel: (fn) => ipcRenderer.on('pet:panel', (_e, open) => fn(open)),
  onNextCharacter: (fn) => ipcRenderer.on('pet:next-character', () => fn()),
  onRecalibrate: (fn) => ipcRenderer.on('pet:recalibrate', () => fn()),

  // Voice input. The sidecar lives in the main process because it is a child process;
  // the renderer owns the grammar and the intent bus, so lines are forwarded raw.
  voiceStart: () => ipcRenderer.invoke('pet:voice-start'),
  voiceStop: () => ipcRenderer.send('pet:voice-stop'),
  voiceContext: (strings) => ipcRenderer.send('pet:voice-context', strings),
  onVoice: (fn) => ipcRenderer.on('pet:voice', (_e, line) => fn(line)),
});
