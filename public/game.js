const socket = io();

let myId = null;
let myName = null;
let myRoomCode = null;
let gameState = null;
let selectedCardId = null;
let selectedTargetId = null;

// ── Utilities ─────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
}

let toastTimer = null;
function showToast(msg, type = 'error') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type === 'success' ? ' success' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function fmt(n) { return new Intl.NumberFormat('id-ID').format(n); }
function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
  return d.innerHTML;
}

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('connect', () => { myId = socket.id; });
socket.on('error', msg => showToast(msg));
socket.on('room_created', ({ code }) => { myRoomCode = code; });

socket.on('state', (s) => {
  gameState = s;
  const phase = s.phase;

  if (phase === 'lobby')          { renderLobby(s);         showScreen('lobby'); }
  else if (phase === 'production') { renderProduction(s);    showScreen('production'); }
  else if (phase === 'demand_reveal') { renderDemandReveal(s); showScreen('demand_reveal'); }
  else if (phase === 'action_cards')  { renderActionCards(s);  showScreen('action_cards'); }
  else if (phase === 'offering')   { renderOffering(s);      showScreen('offering'); }
  else if (phase === 'results')    { renderResults(s);       showScreen('results'); }
  else if (phase === 'gameover')   { renderGameOver(s);      showScreen('gameover'); }
});

// ── Home ──────────────────────────────────────────────────────────────────────
async function loadRoomList() {
  try {
    const res = await fetch('/api/rooms');
    const rooms = await res.json();
    const el = document.getElementById('room-list');
    if (!rooms.length) { el.innerHTML = '<p class="hint">Belum ada room. Buat yang pertama!</p>'; return; }
    el.innerHTML = rooms.map(r => {
      const canJoin = r.phase === 'lobby';
      return `<div class="room-list-item">
        <div>
          <span class="room-list-code">${esc(r.code)}</span>
          <span class="room-list-meta"> · Host: ${esc(r.hostName)} · ${r.playerCount} pemain</span>
        </div>
        <button class="btn-join-quick" data-code="${esc(r.code)}" ${canJoin ? '' : 'disabled'}>
          ${canJoin ? 'Gabung' : 'Sedang Berlangsung'}
        </button>
      </div>`;
    }).join('');
    el.querySelectorAll('.btn-join-quick:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => joinByCode(btn.dataset.code));
    });
  } catch { document.getElementById('room-list').innerHTML = '<p class="hint" style="color:var(--danger)">Gagal memuat room</p>'; }
}

function joinByCode(code) {
  const name = document.getElementById('home-name').value.trim();
  if (!name) { showToast('Masukkan namamu dulu'); return; }
  myName = name;
  myRoomCode = code.toUpperCase();
  socket.emit('join_room', { name, code: myRoomCode });
}

document.getElementById('btn-create-room').addEventListener('click', () => {
  const name = document.getElementById('home-name').value.trim();
  if (!name) { showToast('Masukkan namamu dulu'); return; }
  myName = name;
  socket.emit('create_room', { name });
});
document.getElementById('btn-join-room').addEventListener('click', () => {
  const code = document.getElementById('home-code').value.trim().toUpperCase();
  if (!code) { showToast('Masukkan kode room'); return; }
  joinByCode(code);
});
document.getElementById('home-code').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-join-room').click(); });
document.getElementById('home-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-create-room').click(); });
document.getElementById('btn-refresh-rooms').addEventListener('click', loadRoomList);
document.getElementById('btn-copy-code').addEventListener('click', () => {
  if (myRoomCode) navigator.clipboard.writeText(myRoomCode).then(() => showToast('Kode disalin!', 'success'));
});
loadRoomList();

function leaveRoom() {
  socket.emit('leave_room');
  myRoomCode = null; myName = null;
  document.getElementById('home-name').value = '';
  document.getElementById('home-name').disabled = false;
  document.getElementById('home-code').value = '';
  loadRoomList();
  showScreen('home');
}
document.getElementById('btn-leave').addEventListener('click', leaveRoom);
document.getElementById('btn-go-home').addEventListener('click', leaveRoom);

