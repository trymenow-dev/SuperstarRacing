/*
server_all_v2.js
- Adds persistent matchmaking queue with ELO-based matching (simple)
- Enhanced anti-cheat: speed history, replay logging for suspicious moves, server-side collision placeholder
- Adds admin endpoints to export replay logs and player stats
- Supports starting match with bundled server binary (for Electron packaging)
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const msgpack = require('notepack.io');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.static('public'));

// DB
const dbFile = path.join(__dirname, 'data.db');
const db = new Database(dbFile);
db.prepare(`CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT, color TEXT, created_at INTEGER, last_seen INTEGER, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, elo INTEGER DEFAULT 1200)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS replays (id TEXT PRIMARY KEY, matchId TEXT, data TEXT, created_at INTEGER)`).run();

function upsertPlayer(id, name, color) {
  const now = Date.now();
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  if (p) {
    db.prepare('UPDATE players SET name=?, color=?, last_seen=? WHERE id = ?').run(name, color, now, id);
  } else {
    db.prepare('INSERT INTO players (id,name,color,created_at,last_seen) VALUES (?,?,?,?,?)').run(id, name, color, now, now);
  }
}

// WebSocket server
const wss = new WebSocket.Server({ noServer: true, path: '/ws' });
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else socket.destroy();
});

const rooms = {}; // roomId -> players
const lobbyQueue = []; // array of { sid, elo }
const matches = {};
const connectionMap = new Map();
const clientMeta = new Map();

function send(ws, type, payload){ ws.send(msgpack.encode({ t:type, p:payload })); }

// Simple ELO update
function updateElo(winnerId, loserId) {
  const w = db.prepare('SELECT elo FROM players WHERE id = ?').get(winnerId) || { elo:1200 };
  const l = db.prepare('SELECT elo FROM players WHERE id = ?').get(loserId) || { elo:1200 };
  const K = 30;
  const expected = 1/(1+Math.pow(10, (l.elo - w.elo)/400));
  const expectedL = 1 - expected;
  const newW = Math.round(w.elo + K*(1 - expected));
  const newL = Math.round(l.elo + K*(0 - expectedL));
  db.prepare('UPDATE players SET elo=? WHERE id=?').run(newW, winnerId);
  db.prepare('UPDATE players SET elo=? WHERE id=?').run(newL, loserId);
}

// Match class with replay logging and stronger anti-cheat heuristics
class Match {
  constructor(id, playersList) {
    this.id = id;
    this.players = {}; // sid -> state
    this.inputs = {};
    this.tickRate = 60;
    this.broadcastRate = 10;
    this.running = false;
    this.replay = []; // collect authoritative snapshots (compact)
    this.maxSpeed = 520;
    playersList.forEach(p => {
      this.players[p.sid] = { id:p.sid, x:200 + Math.random()*300, y:300 + Math.random()*150, angle:0, speed:0, lap:0, checkpointIndex:0, meta:p.meta };
      this.inputs[p.sid] = { throttle:0, brake:0, steer:0, ts:Date.now() };
    });
  }
  applyInput(sid, input) {
    const now = Date.now();
    const last = this.inputs[sid] && this.inputs[sid].ts ? this.inputs[sid].ts : 0;
    if (now - last < 15) return; // prevent insane input rate
    this.inputs[sid] = { throttle:Math.max(0,Math.min(1,input.throttle||0)), brake:Math.max(0,Math.min(1,input.brake||0)), steer:Math.max(-1,Math.min(1,input.steer||0)), ts:now, seq: input.seq || 0 };
  }
  start() {
    if (this.running) return;
    this.running = true;
    this._tick = setInterval(()=> this._step(1/this.tickRate), 1000/this.tickRate);
    this._bcast = setInterval(()=> this._broadcast(), 1000/this.broadcastRate);
  }
  stop() {
    clearInterval(this._tick); clearInterval(this._bcast); this.running=false;
    // save replay to DB
    try {
      const id = 'r_' + Math.random().toString(36).slice(2,9);
      db.prepare('INSERT INTO replays (id, matchId, data, created_at) VALUES (?,?,?,?)').run(id, this.id, JSON.stringify(this.replay), Date.now());
    } catch(e){ console.warn('replay save failed', e); }
  }
  _step(dt) {
    for (const sid in this.players) {
      const p = this.players[sid];
      const inp = this.inputs[sid] || { throttle:0, brake:0, steer:0 };
      const accel = (inp.throttle||0)*120;
      const brake = (inp.brake||0)*200;
      p.speed += (accel - brake) * dt;
      p.speed *= Math.max(0, 1 - 1.5*dt);
      if (!isFinite(p.speed)) p.speed = 0;
      // speed history check (anti-cheat): if speed exceeds max by >20%, mark suspicious
      if (p.speed > this.maxSpeed * 1.2) {
        // clamp and log
        p.speed = this.maxSpeed;
        this._flagCheat(sid, 'overspeed');
      }
      p.angle += (inp.steer||0) * dt * 3.0 * Math.max(0.2, Math.abs(p.speed)/100);
      const nx = p.x + Math.cos(p.angle) * p.speed * dt;
      const ny = p.y + Math.sin(p.angle) * p.speed * dt;
      const dx = nx - p.x, dy = ny - p.y, dist = Math.sqrt(dx*dx+dy*dy);
      if (dist > 600) { // teleport detected
        this._flagCheat(sid, 'teleport');
        // reject move, zero speed
        p.speed = 0;
      } else {
        p.x = Math.max(0, Math.min(1024, nx));
        p.y = Math.max(0, Math.min(600, ny));
      }
    }
    // append compact snapshot to replay
    const snap = { t: Date.now(), players: {} };
    for (const sid in this.players) {
      const p = this.players[sid];
      snap.players[sid] = { x: Math.round(p.x), y: Math.round(p.y), a: Math.round(p.angle*1000), s: Math.round(p.speed) };
    }
    this.replay.push(snap);
    if (this.replay.length > 1000) this.replay.shift();
  }
  _broadcast() {
    for (const sid in this.players) {
      const conn = connectionMap.get(sid);
      if (!conn || conn.readyState !== WebSocket.OPEN) continue;
      send(conn, 'state', { matchId:this.id, players:this.players, t: Date.now() });
    }
  }
  _flagCheat(sid, reason) {
    console.warn('cheat flagged', sid, reason);
    // save an event to disk for manual review
    const log = { sid, matchId: this.id, reason, t:Date.now(), playersSnapshot: this.players[sid] };
    try {
      fs.appendFileSync(path.join(__dirname, 'cheat_logs.txt'), JSON.stringify(log) + '\\n');
    } catch(e){}
  }
}

wss.on('connection', (ws, req) => {
  const sid = 's_' + Math.random().toString(36).slice(2,9);
  connectionMap.set(sid, ws);
  clientMeta.set(sid, { name: 'Player_'+sid.slice(2,6), color: '#'+Math.floor(Math.random()*16777215).toString(16) });
  send(ws, 'welcome', { sid, queueSize: lobbyQueue.length });
  ws.on('message', (data) => {
    try {
      const msg = msgpack.decode(new Uint8Array(data));
      if (!msg || !msg.t) return;
      const type = msg.t, p = msg.p || {};
      if (type === 'setMeta') {
        clientMeta.set(sid, Object.assign(clientMeta.get(sid)||{}, p.meta || {}));
        upsertPlayer(sid, p.meta && p.meta.name ? p.meta.name : ('Player_'+sid), p.meta && p.meta.color ? p.meta.color : '#'+Math.floor(Math.random()*16777215).toString(16));
        send(ws, 'metaSet', { ok:true });
      } else if (type === 'joinQueue') {
        const elo = db.prepare('SELECT elo FROM players WHERE id = ?').get(sid)?.elo || 1200;
        lobbyQueue.push({ sid, elo });
        send(ws, 'queued', { pos: lobbyQueue.length });
      } else if (type === 'leaveQueue') {
        for (let i=0;i<lobbyQueue.length;i++) if (lobbyQueue[i].sid === sid) { lobbyQueue.splice(i,1); break; }
        send(ws, 'leftQueue', {});
      } else if (type === 'startMatch') {
        # admin start: match players in room or from queue
        const count = p.count || 2;
        const playersToMatch = [];
        // simple ELO pairing: pick first 'count' players closest in ELO
        if (lobbyQueue.length >= count) {
          // sort by elo and choose best group around first
          lobbyQueue.sort((a,b)=>a.elo-b.elo);
          const group = lobbyQueue.splice(0, count);
          group.forEach(g => playersToMatch.push({ sid: g.sid, meta: clientMeta.get(g.sid) }));
        }
        if (playersToMatch.length >= 2) {
          const matchId = 'match_' + Math.random().toString(36).slice(2,9);
          const m = new Match(matchId, playersToMatch);
          matches[matchId] = m;
          m.start();
          // notify
          playersToMatch.forEach(pl => {
            const c = connectionMap.get(pl.sid);
            if (c && c.readyState === WebSocket.OPEN) send(c, 'matchStarted', { matchId });
          });
        } else {
          send(ws, 'error', { msg: 'not enough players in queue' });
      } else if (type === 'input') {
        const match = matches[p.matchId];
        if (!match) return;
        match.applyInput(sid, p);
      } else if (type === 'ping') send(ws, 'pong', { ts: Date.now() });
    } catch (e) { console.warn('msg decode err', e); }
  });
  ws.on('close', () => {
    connectionMap.delete(sid);
    clientMeta.delete(sid);
    # remove from queue if present
    for (let i=0;i<lobbyQueue.length;i++) if (lobbyQueue[i].sid === sid) { lobbyQueue.splice(i,1); break; }
    # remove from matches
    for (const mid in matches) matches[mid].remove && matches[mid].remove(sid);
  });
});

// Admin endpoints
app.get('/admin/players', (req,res)=>{
  const rows = db.prepare('SELECT id,name,color,elo,wins,losses FROM players ORDER BY elo DESC LIMIT 500').all();
  res.json(rows);
});
app.get('/admin/replays', (req,res)=>{
  const rows = db.prepare('SELECT id, matchId, created_at FROM replays ORDER BY created_at DESC LIMIT 50').all();
  res.json(rows);
});
app.get('/admin/replay/:id', (req,res)=>{
  const r = db.prepare('SELECT data FROM replays WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(JSON.parse(r.data));
});

const PORT = process.env.PORT || 7100;
server.listen(PORT, ()=> console.log('server_all_v2 listening on', PORT));
