const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
let serverProc = null;

function startServerExecutable() {
  // If there is a bundled server binary (server_all_v2.exe) in the same directory's ../server_all_v2, run it
  const exePath = path.join(__dirname, '..', 'server_all_v2', process.platform==='win32' ? 'server_all_v2.exe' : 'server_all_v2.js');
  const isExe = process.platform==='win32' && require('fs').existsSync(exePath);
  const cmd = isExe ? exePath : process.execPath;
  const args = isExe ? [] : [exePath];
  serverProc = spawn(cmd, args, { cwd: path.join(__dirname,'..','server_all_v2'), stdio:'inherit' });
  serverProc.on('close', (code)=> { console.log('server exited', code); });
}

function createWindow() {
  const win = new BrowserWindow({ width: 1280, height: 800, webPreferences: { nodeIntegration:false, contextIsolation:true } });
  win.loadURL('http://localhost:7100/public/queue_client.html');
}

app.whenReady().then(()=>{ startServerExecutable(); createWindow(); });

app.on('window-all-closed', ()=>{ if (serverProc) serverProc.kill(); if (process.platform !== 'darwin') app.quit(); });
