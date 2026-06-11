const { app, BrowserWindow, Menu, shell, dialog, utilityProcess } = require("electron");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");

let serverProc = null;
let win = null;
let serverPort = null;

// Per-user writable data dir (the app bundle itself is read-only).
const DATA_DIR = path.join(app.getPath("userData"), "data");

// Locate the bundled Next standalone server.
function standaloneDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "standalone")
    : path.join(__dirname, "..", ".next", "standalone");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/settings", timeout: 2000 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("server start timeout"));
        else setTimeout(tick, 350);
      });
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

async function startServer() {
  const dir = standaloneDir();
  const serverJs = path.join(dir, "server.js");
  const port = await getFreePort();

  // utilityProcess runs the Next server as a managed background Node process —
  // no extra Dock icon / no second "app" (unlike spawning the Electron binary).
  // server.js does process.chdir(__dirname) itself, so no cwd option is needed.
  serverProc = utilityProcess.fork(serverJs, [], {
    serviceName: "wb-autolist-server",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      WB_DATA_DIR: DATA_DIR,
    },
    stdio: "inherit",
  });
  serverProc.on("exit", (code) => {
    if (code && code !== 0 && !app.isQuitting) {
      dialog.showErrorBox("WB AutoList", `后台服务退出（code ${code}）。`);
    }
  });

  await waitForServer(port);
  return port;
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#09080f",
    title: "WB AutoList",
    autoHideMenuBar: true, // no Alt-to-reveal chrome menu on Windows/Linux
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.on("closed", () => {
    win = null;
  });
  // open external links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

// Resume any batch jobs left pending from a previous run (worker is in-memory,
// so a restart needs a nudge — hitting this endpoint calls resumeWorkerIfNeeded).
function resumeQueue(port) {
  try {
    http.get({ host: "127.0.0.1", port, path: "/api/batch/jobs", timeout: 5000 }, (r) => r.resume()).on("error", () => {});
  } catch {
    /* ignore */
  }
}

app.whenReady().then(async () => {
  // Drop the default Electron menu bar (File/Edit/View…) on Windows/Linux — it
  // looks unprofessional for a consumer app. macOS keeps its menu so the
  // standard ⌘C/⌘V/⌘Q accelerators and app menu remain.
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  try {
    serverPort = await startServer();
    createWindow(serverPort);
    resumeQueue(serverPort);
  } catch (e) {
    dialog.showErrorBox("WB AutoList", `启动失败：${e.message}`);
    app.quit();
  }
  // macOS: re-open a window when the dock icon is clicked and none are open
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(serverPort ?? (serverPort = await startServer()));
    }
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
  try {
    if (serverProc) serverProc.kill();
  } catch {
    /* ignore */
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
