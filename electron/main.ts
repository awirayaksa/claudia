import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import * as path from 'path';
import { store } from './services/store.service';
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

let mainWindow: BrowserWindow | null = null;

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
          label: 'About Claudia',
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

  // Get icon path
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false, // Don't show until ready-to-show
    backgroundColor: '#1a1a1a', // Dark background to match theme
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
    mainWindow.loadURL('http://localhost:5173');
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
  // Register IPC handlers
  registerConfigHandlers();
  registerConversationHandlers();
  registerProjectHandlers();
  registerMCPHandlers();
  registerPluginHandlers();

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

// Basic error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});
