const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, Tray, Menu } = require('electron');
const path = require('path');
const { fork } = require('child_process');

process.env.IS_ELECTRON = 'true';
// 禁用硬體加速可減少部分透明背景異常
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('wm-window-animations-disabled');

let win;
let serverProcess;
let tray = null;        // 系統列圖示變數
let isQuitting = false; // 判斷是否真的要退出

function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    win = new BrowserWindow({
        width: 100,
        height: 100,
        x: width - 120,
        y: height - 120,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true, // 不顯示在下方工作列
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile('index.html');

    // [重要] 攔截關閉事件：預設只是隱藏，除非 isQuitting 為 true
    win.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            win.hide();
        }
    });
}

function startServer() {
    const scriptPath = path.join(__dirname, 'web.js');
    serverProcess = fork(scriptPath, [], {
        stdio: 'inherit',
        env: { ...process.env, IS_ELECTRON: true }
    });
}

function createTray() {
    // 圖示路徑：請確保您的專案目錄下有 content/DSC05068.jpg
    const iconPath = path.join(__dirname, 'content', 'DSC05068.jpg');

    tray = new Tray(iconPath);
    tray.setToolTip('狗狗金控-毛毛小幫手');

    // 右鍵選單
    const contextMenu = Menu.buildFromTemplate([
        {
            label: '顯示狗狗',
            click: () => win.show()
        },
        {
            label: '隱藏狗狗',
            click: () => win.hide()
        },
        { type: 'separator' },
        {
            label: '結束程式',
            click: () => {
                isQuitting = true; // 標記為真．退出
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);

    // 左鍵點擊圖示：切換顯示/隱藏
    tray.on('click', () => {
        if (win.isVisible()) {
            win.hide();
        } else {
            win.show();
        }
    });
}

app.whenReady().then(() => {
    startServer();
    createWindow();
    createTray(); // [FIX] 這裡必須呼叫，否則右下角不會有圖示！

    // 註冊快捷鍵 (救回視窗用)
    globalShortcut.register('Ctrl+Alt+H', () => {
        if (win) {
            win.show();
            win.focus();
            win.webContents.send('reset-ui');
        }
    });
});

app.on('before-quit', () => {
    isQuitting = true;
    if (serverProcess) serverProcess.kill();
});

// 監聽前端縮放請求
ipcMain.on('resize-window', (event, arg) => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    const targetW = Math.round(arg.width);
    const targetH = Math.round(arg.height);
    const newX = Math.round(width - targetW - 20);
    const newY = Math.round(height - targetH - 20);
    const isShrinking = (targetW === 100 && targetH === 100);

    // 縮小時先隱藏再移動，避免動畫閃爍
    if (isShrinking) {
        win.hide();
        win.setBounds({ x: newX, y: newY, width: targetW, height: targetH });
        setTimeout(() => { win.show(); }, 200);
    } else {
        win.setBounds({ x: newX, y: newY, width: targetW, height: targetH });
    }
});

ipcMain.on('open-url', (event, url) => {
    shell.openExternal(url);
});

// 監聽關閉程式請求 (右鍵選單用)
ipcMain.on('close-app', () => {
    if (serverProcess) serverProcess.kill();
    app.exit(0);
});

// [FIX] 變數統一：修正這裡原本用了 undefined 的 mainWindow
ipcMain.on('hide-to-tray', () => {
    if (win) win.hide();
});
ipcMain.on('open-dog-menu', () => {
    const template = [
        {
            label: '📉 縮小',
            click: () => {
                if (win) win.hide();
            }
        },
        { type: 'separator' }, // 分隔線
        {
            label: '❌ 關閉',
            click: () => {
                isQuitting = true; // 標記為真．退出
                if (serverProcess) serverProcess.kill();
                app.quit();
            }
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    // 讓選單在滑鼠游標處彈出
    menu.popup({ window: win });
});
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (serverProcess) {
        serverProcess.kill();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});