// ── Lobby ─────────────────────────────────────────────────────────────────────
function renderLobby(s) {
  document.getElementById('lobby-code').textContent = s.code;
  document.getElementById('lobby-host-label').textContent = `Host: ${s.hostName}`;
  const entries = Object.entries(s.players);
  document.getElementById('lobby-players').innerHTML = entries.map(([id, p]) => `
    <div class="player-row">
      <div><div class="pname">${esc(p.name)}${id === myId ? ' <span style="color:var(--accent)">(kamu)</span>' : ''}</div></div>
      ${p.name === s.hostName ? '<span class="badge badge-host">Host</span>' : ''}
    </div>`).join('') || '<p class="hint">Belum ada pemain</p>';

  const me = s.players[myId];
  const isHost = me && me.name === s.hostName;
  const btnStart = document.getElementById('btn-start');
  const hint = document.getElementById('lobby-hint');
  if (isHost) {
    btnStart.classList.toggle('hidden', entries.length < 2);
    hint.textContent = entries.length < 2 ? 'Butuh minimal 1 pemain lain untuk mulai…' : '';
  } else {
    btnStart.classList.add('hidden');
    hint.textContent = 'Menunggu host memulai game…';
  }
}
document.getElementById('btn-start').addEventListener('click', () => socket.emit('start_game'));

// ── Helpers ───────────────────────────────────────────────────────────────────
function renderPlayerList(containerId, players, phase, hostName) {
  const el = document.getElementById(containerId);
  const entries = Object.entries(players);
  if (!entries.length) { el.innerHTML = '<p class="hint">Tidak ada pemain</p>'; return; }
  el.innerHTML = entries.map(([id, p]) => {
    const isMe = id === myId;
    const isHost = p.name === hostName;
    const badges = [];
    if (p.bankrupt) badges.push('<span class="badge badge-bankrupt">Bangkrut</span>');
    else if (phase === 'action_cards') {
      if (p.playedCard) badges.push('<span class="badge badge-ready">Sudah main</span>');
      else badges.push('<span class="badge badge-waiting">Belum main</span>');
      if (p.boikoted) badges.push('<span class="badge badge-boikot">Diboikot</span>');
    } else if (p.boikoted) badges.push('<span class="badge badge-boikot">Diboikot</span>');
    else if (p.ready) badges.push('<span class="badge badge-ready">Siap</span>');
    else badges.push('<span class="badge badge-waiting">Menunggu</span>');
    if (isHost) badges.push('<span class="badge badge-host">Host</span>');

    let meta = `Saldo: ${fmt(p.money)}`;
    if (phase === 'production') meta += ` · Produksi: ${p.produced}`;
    if (phase === 'offering') meta += ` · Produksi: ${p.produced + p.carryover}`;
    if (p.carryover > 0 && phase === 'production') meta += ` (carryover: ${p.carryover})`;

    return `<div class="player-row${p.bankrupt ? ' bankrupt' : ''}">
      <div>
        <div class="pname">${esc(p.name)}${isMe ? ' <span style="color:var(--accent)">(kamu)</span>' : ''}</div>
        <div class="pmeta">${meta}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end">${badges.join('')}</div>
    </div>`;
  }).join('');
}

function renderScoreboard(containerId, players) {
  const el = document.getElementById(containerId);
  const sorted = Object.entries(players).sort(([, a], [, b]) => b.money - a.money);
  el.innerHTML = '<h3 style="margin-bottom:10px;color:var(--muted)">Papan Skor</h3>' +
    sorted.map(([id, p], i) => `<div class="score-row${p.bankrupt ? ' bankrupt-row' : ''}">
      <span class="score-rank">#${i + 1}</span>
      <span class="score-name">${esc(p.name)}${id === myId ? ' <span style="color:var(--accent)">(kamu)</span>' : ''}${p.bankrupt ? ' <span style="color:var(--danger);font-size:.75rem">Bangkrut</span>' : ''}</span>
      <span class="score-money ${p.money >= 0 ? 'positive' : 'negative'}">${fmt(p.money)}</span>
    </div>`).join('');
}

