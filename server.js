const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'game.db');
let db;

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function initDb() {
  return initSqlJs().then(SQL => {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH);
      db = new SQL.Database(data);
    } else {
      db = new SQL.Database();
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS rooms (
        code        TEXT    NOT NULL PRIMARY KEY,
        host_name   TEXT    NOT NULL,
        phase       TEXT    NOT NULL DEFAULT 'lobby',
        round       INTEGER NOT NULL DEFAULT 0,
        state_json  TEXT    NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS room_players (
        room_code   TEXT    NOT NULL,
        player_id   TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        money       INTEGER NOT NULL DEFAULT 0,
        joined_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (room_code, player_id)
      );
      CREATE TABLE IF NOT EXISTS round_log (
        id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        room_code   TEXT    NOT NULL,
        round       INTEGER NOT NULL,
        player_id   TEXT    NOT NULL,
        player_name TEXT    NOT NULL,
        produced    INTEGER NOT NULL DEFAULT 0,
        offer       INTEGER NOT NULL DEFAULT 0,
        sold        INTEGER NOT NULL DEFAULT 0,
        profit      INTEGER NOT NULL DEFAULT 0,
        logged_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
    `);
    saveDb();
    console.log('Database ready (sql.js)');
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function persistRoom(room) {
  const stateJson = JSON.stringify(roomToJson(room));
  db.run(
    `INSERT INTO rooms (code, host_name, phase, round, state_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       host_name=excluded.host_name, phase=excluded.phase,
       round=excluded.round, state_json=excluded.state_json`,
    [room.code, room.hostName, room.phase, room.round, stateJson]
  );
  for (const [id, p] of Object.entries(room.players)) {
    db.run(
      `INSERT INTO room_players (room_code, player_id, name, money)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(room_code, player_id) DO UPDATE SET name=excluded.name, money=excluded.money`,
      [room.code, id, p.name, p.money]
    );
  }
  saveDb();
}

function dbRemovePlayer(roomCode, playerId) {
  db.run('DELETE FROM room_players WHERE room_code = ? AND player_id = ?', [roomCode, playerId]);
  saveDb();
}

function dbDeleteRoom(code) {
  db.run('DELETE FROM rooms WHERE code = ?', [code]);
  db.run('DELETE FROM room_players WHERE room_code = ?', [code]);
  saveDb();
}

function dbListRooms() {
  const stmt = db.prepare('SELECT code, host_name, phase FROM rooms ORDER BY created_at DESC LIMIT 50');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbLogRound({ roomCode, round, playerId, playerName, produced, offer, sold, profit }) {
  db.run(
    `INSERT INTO round_log (room_code, round, player_id, player_name, produced, offer, sold, profit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [roomCode, round, playerId, playerName, produced, offer, sold, profit]
  );
  saveDb();
}

// ── Game constants ────────────────────────────────────────────────────────────
const PRODUCTION_COST   = 50000;
const STARTING_MONEY    = 600000;
const FIXED_SELL_PRICE  = 100000;  // used when supply <= demand
const ROUND_COUNT       = 6;
const DEMAND_MIN        = 4;
const DEMAND_MAX        = 18;

// ── Action card deck (32 cards) ───────────────────────────────────────────────
// Each card: { id, type, label, needsTarget }
const CARD_DESCRIPTIONS = {
  kartel:              'Pilih satu pemain. Kamu dan pemain tersebut berdua menjual dengan harga 100.000. Urutan jual: kamu → pemain tersebut → pemain lain.',
  monopoli:            'Semua pemain lain dilarang menjual pada ronde ini. Hanya kamu yang boleh menjual.',
  oligopoli:           'Pilih satu pemain. Hanya kamu dan pemain tersebut yang boleh menjual. Pemain lain dilarang menjual ronde ini.',
  pembatasan_produk:   'Tentukan batas maksimal produksi untuk semua pemain ronde ini. Kelebihan produk hangus. Kartu ini bisa dibatalkan oleh KPPU tanpa denda.',
  trust:               'Pilih satu pemain. Semua produk kalian digabung dan dijual bersama. Revenue dibagi dua — jika ganjil, kamu mendapat lebih banyak.',
  kppu:                'Batalkan kartu pelanggaran (Kartel, Monopoli, Oligopoli, Trust) yang baru dimainkan. Pemain yang melanggar wajib membayar 10% dari total uangnya ke bank. Kamu mendapat 50% dari biaya produksi pelanggar.',
  produksi_40k:        'Ronde ini biaya produksimu turun menjadi 40.000/unit. Selisih 10.000 per unit didapat dari bank.',
  revenue_plus_10k:    'Ronde ini setiap unit yang terjual memberikan pendapatan tambahan 10.000.',
  sesuaikan_produksi:  'Kamu bisa mengubah jumlah produksi setelah permintaan pasar diungkap. Biaya produksi tetap berlaku.',
  lihat_harga:         'Kamu dapat melihat harga penawaran pemain lain sebelum menentukan harga jualmu sendiri.',
  barang_tidak_hangus: 'Barang yang tidak terjual ronde ini tidak hangus — dibawa ke ronde berikutnya tanpa biaya tambahan.',
  ganti_demand:        'Ganti kartu permintaan yang berlaku sekarang dengan angka baru yang diacak ulang.',
  harga_sama_prioritas:'Jika harga penawaranmu sama dengan pemain lain, kamu mendapat prioritas jual lebih dulu.',
  batalkan_produksi:   'Batalkan seluruh produksimu ronde ini. Uang biaya produksi dikembalikan sepenuhnya.',
  boikot:              'Pilih satu pemain. Pemain tersebut tidak boleh menjual pada ronde ini.',
  tidak_ada_aksi:      'Kartu ini tidak memiliki efek apapun.',
};

const CARD_DEFINITIONS = [
  { type: 'kartel',              label: 'Kartel',                        needsTarget: true  },
  { type: 'monopoli',            label: 'Monopoli',                      needsTarget: false },
  { type: 'oligopoli',           label: 'Oligopoli',                     needsTarget: true  },
  { type: 'pembatasan_produk',   label: 'Pembatasan Produk',             needsTarget: false },
  { type: 'trust',               label: 'Trust',                         needsTarget: true  },
  { type: 'kppu',                label: 'KPPU',                          needsTarget: false },
  { type: 'kppu',                label: 'KPPU',                          needsTarget: false },
  { type: 'kppu',                label: 'KPPU',                          needsTarget: false },
  { type: 'produksi_40k',        label: 'Produksi 40.000',               needsTarget: false },
  { type: 'produksi_40k',        label: 'Produksi 40.000',               needsTarget: false },
  { type: 'produksi_40k',        label: 'Produksi 40.000',               needsTarget: false },
  { type: 'revenue_plus_10k',    label: 'Revenue +10.000/produk',        needsTarget: false },
  { type: 'revenue_plus_10k',    label: 'Revenue +10.000/produk',        needsTarget: false },
  { type: 'sesuaikan_produksi',  label: 'Sesuaikan Produksi',            needsTarget: false },
  { type: 'sesuaikan_produksi',  label: 'Sesuaikan Produksi',            needsTarget: false },
  { type: 'lihat_harga',         label: 'Lihat Harga Pemain Lain',       needsTarget: false },
  { type: 'barang_tidak_hangus', label: 'Barang Tidak Hangus',           needsTarget: false },
  { type: 'barang_tidak_hangus', label: 'Barang Tidak Hangus',           needsTarget: false },
  { type: 'ganti_demand',        label: 'Ganti Kartu Demand',            needsTarget: false },
  { type: 'harga_sama_prioritas',label: 'Harga Sama = Prioritas',        needsTarget: false },
  { type: 'batalkan_produksi',   label: 'Batalkan Produksi',             needsTarget: false },
  { type: 'batalkan_produksi',   label: 'Batalkan Produksi',             needsTarget: false },
  { type: 'boikot',              label: 'Boikot',                        needsTarget: true  },
  { type: 'boikot',              label: 'Boikot',                        needsTarget: true  },
  { type: 'tidak_ada_aksi',      label: 'Tidak Ada Aksi',                needsTarget: false },
  { type: 'kartel',              label: 'Kartel',                        needsTarget: true  },
  { type: 'monopoli',            label: 'Monopoli',                      needsTarget: false },
  { type: 'oligopoli',           label: 'Oligopoli',                     needsTarget: true  },
  { type: 'trust',               label: 'Trust',                         needsTarget: true  },
  { type: 'produksi_40k',        label: 'Produksi 40.000',               needsTarget: false },
  { type: 'revenue_plus_10k',    label: 'Revenue +10.000/produk',        needsTarget: false },
  { type: 'boikot',              label: 'Boikot',                        needsTarget: true  },
];

function makeDeck() {
  return CARD_DEFINITIONS.map((def, i) => ({ ...def, id: i, desc: CARD_DESCRIPTIONS[def.type] || '' }));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealCards(playerIds, deck) {
  // Each player gets 2 cards to start; rest goes back to deck pool
  const hands = Object.fromEntries(playerIds.map(id => [id, []]));
  const shuffled = shuffle(deck);
  let idx = 0;
  for (let card = 0; card < 2; card++) {
    for (const id of playerIds) {
      if (idx < shuffled.length) hands[id].push(shuffled[idx++]);
    }
  }
  return { hands, remaining: shuffled.slice(idx) };
}

// ── Room helpers ──────────────────────────────────────────────────────────────
function generateRounds() {
  return Array.from({ length: ROUND_COUNT }, (_, i) => ({
    demand: Math.floor(Math.random() * (DEMAND_MAX - DEMAND_MIN + 1)) + DEMAND_MIN,
    label: `Ronde ${i + 1}`,
  }));
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function roomToJson(room) {
  return {
    rounds: room.rounds,
    deck: room.deck,
    turnOrder: room.turnOrder,
    actionTurnIndex: room.actionTurnIndex,
    activeViolation: room.activeViolation,
    players: Object.fromEntries(
      Object.entries(room.players).map(([id, p]) => [id, {
        name: p.name, money: p.money,
        produced: p.produced, carryover: p.carryover,
        offer: p.offer, soldUnits: p.soldUnits, ready: p.ready,
        hand: p.hand, bankrupt: p.bankrupt,
        productionCostOverride: p.productionCostOverride,
        revenueBonusPerUnit: p.revenueBonusPerUnit,
        canAdjustAfterDemand: p.canAdjustAfterDemand,
        canSeeOtherPrices: p.canSeeOtherPrices,
        unsoldProtected: p.unsoldProtected,
        tiePriority: p.tiePriority,
        boikoted: p.boikoted,
        maxProduction: p.maxProduction,
      }])
    ),
  };
}

// Phases: lobby | production | demand_reveal | action_cards | kppu_window |
//         offering | results | gameover
const rooms = {};
const socketRoom = {};

function broadcastRoom(room) {
  const snap = buildSnap(room);
  io.to(room.code).emit('state', snap);
}

function buildSnap(room) {
  const revealOffers = room.phase === 'results' || room.phase === 'gameover';
  return {
    code: room.code,
    hostName: room.hostName,
    phase: room.phase,
    round: room.round,
    rounds: room.rounds,
    productionCost: PRODUCTION_COST,
    startingMoney: STARTING_MONEY,
    activeViolation: room.activeViolation,   // { type, playerId, targetId, maxProd } | null
    kppuWindow: room.kppuWindow || false,
    actionTurnIndex: room.actionTurnIndex,
    turnOrder: room.turnOrder,
    players: Object.fromEntries(
      Object.entries(room.players).map(([id, p]) => [id, {
        name: p.name,
        money: p.money,
        produced: p.produced,
        carryover: p.carryover,
        offer: revealOffers ? p.offer : null,
        soldUnits: p.soldUnits,
        ready: p.ready,
        handCount: p.hand.length,
        hand: p.hand,          // client filters to own hand
        bankrupt: p.bankrupt,
        boikoted: p.boikoted,
        maxProduction: p.maxProduction,
        canSeeOtherPrices: p.canSeeOtherPrices,
        canAdjustAfterDemand: p.canAdjustAfterDemand,
        tiePriority: p.tiePriority,
        unsoldProtected: p.unsoldProtected,
        revenueBonusPerUnit: p.revenueBonusPerUnit,
        productionCostOverride: p.productionCostOverride,
        playedCard: p.playedCard,
      }])
    ),
  };
}

function activePlayers(room) {
  return Object.entries(room.players).filter(([, p]) => !p.bankrupt);
}

function allReady(room) {
  const active = activePlayers(room);
  return active.length > 0 && active.every(([, p]) => p.ready);
}

function resetRoundPerPlayer(p) {
  // carryover stays if unsoldProtected was active last round
  p.produced = 0;
  p.offer = null;
  p.soldUnits = 0;
  p.ready = false;
  // reset per-round card effects
  p.productionCostOverride = null;
  p.revenueBonusPerUnit = 0;
  p.canAdjustAfterDemand = false;
  p.canSeeOtherPrices = false;
  p.unsoldProtected = false;
  p.tiePriority = false;
  p.boikoted = false;
  p.maxProduction = null;
  p.playedCard = false;
}

function resetRoundData(room) {
  for (const p of Object.values(room.players)) resetRoundPerPlayer(p);
  room.activeViolation = null;
  room.kppuWindow = false;
  room.actionTurnIndex = 0;
}

function checkBankruptcy(room) {
  for (const [, p] of Object.entries(room.players)) {
    if (!p.bankrupt && p.money < PRODUCTION_COST) {
      p.bankrupt = true;
    }
  }
}

// ── Selling logic ─────────────────────────────────────────────────────────────
function resolveSelling(room) {
  const demand = room.rounds[room.round].demand;
  const sellers = activePlayers(room).filter(([, p]) => !p.boikoted && (p.produced + p.carryover) > 0);
  const totalSupply = sellers.reduce((s, [, p]) => s + p.produced + p.carryover, 0);

  if (totalSupply <= demand) {
    // All goods sell at fixed price 100,000
    for (const [id, p] of sellers) {
      const units = p.produced + p.carryover;
      const cost = p.produced * (p.productionCostOverride ?? PRODUCTION_COST);
      const revenue = units * (FIXED_SELL_PRICE + p.revenueBonusPerUnit);
      const profit = revenue - cost;
      room.players[id].soldUnits = units;
      room.players[id].money += profit;
      room.players[id].carryover = 0;
      dbLogRound({ roomCode: room.code, round: room.round, playerId: id,
        playerName: p.name, produced: p.produced, offer: FIXED_SELL_PRICE, sold: units, profit });
    }
    // boikoted players still pay production cost
    for (const [id, p] of activePlayers(room).filter(([, p]) => p.boikoted && p.produced > 0)) {
      const cost = p.produced * (p.productionCostOverride ?? PRODUCTION_COST);
      room.players[id].money -= cost;
      if (p.unsoldProtected) {
        room.players[id].carryover += p.produced;
      } else {
        room.players[id].carryover = 0;
      }
    }
  } else {
    // Price auction: sort by offer asc, tie-break rules
    const sorted = sellers.sort(([idA, a], [idB, b]) => {
      if (a.offer !== b.offer) return a.offer - b.offer;
      if (a.tiePriority !== b.tiePriority) return a.tiePriority ? -1 : 1;
      const unitsA = a.produced + a.carryover;
      const unitsB = b.produced + b.carryover;
      if (unitsA !== unitsB) return unitsB - unitsA; // more units = priority
      if (a.money !== b.money) return b.money - a.money; // more money = priority
      return 0;
    });

    let remaining = demand;
    for (const [id, p] of sorted) {
      const units = p.produced + p.carryover;
      const sold = Math.min(units, remaining);
      const revenue = sold * (p.offer + p.revenueBonusPerUnit);
      const cost = p.produced * (p.productionCostOverride ?? PRODUCTION_COST);
      const profit = revenue - cost;
      room.players[id].soldUnits = sold;
      room.players[id].money += profit;
      remaining -= sold;
      const unsold = units - sold;
      room.players[id].carryover = p.unsoldProtected ? unsold : 0;
      dbLogRound({ roomCode: room.code, round: room.round, playerId: id,
        playerName: p.name, produced: p.produced, offer: p.offer, sold, profit });
    }

    // Players who didn't sell: pay production cost, handle unsold
    for (const [id, p] of activePlayers(room)) {
      if (p.soldUnits === 0 && (p.produced > 0 || p.carryover > 0)) {
        if (!p.boikoted) {
          const cost = p.produced * (p.productionCostOverride ?? PRODUCTION_COST);
          room.players[id].money -= cost;
        } else {
          const cost = p.produced * (p.productionCostOverride ?? PRODUCTION_COST);
          room.players[id].money -= cost;
        }
        room.players[id].carryover = p.unsoldProtected ? (p.produced + p.carryover) : 0;
      }
    }
  }

  // Kartel effect: sort order enforced (already handled by offer price = 100k fixed from card logic)

  checkBankruptcy(room);
}

// ── Action card effects ───────────────────────────────────────────────────────
function applyActionCard(room, playerId, card, targetId, maxProd) {
  const p = room.players[playerId];
  const VIOLATION_TYPES = ['kartel', 'monopoli', 'oligopoli', 'trust'];
  const isViolation = VIOLATION_TYPES.includes(card.type);

  if (isViolation) {
    // Cancel any weaker active violation
    room.activeViolation = null;
  }

  switch (card.type) {
    case 'kartel': {
      // Both player and target sell at 100k, player sells first
      room.activeViolation = { type: 'kartel', playerId, targetId };
      // Force both to offer at fixed price; selling order handled in resolveSelling
      room.players[playerId].offer = FIXED_SELL_PRICE;
      if (targetId && room.players[targetId]) room.players[targetId].offer = FIXED_SELL_PRICE;
      break;
    }
    case 'monopoli': {
      // All other active players banned from selling
      room.activeViolation = { type: 'monopoli', playerId };
      for (const [id, ] of activePlayers(room)) {
        if (id !== playerId) room.players[id].boikoted = true;
      }
      break;
    }
    case 'oligopoli': {
      // Player + target can sell; everyone else banned
      room.activeViolation = { type: 'oligopoli', playerId, targetId };
      for (const [id, ] of activePlayers(room)) {
        if (id !== playerId && id !== targetId) room.players[id].boikoted = true;
      }
      break;
    }
    case 'pembatasan_produk': {
      room.activeViolation = { type: 'pembatasan_produk', playerId, maxProd: maxProd || 5 };
      for (const [id, ] of activePlayers(room)) {
        room.players[id].maxProduction = maxProd || 5;
        // Excess already produced is wasted (clamp produced)
        if (room.players[id].produced > (maxProd || 5)) {
          room.players[id].produced = maxProd || 5;
        }
      }
      break;
    }
    case 'trust': {
      // Merge products of player + target; revenue split 50/50 (odd: playerId gets more)
      if (!targetId || !room.players[targetId]) break;
      room.activeViolation = { type: 'trust', playerId, targetId };
      // Handled at sell time: mark for trust resolution
      room.players[playerId].trustPartner = targetId;
      room.players[targetId].trustPartner = playerId;
      break;
    }
    case 'kppu': {
      // Cancels active violation; violating player pays 10% of money to bank
      if (room.activeViolation) {
        const violatorId = room.activeViolation.playerId;
        const fine = Math.floor(room.players[violatorId].money * 0.10);
        room.players[violatorId].money -= fine;
        // Undo violation effects
        undoViolation(room, room.activeViolation);
        room.activeViolation = null;
        // KPPU player receives 50% of violator's production cost from bank
        const productionCost = room.players[violatorId].produced * PRODUCTION_COST;
        room.players[playerId].money += Math.floor(productionCost * 0.5);
      }
      break;
    }
    case 'produksi_40k': {
      p.productionCostOverride = 40000;
      // Refund difference already paid conceptually (handled at cost calc time)
      break;
    }
    case 'revenue_plus_10k': {
      p.revenueBonusPerUnit += 10000;
      break;
    }
    case 'sesuaikan_produksi': {
      p.canAdjustAfterDemand = true;
      break;
    }
    case 'lihat_harga': {
      p.canSeeOtherPrices = true;
      break;
    }
    case 'barang_tidak_hangus': {
      p.unsoldProtected = true;
      break;
    }
    case 'ganti_demand': {
      // Replace current demand with next from a re-rolled value
      if (room.round < room.rounds.length) {
        room.rounds[room.round].demand =
          Math.floor(Math.random() * (DEMAND_MAX - DEMAND_MIN + 1)) + DEMAND_MIN;
      }
      break;
    }
    case 'harga_sama_prioritas': {
      p.tiePriority = true;
      break;
    }
    case 'batalkan_produksi': {
      // Cancel production this round: refund cost
      const refund = p.produced * (p.productionCostOverride ?? PRODUCTION_COST);
      p.money += refund;
      // Also refund the override subsidy if any
      if (p.productionCostOverride !== null) {
        const subsidyAlreadyGained = p.produced * (PRODUCTION_COST - p.productionCostOverride);
        p.money -= subsidyAlreadyGained;
      }
      p.produced = 0;
      p.productionCostOverride = null;
      break;
    }
    case 'boikot': {
      if (targetId && room.players[targetId]) {
        room.players[targetId].boikoted = true;
      }
      break;
    }
    case 'tidak_ada_aksi': {
      // No effect
      break;
    }
  }

  // Remove card from hand
  p.hand = p.hand.filter(c => c.id !== card.id);
}

function undoViolation(room, violation) {
  switch (violation.type) {
    case 'monopoli':
    case 'oligopoli':
      for (const [id, ] of activePlayers(room)) room.players[id].boikoted = false;
      break;
    case 'pembatasan_produk':
      for (const [id, ] of activePlayers(room)) room.players[id].maxProduction = null;
      break;
    case 'kartel':
      room.players[violation.playerId].offer = null;
      if (violation.targetId && room.players[violation.targetId])
        room.players[violation.targetId].offer = null;
      break;
    case 'trust':
      if (room.players[violation.playerId]) delete room.players[violation.playerId].trustPartner;
      if (violation.targetId && room.players[violation.targetId])
        delete room.players[violation.targetId].trustPartner;
      break;
  }
}

function activeActionOrder(room) {
  const active = activePlayers(room).map(([id]) => id);
  return room.turnOrder.filter(id => active.includes(id));
}

function allPlayedOrPassed(room) {
  return activePlayers(room).every(([, p]) => p.playedCard);
}

function advanceActionTurn(room) {
  const order = activeActionOrder(room);
  if (!order.length) return;
  room.actionTurnIndex = (room.actionTurnIndex + 1) % order.length;
  // Skip players who already played a card this round
  let tries = 0;
  while (tries < order.length && room.players[order[room.actionTurnIndex]]?.playedCard) {
    room.actionTurnIndex = (room.actionTurnIndex + 1) % order.length;
    tries++;
  }
}

function currentActionPlayerId(room) {
  const order = activeActionOrder(room);
  if (!order.length) return null;
  return order[room.actionTurnIndex % order.length];
}

// ── REST ──────────────────────────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  try {
    const rows = dbListRooms();
    res.json(rows.map(r => ({
      code: r.code,
      hostName: r.host_name,
      phase: r.phase,
      playerCount: rooms[r.code] ? Object.keys(rooms[r.code].players).length : 0,
    })));
  } catch { res.status(500).json({ error: 'DB error' }); }
});

// ── Socket handlers ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Create room ──
  socket.on('create_room', ({ name }) => {
    name = (name || '').trim().slice(0, 20) || 'Host';
    const code = makeRoomCode();
    const room = {
      code, hostName: name,
      phase: 'lobby', round: 0,
      rounds: [], deck: [], turnOrder: [], actionTurnIndex: 0,
      activeViolation: null, kppuWindow: false,
      players: { [socket.id]: makePlayer(name) },
    };
    rooms[code] = room;
    socketRoom[socket.id] = { roomCode: code, name };
    socket.join(code);
    persistRoom(room);
    socket.emit('room_created', { code });
    broadcastRoom(room);
  });

  // ── Join room ──
  socket.on('join_room', ({ name, code }) => {
    code = (code || '').trim().toUpperCase();
    name = (name || '').trim().slice(0, 20) || 'Player';
    const room = rooms[code];
    if (!room) { socket.emit('error', `Room "${code}" not found`); return; }
    if (room.phase !== 'lobby') { socket.emit('error', 'Game already started in that room'); return; }
    if (Object.keys(room.players).length >= 8) { socket.emit('error', 'Room is full (max 8)'); return; }

    room.players[socket.id] = makePlayer(name);
    socketRoom[socket.id] = { roomCode: code, name };
    socket.join(code);
    persistRoom(room);
    broadcastRoom(room);
  });

  // ── Start game ──
  socket.on('start_game', () => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || room.phase !== 'lobby') return;
    if (Object.keys(room.players).length < 2) { socket.emit('error', 'Need at least 2 players'); return; }

    room.rounds = generateRounds();
    room.deck = makeDeck();
    const playerIds = Object.keys(room.players);
    room.turnOrder = [...playerIds];

    const { hands } = dealCards(playerIds, room.deck);
    for (const id of playerIds) {
      room.players[id].money = STARTING_MONEY;
      room.players[id].hand = hands[id];
    }

    room.round = 0;
    room.phase = 'production';
    resetRoundData(room);
    persistRoom(room);
    broadcastRoom(room);
  });

  // ── Production ──
  socket.on('set_production', ({ units }) => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || room.phase !== 'production') return;
    const p = room.players[socket.id];
    if (!p || p.bankrupt) return;
    let n = Math.max(0, Math.floor(Number(units) || 0));
    if (p.maxProduction !== null) n = Math.min(n, p.maxProduction);
    p.produced = n;
    broadcastRoom(room);
  });

  socket.on('ready_production', () => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || room.phase !== 'production') return;
    const p = room.players[socket.id];
    if (!p || p.bankrupt) return;

    const cost = p.produced * (p.productionCostOverride ?? PRODUCTION_COST);
    p.money -= cost;
    p.ready = true;
    broadcastRoom(room);

    if (allReady(room)) {
      checkBankruptcy(room);
      room.phase = 'demand_reveal';
      for (const [, pl] of activePlayers(room)) pl.ready = false;
      persistRoom(room);
      broadcastRoom(room);
    }
  });

  // ── Demand reveal ──
  socket.on('reveal_demand', () => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || room.phase !== 'demand_reveal') return;

    room.phase = 'action_cards';
    room.actionTurnIndex = room.round % room.turnOrder.length;
    persistRoom(room);
    broadcastRoom(room);
  });

  // ── Action cards: play a card ──
  socket.on('play_card', ({ cardId, targetId, maxProd }) => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || room.phase !== 'action_cards') return;
    if (currentActionPlayerId(room) !== socket.id) { socket.emit('error', 'Not your turn'); return; }
    const p = room.players[socket.id];
    if (!p) return;
    const card = p.hand.find(c => c.id === cardId);
    if (!card) { socket.emit('error', 'Card not in your hand'); return; }

    const VIOLATION_TYPES = ['monopoli', 'oligopoli', 'kartel', 'trust'];
    if (VIOLATION_TYPES.includes(card.type)) {
      room.kppuWindow = true;
      room.pendingCard = { playerId: socket.id, card, targetId, maxProd };
      persistRoom(room);
      broadcastRoom(room);
      setTimeout(() => {
        if (room.pendingCard && room.pendingCard.card.id === cardId) {
          const pendingPlayerId = room.pendingCard.playerId;
          applyPendingCard(room);
          room.players[pendingPlayerId].playedCard = true;
          room.kppuWindow = false;
          room.pendingCard = null;
          if (allPlayedOrPassed(room)) { moveToOffering(room); return; }
          advanceActionTurn(room);
          persistRoom(room);
          broadcastRoom(room);
        }
      }, 10000);
    } else {
      applyActionCard(room, socket.id, card, targetId, maxProd);
      p.playedCard = true;
      if (allPlayedOrPassed(room)) { moveToOffering(room); return; }
      advanceActionTurn(room);
      persistRoom(room);
      broadcastRoom(room);
    }
  });

  // ── Action cards: pass ──
  socket.on('pass_card', () => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || room.phase !== 'action_cards') return;
    if (currentActionPlayerId(room) !== socket.id) { socket.emit('error', 'Not your turn'); return; }

    room.players[socket.id].playedCard = true;
    if (allPlayedOrPassed(room)) { moveToOffering(room); return; }
    advanceActionTurn(room);
    broadcastRoom(room);
  });

  // ── KPPU interrupt ──
  socket.on('play_kppu', ({ cardId }) => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || !room.kppuWindow || !room.pendingCard) return;
    const p = room.players[socket.id];
    if (!p) return;
    const kppuCard = p.hand.find(c => c.id === cardId && c.type === 'kppu');
    if (!kppuCard) { socket.emit('error', 'No KPPU card'); return; }

    const { playerId, card, targetId, maxProd } = room.pendingCard;
    applyActionCard(room, playerId, card, targetId, maxProd);
    room.players[playerId].playedCard = true;
    applyActionCard(room, socket.id, kppuCard, null, null);
    room.players[socket.id].playedCard = true;

    room.kppuWindow = false;
    room.pendingCard = null;
    if (allPlayedOrPassed(room)) { moveToOffering(room); return; }
    advanceActionTurn(room);
    persistRoom(room);
    broadcastRoom(room);
  });

  // ── Adjust production after demand ──
  socket.on('adjust_production', ({ units }) => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || (room.phase !== 'action_cards' && room.phase !== 'demand_reveal')) return;
    const p = room.players[socket.id];
    if (!p || !p.canAdjustAfterDemand || p.bankrupt) return;
    let n = Math.max(0, Math.floor(Number(units) || 0));
    if (p.maxProduction !== null) n = Math.min(n, p.maxProduction);
    const diff = n - p.produced;
    const costPerUnit = p.productionCostOverride ?? PRODUCTION_COST;
    if (diff > 0) p.money -= diff * costPerUnit;
    else if (diff < 0) p.money += Math.abs(diff) * costPerUnit;
    p.produced = n;
    broadcastRoom(room);
  });

  // ── Offering ──
  socket.on('set_offer', ({ pricePerUnit }) => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || room.phase !== 'offering') return;
    const p = room.players[socket.id];
    if (!p || p.bankrupt || p.boikoted) return;
    if (p.offer === FIXED_SELL_PRICE && room.activeViolation?.type === 'kartel') return;
    p.offer = Math.max(0, Math.floor(Number(pricePerUnit) || 0));
    broadcastRoom(room);
  });

  socket.on('ready_offer', () => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || room.phase !== 'offering') return;
    const p = room.players[socket.id];
    if (!p || p.bankrupt) return;
    if (!p.boikoted && p.offer === null && (p.produced + p.carryover) > 0) {
      socket.emit('error', 'Set your offer price first'); return;
    }
    p.ready = true;
    broadcastRoom(room);

    const activeNonBankrupt = activePlayers(room);
    if (activeNonBankrupt.every(([, pl]) => pl.ready || pl.boikoted)) {
      resolveSelling(room);
      resolveTrust(room);
      room.phase = 'results';
      for (const [, pl] of activeNonBankrupt) pl.ready = false;
      checkBankruptcy(room);
      const stillPlaying = activePlayers(room);
      if (stillPlaying.length <= 1 || room.round + 1 >= ROUND_COUNT) {
        room.phase = 'gameover';
      }
      persistRoom(room);
      broadcastRoom(room);
    }
  });

  // ── Next round ──
  socket.on('next_round', () => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room || room.phase !== 'results') return;
    room.round += 1;
    if (room.round >= ROUND_COUNT || activePlayers(room).length <= 1) {
      room.phase = 'gameover';
    } else {
      room.phase = 'production';
      resetRoundData(room);
      for (const [id, ] of activePlayers(room)) {
        if (room.deck.length > 0) room.players[id].hand.push(room.deck.pop());
      }
    }
    persistRoom(room);
    broadcastRoom(room);
  });

  // ── Restart ──
  socket.on('restart', () => {
    const sr = socketRoom[socket.id]; if (!sr) return;
    const room = rooms[sr.roomCode];
    if (!room) return;
    room.phase = 'lobby';
    room.round = 0;
    room.rounds = [];
    room.deck = [];
    room.turnOrder = [];
    room.actionTurnIndex = 0;
    room.activeViolation = null;
    room.kppuWindow = false;
    for (const p of Object.values(room.players)) {
      p.money = 0;
      p.hand = [];
      p.bankrupt = false;
      p.carryover = 0;
      resetRoundPerPlayer(p);
    }
    persistRoom(room);
    broadcastRoom(room);
  });

  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

