import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { store, checkVersionAndMigrate, seedBuiltinServers } from './services/store.service';
import { registerConfigHandlers } from './handlers/config.handler';
import { registerConversationHandlers } from './handlers/conversation.handler';
import { registerProjectHandlers } from './handlers/project.handler';
import { registerMCPHandlers, setMainWindow, cleanupMCPServers } from './handlers/mcp.handler';
import {
  registerPluginHandlers,
  setPluginMainWindow,
  initializePluginManager,
  cleanupPluginManager,
} from './handlers/plugin.handler';
import { registerIconHandlers, setTrayGetter } from './handlers/icon.handler';
import { registerSystemPromptHandlers } from './handlers/system-prompt.handler';
import { AutoUpdaterService } from './services/auto-updater.service';
import { registerUpdaterHandlers } from './handlers/updater.handler';
import { logUpdater } from './services/auto-updater-logger';
import {
  registerSkillHandlers,
  setSkillMainWindow,
  initSkillWatcher,
  cleanupSkillWatcher,
} from './handlers/skill.handler';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const updaterService = new AutoUpdaterService();

/**
 * Get the custom app title from config or return default
 */
function getAppTitle(): string {
  const config = store.get('config');
  return config?.appearance?.customization?.appTitle || 'Claudia';
}

/**
 * Resolve the current icon path: custom if set and exists, otherwise default
 */
function getDefaultIconPath(): string {
  // In packaged apps, nativeImage can't read from inside ASAR archives.
  // extraResources copies icon.ico to process.resourcesPath outside the ASAR.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.ico');
  }
  return path.join(__dirname, '..', 'build', 'icon.ico');
}