function renderHand(containerId, hand, isKppuContext = false, disabled = false) {
  const el = document.getElementById(containerId);
  if (!hand || !hand.length) { el.innerHTML = '<p class="no-cards-hint">Tidak ada kartu</p>'; return; }
  el.innerHTML = hand.map(card => {
    const isKppu = card.type === 'kppu';
    const sel = card.id === selectedCardId;
    return `<div class="action-card${isKppu ? ' kppu-card' : ''}${sel ? ' selected' : ''}${disabled ? ' card-disabled' : ''}" data-card-id="${card.id}" data-card-type="${card.type}" data-needs-target="${card.needsTarget}">
      <div class="card-label">${esc(card.label)}</div>
      <div class="card-type card-type-${card.type.replace(/_/g,'-')}">${card.needsTarget ? '🎯 Butuh target' : '⚡ Langsung'}</div>
      ${card.desc ? `<div class="card-desc">${esc(card.desc)}</div>` : ''}
    </div>`;
  }).join('');

  if (disabled) return;

  el.querySelectorAll('.action-card').forEach(el => {
    el.addEventListener('click', () => {
      const cardId = parseInt(el.dataset.cardId);
      if (isKppuContext) {
        socket.emit('play_kppu', { cardId });
        return;
      }
      if (selectedCardId === cardId) {
        selectedCardId = null;
        selectedTargetId = null;
      } else {
        selectedCardId = cardId;
        selectedTargetId = null;
      }
      updateActionCardUI();
    });
  });
}

// ── Production ────────────────────────────────────────────────────────────────
let lockedProd = false;

function renderProduction(s) {
  const me = s.players[myId];
  if (!me) return;
  const cost = me.productionCostOverride ?? s.productionCost;
  document.getElementById('prod-round-label').textContent = `Ronde ${s.round + 1} / ${s.rounds.length}`;
  document.getElementById('prod-room-code').textContent = `Room: ${s.code}`;
  document.getElementById('prod-money-display').textContent = `Saldo: ${fmt(me.money)}`;
  document.getElementById('prod-cost-label').textContent = fmt(cost);

  const warnEl = document.getElementById('prod-bankrupt-warn');
  warnEl.classList.toggle('hidden', me.money >= cost || me.bankrupt);

  const carryEl = document.getElementById('prod-carryover-note');
  if (me.carryover > 0) {
    carryEl.classList.remove('hidden');
    carryEl.textContent = `Kamu punya ${me.carryover} unit sisa dari ronde sebelumnya yang akan ikut dijual.`;
    carryEl.className = 'info-box';
  } else {
    carryEl.classList.add('hidden');
  }

  renderPlayerList('prod-players', s.players, 'production', s.hostName);
  renderHand('prod-hand', me.hand);

  lockedProd = me.ready || me.bankrupt;
  document.getElementById('btn-ready-prod').disabled = lockedProd;
  document.getElementById('btn-ready-prod').textContent = me.ready ? 'Terkunci ✓' : 'Kunci Produksi';
  document.getElementById('units-input').disabled = lockedProd;
  document.querySelectorAll('.btn-num').forEach(b => b.disabled = lockedProd);
  if (me.bankrupt) {
    document.getElementById('btn-ready-prod').textContent = 'Bangkrut';
  }
  updateProdPreview(s);
}

function updateProdPreview(s) {
  if (!s) return;
  const me = s.players[myId]; if (!me) return;
  const units = parseInt(document.getElementById('units-input').value) || 0;
  const cost = me.productionCostOverride ?? s.productionCost;
  const total = units * cost;
  const el = document.getElementById('prod-cost-preview');
  if (units === 0) { el.textContent = 'Masukkan jumlah unit untuk melihat total biaya'; return; }
  el.textContent = `${units} unit × ${fmt(cost)} = Total: ${fmt(total)}  (Saldo setelah produksi: ${fmt(me.money - total)})`;
}

document.getElementById('units-input').addEventListener('input', () => {
  if (lockedProd || !gameState) return;
  const units = Math.max(0, parseInt(document.getElementById('units-input').value) || 0);
  socket.emit('set_production', { units });
  updateProdPreview(gameState);
});
document.querySelectorAll('.btn-num').forEach(btn => {
  btn.addEventListener('click', () => {
    if (lockedProd || !gameState) return;
    if (btn.dataset.deltaAdj !== undefined) return; // belongs to adjust section
    const input = document.getElementById('units-input');
    const val = Math.max(0, (parseInt(input.value) || 0) + parseInt(btn.dataset.delta));
    input.value = val;
    socket.emit('set_production', { units: val });
    updateProdPreview(gameState);
  });
});
document.getElementById('btn-ready-prod').addEventListener('click', () => socket.emit('ready_production'));