function makePlayer(name) {
  return {
    name, money: 0,
    produced: 0, carryover: 0,
    offer: null, soldUnits: 0, ready: false,
    hand: [], bankrupt: false,
    productionCostOverride: null,
    revenueBonusPerUnit: 0,
    canAdjustAfterDemand: false,
    canSeeOtherPrices: false,
    unsoldProtected: false,
    tiePriority: false,
    boikoted: false,
    maxProduction: null,
    playedCard: false,
  };
}

function applyPendingCard(room) {
  if (!room.pendingCard) return;
  const { playerId, card, targetId, maxProd } = room.pendingCard;
  applyActionCard(room, playerId, card, targetId, maxProd);
}

function resolveTrust(room) {
  const processed = new Set();
  for (const [id, p] of Object.entries(room.players)) {
    if (!p.trustPartner || processed.has(id)) continue;
    const partnerId = p.trustPartner;
    const partner = room.players[partnerId];
    if (!partner) continue;
    processed.add(id);
    processed.add(partnerId);
    const totalRevenue = p.soldUnits * (p.offer || FIXED_SELL_PRICE) +
                         partner.soldUnits * (partner.offer || FIXED_SELL_PRICE);
    const half = Math.floor(totalRevenue / 2);
    const remainder = totalRevenue % 2;
    room.players[id].money -= p.soldUnits * (p.offer || FIXED_SELL_PRICE);
    room.players[partnerId].money -= partner.soldUnits * (partner.offer || FIXED_SELL_PRICE);
    room.players[id].money += half + remainder;
    room.players[partnerId].money += half;
    delete room.players[id].trustPartner;
    delete room.players[partnerId].trustPartner;
  }
}

function moveToOffering(room) {
  room.phase = 'offering';
  for (const [, p] of activePlayers(room)) p.ready = false;
  persistRoom(room);
  broadcastRoom(room);
}

function handleLeave(socket) {
  const sr = socketRoom[socket.id]; if (!sr) return;
  const room = rooms[sr.roomCode];
  delete socketRoom[socket.id];
  if (!room) return;
  dbRemovePlayer(room.code, socket.id);
  delete room.players[socket.id];
  if (Object.keys(room.players).length === 0) {
    dbDeleteRoom(room.code);
    delete rooms[room.code];
    return;
  }
  if (room.hostName === sr.name) {
    room.hostName = Object.values(room.players)[0].name;
  }
  persistRoom(room);
  broadcastRoom(room);
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDb()
  .then(() => server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`)))
  .catch(err => { console.error('Failed to init DB:', err); process.exit(1); });