function getIconPath(): string {
  const config = store.get('config');
  const customIconPath = config?.appearance?.customization?.iconPath;
  if (customIconPath && fs.existsSync(customIconPath)) return customIconPath;
  return getDefaultIconPath();
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTrayMenu() {
  if (!tray) return;
  const appTitle = getAppTitle();
  tray.setToolTip(appTitle);
  const contextMenu = Menu.buildFromTemplate([
    { label: `Show ${appTitle}`, click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });

  tray.on('double-click', () => showWindow());
}

function createMenu() {
  const template: any[] = [
    {
      label: 'File',
      submenu: [
        {
          id: 'new-conversation',
          label: 'New Conversation',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow?.webContents.send('menu:new-conversation');
          },
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow?.webContents.send('menu:open-settings');
          },
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            mainWindow?.webContents.send('menu:toggle-sidebar');
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'Ctrl+D',
          click: () => {
            mainWindow?.webContents.toggleDevTools();
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${getAppTitle()}`,
          click: () => {
            mainWindow?.webContents.send('menu:about');
          },
        },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: async () => {
            const config = store.get('config');
            const url = config?.preferences?.updateCheckUrl;
            logUpdater('info', 'Menu: user clicked "Check for Updates..."', { hasUrl: !!url });
            if (!url) {
              logUpdater('warn', 'Menu: no update URL configured — showing info dialog');
              const { dialog } = require('electron');
              dialog.showMessageBox({
                type: 'info',
                title: 'Check for Updates',
                message: 'No update URL configured.',
                detail: 'Please set an Update Check URL in Settings → Preferences → Auto Update.',
                buttons: ['OK'],
              });
              return;
            }
            await updaterService.checkForUpdate(url, 'menu');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  // Get saved window state or use defaults
  const windowState = store.get('windowState', {
    width: 1200,
    height: 800,
  }) as { width: number; height: number; x?: number; y?: number };

  // Get config for customization
  const config = store.get('config');
  const windowTitle = config?.appearance?.customization?.appTitle || 'Claudia';
  const accentColor = config?.appearance?.customization?.accentColor;
  const theme = config?.appearance?.theme || 'system';

  // Determine icon path (use custom if exists, otherwise default)
  const iconPath = getIconPath();

  // Determine background color (use accent color or default based on theme)
  let backgroundColor = '#1a1a1a'; // Default dark
  if (accentColor) {
    backgroundColor = accentColor;
  } else if (theme === 'light') {
    backgroundColor = '#FAF9F7';
  }

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 600,
    title: windowTitle,
    icon: iconPath,
    frame: false, // Remove default frame to enable custom title bar
    titleBarStyle: 'hidden', // Hide title bar but keep traffic lights on macOS
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
    },
    show: false, // Don't show until ready-to-show
    backgroundColor: backgroundColor,
  });

  // Save window state on resize/move
  mainWindow.on('resize', () => saveWindowState());
  mainWindow.on('move', () => saveWindowState());

  // Show window maximized when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });

  // Once the renderer has loaded its IPC subscribers, check whether the
  // previous update attempt left a failure sentinel and surface it to the UI.
  mainWindow.webContents.once('did-finish-load', () => {
    try {
      updaterService.checkLastAttempt();
    } catch (err) {
      logUpdater('error', 'checkLastAttempt threw', { error: err });
    }
  });

  // Set main window reference for MCP handlers
  setMainWindow(mainWindow);

  // Set main window reference for Plugin handlers
  setPluginMainWindow(mainWindow);

  // Set main window reference for Skill handlers and start file watcher
  setSkillMainWindow(mainWindow);
  initSkillWatcher();

  // Load the app
  if (app.isPackaged) {
    // Production: load from packaged files
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  } else {
    // Development: load from vite dev server
    mainWindow.loadURL('http://localhost:5175');
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();

      // First-time balloon notification on Windows
      if (process.platform === 'win32' && tray) {
        const shown = store.get('shownTrayNotification', false) as boolean;
        if (!shown) {
          const appTitle = getAppTitle();
          tray.displayBalloon({
            iconType: 'info',
            title: appTitle,
            content: `${appTitle} is still running in the background.`,
          });
          store.set('shownTrayNotification', true);
        }
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function saveWindowState() {
  if (!mainWindow) return;

  const bounds = mainWindow.getBounds();
  store.set('windowState', {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
  });
}

// App lifecycle
app.whenReady().then(async () => {
  // Check version and migrate settings/clear cache if needed
  const packageJson = require(path.join(__dirname, '..', 'package.json'));
  const currentVersion = packageJson.version;
  await checkVersionAndMigrate(currentVersion, session.defaultSession);

  // Seed built-in MCP servers (adds them if missing, preserves existing config)
  seedBuiltinServers();

  // Register IPC handlers
  registerConfigHandlers();
  registerConversationHandlers();
  registerProjectHandlers();
  registerMCPHandlers();
  registerPluginHandlers();
  registerIconHandlers(() => mainWindow);
  registerSystemPromptHandlers();
  registerUpdaterHandlers(() => mainWindow, updaterService);
  registerSkillHandlers();

  // Window title handler
  ipcMain.handle('window:setTitle', (_, title: string) => {
    if (mainWindow) mainWindow.setTitle(title || 'Claudia');
    updateTrayMenu();
  });

  // Window background color handler
  ipcMain.handle('window:setBackgroundColor', (_, color: string) => {
    if (mainWindow) {
      mainWindow.setBackgroundColor(color);
    }
  });

  // Window control handlers
  ipcMain.handle('window:minimize', () => {
    if (mainWindow) {
      mainWindow.minimize();
    }
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow) {
      mainWindow.close();
    }
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() || false;
  });

  // Show application menu as popup
  ipcMain.handle('window:showMenu', (event, x: number, y: number) => {
    if (mainWindow) {
      const menu = Menu.getApplicationMenu();
      if (menu) {
        menu.popup({ window: mainWindow, x, y });
      }
    }
  });

  // Enable/disable New Conversation menu item
  ipcMain.on('menu:set-new-conversation-enabled', (_event, enabled: boolean) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return;
    const fileMenu = menu.items.find((item) => item.label === 'File');
    if (!fileMenu || !fileMenu.submenu) return;
    const item = fileMenu.submenu.items.find((i) => i.id === 'new-conversation');
    if (item) {
      item.enabled = enabled;
      Menu.setApplicationMenu(menu);
    }
  });

  // Initialize plugin manager
  await initializePluginManager();

  // Create application menu
  createMenu();

  createWindow();
  createTray();
  setTrayGetter(() => tray);

  // Start periodic update check if URL is configured
  const initialConfig = store.get('config');
  const updateCheckUrl = initialConfig?.preferences?.updateCheckUrl;
  if (updateCheckUrl) {
    logUpdater('info', 'Startup: periodic update check configured', { updateCheckUrl });
    updaterService.startPeriodicCheck(updateCheckUrl, 30 * 60 * 1000);
  } else {
    logUpdater('info', 'Startup: no update URL configured — periodic check disabled');
  }

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// App stays alive in system tray — do not quit when window is closed
app.on('window-all-closed', () => {
  // Window is hidden (not destroyed) when user clicks close, so this only
  // fires when the window is truly destroyed (i.e., during quit). Do nothing.
});

// Clean up MCP servers and plugins before quit
app.on('before-quit', async (event) => {
  event.preventDefault();
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  await cleanupMCPServers();
  await cleanupPluginManager();
  cleanupSkillWatcher();
  app.exit();
});

// File dialog handlers
ipcMain.handle('file:select', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      { name: 'Documents', extensions: ['pdf', 'docx', 'pptx', 'txt', 'csv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.filePaths;
});

ipcMain.handle('file:selectDirectories', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.filePaths;
});

ipcMain.handle('file:listDirectory', async (_event, dirPath: string) => {
  try {
    if (!path.isAbsolute(dirPath) || !fs.existsSync(dirPath)) {
      return { success: false, entries: [], error: 'Invalid directory path' };
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return {
      success: true,
      entries: entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
    };
  } catch (err) {
    return { success: false, entries: [], error: String(err) };
  }
});

ipcMain.handle('file:read', async (_event, filePath: string) => {
  try {
    if (!path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
      throw new Error('Invalid file path');
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(String(err));
  }
});

// Basic error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});