// ── Demand Reveal ─────────────────────────────────────────────────────────────
function renderDemandReveal(s) {
  const round = s.rounds[s.round];
  const me = s.players[myId];
  const dc = document.getElementById('demand-card-display');
  dc.innerHTML = `<div class="demand-num">${round.demand}</div><div class="demand-sub">unit permintaan pasar</div>`;

  const adjSection = document.getElementById('demand-adjust-section');
  const adjNote = document.getElementById('demand-adjust-note');
  if (me && me.canAdjustAfterDemand) {
    adjSection.classList.remove('hidden');
    document.getElementById('adjust-units-input').value = me.produced;
    adjNote.textContent = 'Kartu "Sesuaikan Produksi" aktif — kamu bisa ubah jumlah produksi sekarang.';
  } else {
    adjSection.classList.add('hidden');
    adjNote.textContent = '';
  }
}

document.getElementById('btn-reveal-done').addEventListener('click', () => socket.emit('reveal_demand'));
document.getElementById('btn-confirm-adjust').addEventListener('click', () => {
  const units = parseInt(document.getElementById('adjust-units-input').value) || 0;
  socket.emit('adjust_production', { units });
  showToast('Produksi disesuaikan', 'success');
});
document.querySelectorAll('.btn-num').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.deltaAdj === undefined) return;
    const input = document.getElementById('adjust-units-input');
    const val = Math.max(0, (parseInt(input.value) || 0) + parseInt(btn.dataset.deltaAdj));
    input.value = val;
  });
});

// ── Action Cards ──────────────────────────────────────────────────────────────
function renderActionCards(s) {
  const me = s.players[myId];
  const round = s.rounds[s.round];
  document.getElementById('ac-round-label').textContent = `Ronde ${s.round + 1} / ${s.rounds.length}`;
  document.getElementById('ac-room-code').textContent = `Room: ${s.code}`;
  document.getElementById('ac-demand-badge').textContent = `Permintaan: ${round.demand} unit`;

  // KPPU banner
  const kppuBanner = document.getElementById('kppu-banner');
  if (s.kppuWindow) {
    kppuBanner.classList.remove('hidden');
    // Find what card was played
    const viol = s.activeViolation;
    const violName = viol ? viol.type.replace(/_/g, ' ') : 'pelanggaran';
    document.getElementById('kppu-banner-text').textContent = ` Ada pemain memainkan kartu ${violName}. Punya KPPU? Klik untuk menangkal!`;
    // Show KPPU cards in hand for interrupt
    const kppuCards = me ? me.hand.filter(c => c.type === 'kppu') : [];
    renderHand('kppu-hand', kppuCards, true);
  } else {
    kppuBanner.classList.add('hidden');
  }

  // Turn indicator
  const turnEl = document.getElementById('ac-turn-indicator');
  const order = s.turnOrder.filter(id => s.players[id] && !s.players[id].bankrupt && !s.players[id].playedCard);
  const currentId = order.length ? order[s.actionTurnIndex % order.length] : null;
  const isMyTurn = currentId === myId;
  const alreadyPlayed = me?.playedCard || false;
  const currentName = currentId ? s.players[currentId]?.name : null;

  turnEl.className = 'turn-indicator' + (isMyTurn ? ' my-turn' : '');
  if (alreadyPlayed) {
    turnEl.textContent = '✅ Kamu sudah memainkan kartu ronde ini — menunggu pemain lain';
  } else if (isMyTurn) {
    turnEl.textContent = '✅ Giliran kamu — mainkan satu kartu atau lewati';
  } else if (currentName) {
    turnEl.textContent = `⏳ Giliran: ${currentName}`;
  } else {
    turnEl.textContent = '⏳ Menunggu pemain lain…';
  }

  // My hand — disable cards if already played or not my turn
  renderHand('ac-hand', me?.hand || [], false, alreadyPlayed || !isMyTurn);

  // Player list
  renderPlayerList('ac-players', s.players, 'action_cards', s.hostName);

  // Active violation display
  const violEl = document.getElementById('ac-violation-display');
  if (s.activeViolation) {
    const v = s.activeViolation;
    const violName = v.type.replace(/_/g, ' ').toUpperCase();
    const violPlayer = s.players[v.playerId]?.name || '?';
    const target = v.targetId ? s.players[v.targetId]?.name : null;
    violEl.innerHTML = `<div class="violation-box">⚠ Aktif: <strong>${violName}</strong> oleh ${esc(violPlayer)}${target ? ` → ${esc(target)}` : ''}${v.maxProd ? ` (maks ${v.maxProd} unit)` : ''}</div>`;
  } else {
    violEl.innerHTML = '';
  }

  document.getElementById('btn-pass-card').disabled = !isMyTurn || alreadyPlayed;
  updateActionCardUI();
}

