import { app, BrowserWindow, ipcMain, Menu, session } from 'electron';
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
import { registerIconHandlers } from './handlers/icon.handler';

let mainWindow: BrowserWindow | null = null;

/**
 * Get the custom app title from config or return default
 */
function getAppTitle(): string {
  const config = store.get('config');
  return config?.appearance?.customization?.appTitle || 'Claudia';
}

function createMenu() {
  const template: any[] = [
    {
      label: 'File',
      submenu: [
        {
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
        { role: 'toggleDevTools' },
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
  const customIconPath = config?.appearance?.customization?.iconPath;
  const windowTitle = config?.appearance?.customization?.appTitle || 'Claudia';
  const accentColor = config?.appearance?.customization?.accentColor;
  const theme = config?.appearance?.theme || 'system';

  // Determine icon path (use custom if exists, otherwise default)
  let iconPath: string;
  if (customIconPath && fs.existsSync(customIconPath)) {
    iconPath = customIconPath;
  } else {
    iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  }

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
    },
    show: false, // Don't show until ready-to-show
    backgroundColor: backgroundColor,
  });

  // Save window state on resize/move
  mainWindow.on('resize', () => saveWindowState());
  mainWindow.on('move', () => saveWindowState());

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Set main window reference for MCP handlers
  setMainWindow(mainWindow);

  // Set main window reference for Plugin handlers
  setPluginMainWindow(mainWindow);

  // Load the app
  if (app.isPackaged) {
    // Production: load from packaged files
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  } else {
    // Development: load from vite dev server
    mainWindow.loadURL('http://localhost:5175');
    mainWindow.webContents.openDevTools();
  }

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

  // Window title handler
  ipcMain.handle('window:setTitle', (_, title: string) => {
    if (mainWindow) {
      mainWindow.setTitle(title || 'Claudia');
    }
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

  // Initialize plugin manager
  await initializePluginManager();

  // Create application menu
  createMenu();

  createWindow();

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  // On macOS, apps typically stay active until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up MCP servers and plugins before quit
app.on('before-quit', async (event) => {
  event.preventDefault();
  await cleanupMCPServers();
  await cleanupPluginManager();
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
