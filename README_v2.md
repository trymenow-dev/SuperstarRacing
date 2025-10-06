
Superstar Racing — All Done V2
=============================

What I added in V2:
- server_all_v2: improved matchmaking (ELO), persistent DB (SQLite), replay storage, stronger anti-cheat heuristics.
- Electron packaging + script expectations: builds server binary with pkg and includes Electron app that runs bundled server exe.
- GitHub Actions workflow (build_windows.yml) to build Electron on Windows and pack server with pkg automatically.
- Unity full project placeholders with a simple cube OBJ as a starting asset for scenes.
- Instructions and package.json scripts to build server binary using 'pkg'.

How to use:
1. Run server locally:
   cd server_all_v2
   npm install
   node server_all_v2.js
   open http://localhost:7100/public/queue_client.html

2. Build server binary (Windows x64) locally:
   npm install -g pkg
   cd server_all_v2
   npm install
   npx pkg . --targets node18-win-x64 --output server_all_v2.exe

3. Build Electron on Windows (or via CI using the workflow in .github/workflows/build_windows.yml)

Notes:
- The repo/workflow assumes you place folders at repo root: server_all_v2, electron_bundle, unity_full_project, etc.
- For a single-exe desktop release, the pipeline packs the Node server with 'pkg' and includes it in the Electron installer.

If you'd like, I can now:
- Generate a GitHub repo structure and push these files to a new repository (I'll produce the git commands and optional remote URL).
- Produce the GitHub Actions secrets/config to sign or notarize the installer (requires credentials).
- Build the server_all_v2.exe here — I cannot run pkg in this environment but provided all files & scripts so you or CI can run them.