function updateActionCardUI() {
  if (!gameState) return;
  const s = gameState;
  const me = s.players[myId];
  const order = s.turnOrder.filter(id => s.players[id] && !s.players[id].bankrupt);
  const currentId = order[s.actionTurnIndex % order.length];
  const isMyTurn = currentId === myId;

  // Highlight selected card
  document.querySelectorAll('#ac-hand .action-card').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.cardId) === selectedCardId);
  });

  const playBtn = document.getElementById('btn-play-card');
  const targetPicker = document.getElementById('ac-target-picker');
  const maxProdPicker = document.getElementById('ac-maxprod-picker');

  if (!isMyTurn || selectedCardId === null) {
    playBtn.classList.add('hidden');
    targetPicker.classList.add('hidden');
    maxProdPicker.classList.add('hidden');
    return;
  }

  const card = me?.hand.find(c => c.id === selectedCardId);
  if (!card) { playBtn.classList.add('hidden'); return; }

  playBtn.classList.remove('hidden');

  // Target picker
  if (card.needsTarget) {
    targetPicker.classList.remove('hidden');
    const targetList = document.getElementById('ac-target-list');
    const targets = Object.entries(s.players).filter(([id, p]) => id !== myId && !p.bankrupt);
    targetList.innerHTML = targets.map(([id, p]) => `
      <button class="target-btn${selectedTargetId === id ? ' selected' : ''}" data-target-id="${id}">${esc(p.name)}</button>
    `).join('');
    targetList.querySelectorAll('.target-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedTargetId = btn.dataset.targetId;
        updateActionCardUI();
      });
    });
  } else {
    targetPicker.classList.add('hidden');
    selectedTargetId = null;
  }

  // Max prod picker for pembatasan_produk
  maxProdPicker.classList.toggle('hidden', card.type !== 'pembatasan_produk');

  // Disable play button if target required but not selected
  playBtn.disabled = card.needsTarget && !selectedTargetId;
}

document.getElementById('btn-play-card').addEventListener('click', () => {
  if (selectedCardId === null) return;
  const maxProd = parseInt(document.getElementById('ac-maxprod-input')?.value) || 5;
  socket.emit('play_card', { cardId: selectedCardId, targetId: selectedTargetId, maxProd });
  selectedCardId = null;
  selectedTargetId = null;
});

document.getElementById('btn-pass-card').addEventListener('click', () => {
  selectedCardId = null;
  selectedTargetId = null;
  socket.emit('pass_card');
});

// ── Offering ──────────────────────────────────────────────────────────────────
let lockedOffer = false;

function renderOffering(s) {
  const me = s.players[myId];
  const round = s.rounds[s.round];
  document.getElementById('off-round-label').textContent = `Ronde ${s.round + 1} / ${s.rounds.length}`;
  document.getElementById('off-room-code').textContent = `Room: ${s.code}`;
  document.getElementById('off-demand-badge').textContent = `Permintaan: ${round.demand} unit`;

  const boikotWarn = document.getElementById('off-boikot-warn');
  const priceSection = document.getElementById('off-price-section');
  if (me?.boikoted) {
    boikotWarn.classList.remove('hidden');
    priceSection.classList.add('hidden');
  } else {
    boikotWarn.classList.add('hidden');
    priceSection.classList.remove('hidden');
  }

  if (me) {
    const totalUnits = (me.produced || 0) + (me.carryover || 0);
    document.getElementById('off-produced-summary').innerHTML =
      `Kamu punya <strong>${totalUnits} unit</strong> untuk dijual${me.carryover > 0 ? ` (termasuk ${me.carryover} carryover)` : ''}.`;
  }

  // Show other prices if lihat_harga card was used
  const othersEl = document.getElementById('off-others-prices');
  if (me?.canSeeOtherPrices) {
    const others = Object.entries(s.players)
      .filter(([id, p]) => id !== myId && !p.bankrupt && !p.boikoted && p.offer !== null);
    if (others.length) {
      othersEl.classList.remove('hidden');
      othersEl.innerHTML = 'Penawaran pemain lain: ' + others.map(([, p]) => `${esc(p.name)}: ${fmt(p.offer)}`).join(', ');
    }
  } else {
    othersEl.classList.add('hidden');
  }

  renderPlayerList('off-players', s.players, 'offering', s.hostName);

  lockedOffer = me?.ready || me?.boikoted || me?.bankrupt;
  const btn = document.getElementById('btn-ready-offer');
  const offerInput = document.getElementById('offer-input');
  btn.disabled = lockedOffer;
  btn.textContent = me?.ready ? 'Terkunci ✓' : 'Kunci Penawaran';
  offerInput.disabled = lockedOffer || me?.boikoted;

  updateRevenuePreview(s);
}

function updateRevenuePreview(s) {
  if (!s) return;
  const me = s.players[myId]; if (!me) return;
  const price = parseInt(document.getElementById('offer-input').value) || 0;
  const el = document.getElementById('off-revenue-preview');
  const totalUnits = (me.produced || 0) + (me.carryover || 0);
  if (!price) { el.textContent = 'Masukkan harga penawaran untuk melihat estimasi'; return; }
  const revenue = totalUnits * price;
  const cost = (me.produced || 0) * (me.productionCostOverride ?? s.productionCost);
  const profit = revenue - cost;
  const col = profit >= 0 ? 'var(--success)' : 'var(--danger)';
  el.innerHTML = `Estimasi pendapatan: ${fmt(revenue)} &nbsp;·&nbsp; Biaya: ${fmt(cost)} &nbsp;·&nbsp; Profit: <span style="color:${col};font-weight:700">${fmt(profit)}</span>`;
}

document.getElementById('offer-input').addEventListener('input', () => updateRevenuePreview(gameState));

document.getElementById('btn-ready-offer').addEventListener('click', () => {
  const me = gameState?.players[myId];
  if (me?.boikoted) { socket.emit('ready_offer'); return; }
  const price = parseInt(document.getElementById('offer-input').value) || 0;
  if (price <= 0) { showToast('Masukkan harga penawaran yang valid'); return; }
  socket.emit('set_offer', { pricePerUnit: price });
  socket.emit('ready_offer');
});

// ── Results ───────────────────────────────────────────────────────────────────
function renderResults(s) {
  const round = s.rounds[s.round];
  document.getElementById('results-title').textContent =
    `Hasil Ronde ${s.round + 1} — Permintaan: ${round.demand} unit`;

  const players = Object.entries(s.players).sort(([, a], [, b]) => b.soldUnits - a.soldUnits || (a.offer || 0) - (b.offer || 0));
  const productionCost = s.productionCost;

  document.getElementById('results-table').innerHTML = `<table>
    <thead><tr><th>Pemain</th><th>Penawaran/unit</th><th>Diproduksi</th><th>Terjual</th><th>Profit</th></tr></thead>
    <tbody>${players.map(([id, p]) => {
      const sold = p.soldUnits || 0;
      const produced = p.produced || 0;
      const offer = p.offer || 0;
      const profit = sold * offer - produced * productionCost;
      const isMe = id === myId;
      return `<tr class="${sold > 0 ? 'win-row' : ''}${p.bankrupt ? ' bankrupt' : ''}">
        <td>${esc(p.name)}${isMe ? ' <span style="color:var(--accent)">(kamu)</span>' : ''}${p.bankrupt ? ' <span style="color:var(--danger)">(Bangkrut)</span>' : ''}</td>
        <td>${offer ? fmt(offer) : (p.boikoted ? 'Diboikot' : '-')}</td>
        <td>${produced}</td>
        <td>${sold}</td>
        <td class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}">${fmt(profit)}</td>
      </tr>`;
    }).join('')}</tbody></table>`;

  renderScoreboard('scoreboard', s.players);

  const bankruptNow = Object.values(s.players).filter(p => p.bankrupt);
  const bankruptEl = document.getElementById('bankrupt-list');
  if (bankruptNow.length) {
    bankruptEl.innerHTML = `<div class="warn-box">Pemain bangkrut: ${bankruptNow.map(p => esc(p.name)).join(', ')}</div>`;
  } else {
    bankruptEl.innerHTML = '';
  }

  const isLast = s.round + 1 >= s.rounds.length;
  document.getElementById('btn-next-round').textContent = isLast ? 'Lihat Skor Akhir' : 'Ronde Berikutnya →';
}

document.getElementById('btn-next-round').addEventListener('click', () => socket.emit('next_round'));

// ── Game Over ─────────────────────────────────────────────────────────────────
function renderGameOver(s) {
  renderScoreboard('final-scoreboard', s.players);
}

document.getElementById('btn-restart').addEventListener('click', () => socket.emit('restart'));
