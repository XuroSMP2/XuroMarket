/* XuroMarket – lädt /api/market und zeigt AH, Orders, Preise, Vermögen, Trades und RTP.
   Alle Texte werden per textContent eingefügt (kein innerHTML), damit Spielernamen/Item-Namen nie Code ausführen können. */
const $ = (s, r = document) => r.querySelector(s);
const nfI = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nfD = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
const num = (n) => (n == null ? '–' : nfI.format(n));
const money = (n) => (n == null ? '–' : '$' + (Math.abs(n) < 100 && n % 1 ? nfD.format(n) : nfI.format(n)));
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e[k] = v;
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
};
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } } };

const TABS = [['overview', 'Übersicht'], ['ah', 'Auktionshaus'], ['orders', 'Orders'], ['prices', 'Preise'], ['wealth', 'Vermögen'], ['trades', 'Handel'], ['rtp', 'RTP-Tracker'], ['account', 'Mein Konto']];
const TYPE = { AH: 'Auktionshaus', ORDER: 'Order', SHOP_BUY: 'Shop-Kauf', SHOP_SELL: 'Shop-Verkauf' };
const DIM = { overworld: 'Oberwelt', nether: 'Nether', end: 'End' };

let D = null;           // letzter Snapshot
let tab = 'overview';
const ui = {};          // UI-Zustand je Tab (Suche, Sortierung ...)
const st = (k, d) => (ui[k] ??= d);

/* ---------- Hilfen ---------- */
const tot = (p) => (p.money || 0) + (p.bank || 0);
const lc = (s) => String(s || '').toLowerCase();
const ago = (t) => { const m = Math.max(0, Math.floor((Date.now() - t) / 60000)); return m < 1 ? 'gerade eben' : m < 60 ? `vor ${m} Min` : m < 1440 ? `vor ${Math.floor(m / 60)} Std` : `vor ${Math.floor(m / 1440)} T`; };
const left = (t) => { const m = Math.floor((t - Date.now()) / 60000); return m <= 0 ? 'abgelaufen' : m < 60 ? `${m} Min` : m < 1440 ? `${Math.floor(m / 60)} Std` : `${Math.floor(m / 1440)} T ${Math.floor(m % 1440 / 60)} Std`; };
const day = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.';

let priceMap = new Map();
const ref = (item) => { const p = priceMap.get(item); return p ? (p.avg7d ?? p.avg ?? p.shopBuy ?? null) : null; };
function deal(unit, item) {
  const r = ref(item);
  if (!r || !unit) return { pct: null, tag: h('span', { class: 'tag neu' }, '–') };
  const pct = Math.round((unit / r - 1) * 100);
  const cls = pct <= -15 ? 'good' : pct >= 15 ? 'bad' : 'neu';
  return { pct, tag: h('span', { class: 'tag ' + cls, title: 'Vergleich mit dem Ø-Preis (' + money(r) + ' pro Stück)' }, (pct > 0 ? '+' : '') + pct + ' %') };
}
const itemCell = (r) => h('td', {}, r.name, r.meta ? h('small', {}, r.meta) : null);
function spark(hist) {
  const pts = hist.map((v, i) => [i, v]).filter((p) => p[1] != null);
  if (pts.length < 2) return h('span', { class: 'mu' }, '–');
  const min = Math.min(...pts.map((p) => p[1])), max = Math.max(...pts.map((p) => p[1])), span = max - min || 1;
  const poly = pts.map(([i, v]) => `${(i / (hist.length - 1) * 80 + 2).toFixed(1)},${(20 - (v - min) / span * 18).toFixed(1)}`).join(' ');
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'spark'); s.setAttribute('viewBox', '0 0 84 22');
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', poly); s.append(pl);
  return s;
}
function table(cols, rows, { limit = 200, onRow, empty = 'Keine Einträge.' } = {}) {
  if (!rows.length) return h('div', { class: 'tw' }, h('div', { class: 'empty' }, empty));
  const shown = rows.slice(0, limit);
  const t = h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.r ? 'r' : '' }, c.t)))),
    h('tbody', {}, shown.map((r, i) => {
      const tr = h('tr', { class: onRow ? 'click' : '' }, cols.map((c) => { const v = c.f(r, i); return v instanceof HTMLElement && v.tagName === 'TD' ? v : h('td', { class: c.r ? 'r' : '' }, v); }));
      if (onRow) tr.onclick = () => onRow(r);
      return tr;
    })));
  return h('div', {}, h('div', { class: 'tw' }, t), rows.length > limit ? h('p', { class: 'mu' }, `Es werden ${limit} von ${num(rows.length)} Einträgen angezeigt. Nutze die Suche.`) : null);
}
const stat = (label, value) => h('div', { class: 'card' }, h('span', {}, label), h('b', {}, value));
const search = (key, ph, redraw) => h('input', { type: 'search', placeholder: ph, value: st(key, ''), autocomplete: 'off', oninput: (e) => { ui[key] = e.target.value; redraw(); } });
const select = (key, opts, redraw) => { const s = h('select', { onchange: (e) => { ui[key] = e.target.value; redraw(); } }, opts.map(([v, t]) => h('option', { value: v }, t))); s.value = st(key, opts[0][0]); return s; };
function bars(items, valueKey, labelKey, fmt) {
  const max = Math.max(1, ...items.map((i) => i[valueKey]));
  return h('div', {}, h('div', { class: 'bar' }, items.map((i) => h('div', { style: `height:${Math.max(2, i[valueKey] / max * 100)}%`, title: `${i[labelKey]}: ${fmt(i[valueKey])}` }))),
    h('div', { class: 'lbl' }, items.map((i, n) => h('span', {}, n % 2 === 0 ? day(i[labelKey]) : ''))));
}
/* Mini-Redraw: Tabelle neu zeichnen, ohne das Suchfeld zu verlieren */
function live(build) { const box = h('div'); const draw = () => box.replaceChildren(build()); draw(); return [box, draw]; }

/* ---------- Tabs ---------- */
function viewOverview() {
  const m = D.market, t = m.totals;
  const deals = m.ah.map((r) => ({ r, d: deal(r.unit, r.item), }))
    .filter((x) => x.d.pct != null && x.d.pct <= -15 && !x.r.meta).sort((a, b) => a.d.pct - b.d.pct).slice(0, 8);
  const wanted = [...m.orders].sort((a, b) => b.total - a.total).slice(0, 8);
  return h('div', {},
    h('h2', {}, 'Marktübersicht'),
    h('div', { class: 'grid' },
      stat('AH-Angebote', num(t.ahListings)), stat('Wert im AH', money(t.ahValue)),
      stat('Offene Orders', num(t.openOrders)), stat('Wert der Orders', money(t.orderValue)),
      stat('Trades (24 Std)', num(t.trades24h)), stat('Umsatz (24 Std)', money(t.volume24h)),
      stat('Geld im Umlauf', money(t.circulation)), stat('Spieler online', D.status.online != null ? `${D.status.online}/${D.status.max}` : '–')),
    h('h3', {}, 'Umsatz der letzten 14 Tage'), bars(m.volume, 'volume', 'day', money),
    h('div', { class: 'two' },
      h('div', {}, h('h3', {}, '🔥 Schnäppchen im Auktionshaus'),
        table([{ t: 'Item', f: (x) => itemCell(x.r) }, { t: 'Stück', r: 1, f: (x) => money(x.r.unit) }, { t: 'Vs. Ø', f: (x) => x.d.tag }, { t: 'Menge', r: 1, f: (x) => num(x.r.amount) }],
          deals, { empty: 'Gerade keine deutlich günstigen Angebote.' })),
      h('div', {}, h('h3', {}, '📥 Gesuchte Items (Orders)'),
        table([{ t: 'Item', f: (o) => o.name }, { t: 'Menge', r: 1, f: (o) => num(o.remaining) }, { t: 'Preis/Stück', r: 1, f: (o) => money(o.price) }, { t: 'Gesamt', r: 1, f: (o) => money(o.total) }],
          wanted, { empty: 'Keine offenen Orders.' }))),
    h('h3', {}, 'Letzte Trades'), tradesTable(m.trades.slice(0, 10)));
}

function viewAH() {
  const m = D.market;
  const [box, draw] = live(() => {
    const q = lc(st('ahq', '')), sort = st('ahs', 'new');
    let rows = m.ah.map((r) => ({ ...r, d: deal(r.unit, r.item) })).filter((r) => !q || lc(r.name + ' ' + r.item + ' ' + r.meta + ' ' + r.seller).includes(q));
    if (st('ahd', false)) rows = rows.filter((r) => r.d.pct != null && r.d.pct <= -15);
    const S = { new: (a, b) => b.created - a.created, cheap: (a, b) => a.price - b.price, rich: (a, b) => b.price - a.price, unit: (a, b) => a.unit - b.unit, exp: (a, b) => a.expires - b.expires, deal: (a, b) => (a.d.pct ?? 999) - (b.d.pct ?? 999) };
    rows.sort(S[sort]);
    return h('div', {}, h('p', { class: 'mu' }, `${num(rows.length)} Angebote`),
      table([{ t: 'Item', f: itemCell }, { t: 'Menge', r: 1, f: (r) => num(r.amount) }, { t: 'Preis', r: 1, f: (r) => money(r.price) }, { t: 'Pro Stück', r: 1, f: (r) => money(r.unit) },
        { t: 'Vs. Ø', f: (r) => r.d.tag }, { t: 'Verkäufer', f: (r) => r.seller }, { t: 'Läuft ab', f: (r) => left(r.expires) }], rows));
  });
  return h('div', {}, h('h2', {}, 'Auktionshaus'),
    h('div', { class: 'tools' }, search('ahq', 'Item, Verzauberung oder Verkäufer …', draw),
      select('ahs', [['new', 'Neueste'], ['cheap', 'Günstigste'], ['rich', 'Teuerste'], ['unit', 'Stückpreis'], ['deal', 'Bester Deal'], ['exp', 'Läuft bald ab']], draw),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: st('ahd', false) ? '' : null, onchange: (e) => { ui.ahd = e.target.checked; draw(); } }), 'Nur Schnäppchen')),
    box, h('p', { class: 'mu' }, '„Vs. Ø“ vergleicht den Stückpreis mit dem Durchschnittspreis der letzten 7 Tage (oder dem Shop-Preis). Item mit Verzauberung/Namen werden nicht verglichen.'));
}

function viewOrders() {
  const m = D.market;
  const [box, draw] = live(() => {
    const q = lc(st('orq', '')), sort = st('ors', 'price');
    const rows = m.orders.map((o) => ({ ...o, shop: priceMap.get(o.item)?.shopSell ?? null })).filter((o) => !q || lc(o.name + ' ' + o.item + ' ' + o.owner).includes(q));
    const S = { price: (a, b) => b.price - a.price, total: (a, b) => b.total - a.total, new: (a, b) => b.created - a.created, exp: (a, b) => a.expires - b.expires };
    rows.sort(S[sort]);
    return h('div', {}, h('p', { class: 'mu' }, `${num(rows.length)} offene Orders`),
      table([{ t: 'Item', f: (o) => o.name }, { t: 'Gesucht', r: 1, f: (o) => `${num(o.remaining)} / ${num(o.amount)}` }, { t: 'Preis/Stück', r: 1, f: (o) => money(o.price) },
        { t: 'Gesamt', r: 1, f: (o) => money(o.total) },
        { t: 'Shop zahlt', r: 1, f: (o) => o.shop == null ? '–' : h('span', { class: o.price > o.shop ? 'pos' : 'mu' }, money(o.shop)) },
        { t: 'Besteller', f: (o) => o.owner }, { t: 'Läuft ab', f: (o) => left(o.expires) }], rows));
  });
  return h('div', {}, h('h2', {}, 'Orders'),
    h('p', { class: 'mu' }, 'Spieler suchen diese Items und zahlen sofort. Grün bei „Shop zahlt“ = die Order zahlt mehr als der Shop, Liefern lohnt sich.'),
    h('div', { class: 'tools' }, search('orq', 'Item oder Besteller …', draw), select('ors', [['price', 'Höchster Preis'], ['total', 'Höchster Gesamtwert'], ['new', 'Neueste'], ['exp', 'Läuft bald ab']], draw)), box);
}

function viewPrices() {
  const m = D.market;
  const [box, draw] = live(() => {
    const q = lc(st('prq', '')), sort = st('prs', 'trades');
    const rows = m.prices.filter((p) => (!q || lc(p.name + ' ' + p.item).includes(q)) && (!st('prt', false) || p.trades > 0));
    const num0 = (f) => (a, b) => (b[f] ?? -1) - (a[f] ?? -1);
    const S = { trades: num0('trades'), avg: num0('avg'), avg7d: num0('avg7d'), name: (a, b) => a.name.localeCompare(b.name, 'de'), shop: num0('shopBuy'), ah: (a, b) => (a.ahMin ?? 1e18) - (b.ahMin ?? 1e18) };
    rows.sort(S[sort]);
    return h('div', {}, h('p', { class: 'mu' }, `${num(rows.length)} Items`),
      table([{ t: 'Item', f: (p) => p.name }, { t: 'Ø Preis', r: 1, f: (p) => money(p.avg) }, { t: 'Ø 7 Tage', r: 1, f: (p) => money(p.avg7d) }, { t: 'Trend (14 T)', f: (p) => spark(p.history) },
        { t: 'Trades', r: 1, f: (p) => num(p.trades) }, { t: 'Günstigstes AH', r: 1, f: (p) => money(p.ahMin) }, { t: 'Beste Order', r: 1, f: (p) => money(p.orderMax) },
        { t: 'Shop kauft', r: 1, f: (p) => money(p.shopBuy) }, { t: 'Shop zahlt', r: 1, f: (p) => money(p.shopSell) }], rows, { limit: 300 }));
  });
  return h('div', {}, h('h2', {}, 'Preise pro Item'),
    h('p', { class: 'mu' }, 'Alle Preise gelten pro Stück. „Ø Preis“ ist der Durchschnitt aller Spieler-Trades (Auktionshaus und Orders) gewichtet nach Menge. „Shop kauft“ = was du im Shop zahlst, „Shop zahlt“ = was du beim Verkauf bekommst.'),
    h('div', { class: 'tools' }, search('prq', 'Item suchen …', draw),
      select('prs', [['trades', 'Meiste Trades'], ['avg', 'Höchster Ø Preis'], ['avg7d', 'Höchster Ø 7 Tage'], ['shop', 'Höchster Shop-Preis'], ['ah', 'Günstigstes AH'], ['name', 'Name A–Z']], draw),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: st('prt', false) ? '' : null, onchange: (e) => { ui.prt = e.target.checked; draw(); } }), 'Nur Items mit Trades')), box);
}

function playerCard(p, rank) {
  const sum = D.market.totals.circulation || 1;
  const mine = D.market.trades.filter((t) => t.buyer === p.name || t.seller === p.name).slice(0, 15);
  return h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h2', {}, p.name),
    h('p', { class: 'mu' }, `Rang: ${p.rank}${p.clan ? ' · Clan: ' + p.clan : ''}${rank ? ' · Platz ' + rank + ' beim Vermögen' : ''}`),
    h('div', { class: 'grid' }, stat('Gesamtvermögen', money(tot(p))), stat('Bargeld', money(p.money)), stat('Bank', money(p.bank || 0)), stat('Anteil am Gesamtgeld', nfD.format(tot(p) / sum * 100) + ' %'), stat('Stars', num(p.crystals)), stat('Gems', num(p.gems)),
      stat('Gekauft', `${num(p.boughtItems)} Items`), stat('Dafür bezahlt', money(p.boughtMoney)), stat('Verkauft', `${num(p.soldItems)} Items`), stat('Dafür erhalten', money(p.soldMoney))),
    mine.length ? h('div', {}, h('h3', {}, 'Letzte Trades'), tradesTable(mine)) : h('p', { class: 'mu' }, 'Keine aktuellen Trades im Verlauf.'));
}
function viewWealth() {
  const m = D.market, sum = m.totals.circulation || 1;
  const [box, draw] = live(() => {
    const q = lc(st('wq', '')), by = st('wby', 'total');
    const val = (p) => (by === 'total' ? tot(p) : p[by] || 0);
    const sorted = [...m.wealth].sort((a, b) => val(b) - val(a));
    const pos = new Map(sorted.map((p, i) => [p.name, i + 1]));
    const rows = sorted.filter((p) => !q || lc(p.name).includes(q));
    const exact = q && rows.find((p) => lc(p.name) === q);
    return h('div', {}, exact ? playerCard(exact, pos.get(exact.name)) : null,
      table([{ t: '#', f: (p) => pos.get(p.name) }, { t: 'Spieler', f: (p) => p.name }, { t: 'Rang', f: (p) => p.rank }, { t: 'Gesamt', r: 1, f: (p) => money(tot(p)) }, { t: 'Bargeld', r: 1, f: (p) => money(p.money) }, { t: 'Bank', r: 1, f: (p) => money(p.bank || 0) }, { t: 'Anteil', r: 1, f: (p) => nfD.format(tot(p) / sum * 100) + ' %' },
        { t: 'Stars', r: 1, f: (p) => num(p.crystals) }, { t: 'Gems', r: 1, f: (p) => num(p.gems) },
        { t: 'Gekauft', r: 1, f: (p) => money(p.boughtMoney) }, { t: 'Verkauft', r: 1, f: (p) => money(p.soldMoney) }], rows,
      { limit: 100, onRow: (p) => { ui.wq = p.name; document.querySelector('#app input[type=search]').value = p.name; draw(); scrollTo({ top: 0, behavior: 'smooth' }); } }));
  });
  return h('div', {}, h('h2', {}, 'Vermögen & Handel'),
    h('p', { class: 'mu' }, 'Geld im Umlauf (Bargeld + Bank): ' + money(m.totals.circulation) + ' bei ' + num(m.totals.players) + ' Spielern. „Gekauft/Verkauft“ zählt Shop, Auktionshaus und Orders seit Beginn der Aufzeichnung.'),
    h('div', { class: 'tools' }, search('wq', 'Spielername (genau eingeben für Details) …', draw), select('wby', [['total', 'Nach Gesamtvermögen'], ['money', 'Nach Bargeld'], ['bank', 'Nach Bankguthaben'], ['crystals', 'Nach Stars'], ['gems', 'Nach Gems'], ['boughtMoney', 'Nach Käufen'], ['soldMoney', 'Nach Verkäufen']], draw)), box);
}

function tradesTable(rows) {
  return table([{ t: 'Zeit', f: (t) => ago(t.time) }, { t: 'Art', f: (t) => h('span', { class: 'tag t-' + t.type }, TYPE[t.type] || t.type) }, { t: 'Item', f: (t) => t.name },
    { t: 'Menge', r: 1, f: (t) => num(t.amount) }, { t: 'Preis', r: 1, f: (t) => money(t.total) }, { t: 'Pro Stück', r: 1, f: (t) => money(t.total / Math.max(1, t.amount)) },
    { t: 'Käufer', f: (t) => t.buyer }, { t: 'Verkäufer', f: (t) => t.seller }], rows, { empty: 'Noch keine Trades aufgezeichnet.' });
}
function viewTrades() {
  const m = D.market;
  const [box, draw] = live(() => {
    const q = lc(st('trq', '')), ty = st('trt', '');
    return tradesTable(m.trades.filter((t) => (!ty || t.type === ty) && (!q || lc(t.name + ' ' + t.buyer + ' ' + t.seller).includes(q))));
  });
  return h('div', {}, h('h2', {}, 'Handelsverlauf'), h('p', { class: 'mu' }, 'Die letzten 200 Trades auf dem Server.'),
    h('div', { class: 'tools' }, search('trq', 'Item oder Spieler …', draw), select('trt', [['', 'Alle Arten'], ...Object.entries(TYPE)], draw)), box);
}

function viewRTP() {
  const r = D.market.rtp, dims = r.dims || {};
  const totalDims = Object.values(dims).reduce((a, b) => a + b, 0) || 1;
  const days = r.days.map((d) => ({ ...d, total: d.overworld + d.nether + d.end }));
  const col = { overworld: 'var(--ac)', nether: 'var(--e1)', end: 'var(--cr)' };
  return h('div', {},
    h('h2', {}, 'RTP-Tracker'),
    h('p', { class: 'mu' }, 'So oft wurde der Random-Teleport genutzt. Orte/Koordinaten werden aus Fairness-Gründen nicht veröffentlicht.'),
    h('div', { class: 'grid' }, stat('RTPs insgesamt', num(r.total)), stat('Heute', num(days[days.length - 1]?.total)), stat('Letzte 7 Tage', num(days.slice(-7).reduce((a, d) => a + d.total, 0))),
      ...['overworld', 'nether', 'end'].map((k) => stat(DIM[k], num(dims[k] || 0)))),
    h('div', { class: 'meter' }, ['overworld', 'nether', 'end'].map((k) => h('i', { style: `width:${(dims[k] || 0) / totalDims * 100}%;background:${col[k]}`, title: DIM[k] }))),
    h('h3', {}, 'Nutzung pro Tag (14 Tage)'), bars(days, 'total', 'day', num),
    h('div', { class: 'two' },
      h('div', {}, h('h3', {}, 'Häufigste Nutzer'), table([{ t: '#', f: (p, i) => i + 1 }, { t: 'Spieler', f: (p) => p.name }, { t: 'RTPs', r: 1, f: (p) => num(p.count) }], r.top, { empty: 'Noch keine RTPs.' })),
      h('div', {}, h('h3', {}, 'Letzte RTPs'), table([{ t: 'Zeit', f: (p) => ago(p.time) }, { t: 'Spieler', f: (p) => p.name }, { t: 'Ziel', f: (p) => DIM[p.dim] || p.dim }], r.recent.slice(0, 15), { empty: 'Noch keine RTPs.' }))));
}

/* ---------- Mein Konto: Anmeldung per /verify und privates Inventar ---------- */
let accTimer = null;
const stopAcc = () => { clearInterval(accTimer); accTimer = null; };
const api = async (path, opts = {}) => { const r = await fetch(path, { credentials: 'same-origin', ...opts }); let j = {}; try { j = await r.json(); } catch { /* leer */ } return [r.status, j]; };
const hue = (s) => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
const abbr = (item) => item.split('_').map((w) => w[0]).join('').slice(0, 3);
const icon = (item) => { const u = window.XM_ICON_URL; return u ? u.replace('{id}', item.toLowerCase()) : ''; };

function slotEl(it, sel, onPick) {
  if (!it) return h('div', { class: 'slot empty' });
  const url = icon(it.item);
  const b = h('button', { class: 'slot' + (it.enchants ? ' ench' : ''), type: 'button', title: it.custom || it.name, style: url ? '' : `background:hsl(${hue(it.item)} 45% 32%)`, onclick: () => onPick(it, b) },
    url ? h('img', { src: url, alt: '', loading: 'lazy', onerror: (e) => { e.target.replaceWith(document.createTextNode(abbr(it.item))); } }) : abbr(it.item),
    it.amount > 1 ? h('b', {}, it.amount) : null,
    it.durability != null ? h('i', { style: `width:${it.durability}%;background:${it.durability < 25 ? 'var(--e1)' : 'var(--ac)'}` }) : null);
  return b;
}
function grid(cls, size, items, slots, pick) {
  const bySlot = new Map(items.map((i) => [i.slot, i]));
  return h('div', { class: 'inv ' + cls }, slots.map((s) => slotEl(bySlot.get(s), false, pick)));
}
function accountView(inv, me) {
  const box = h('div', {});
  const detail = h('div', { class: 'card detail' }, h('span', { class: 'mu' }, 'Tippe ein Item an, um Details zu sehen.'));
  let selected = null;
  const pick = (it, el) => {
    selected?.classList.remove('sel'); selected = el; el.classList.add('sel');
    detail.replaceChildren(...[h('h3', {}, it.custom ? `${it.custom} (${it.name})` : it.name), h('span', { class: 'mu' }, `${it.item.toLowerCase()} · ×${num(it.amount)}${it.durability != null ? ' · Haltbarkeit ' + it.durability + ' %' : ''}`),
      it.enchants ? h('ul', {}, it.enchants.map((e) => h('li', {}, e))) : null, it.lore ? h('ul', {}, it.lore.map((l) => h('li', { class: 'mu' }, l))) : null].filter(Boolean));
  };
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
  const st = inv.stats || {};
  box.append(
    h('div', { class: 'who' }, h('img', { src: `https://mc-heads.net/avatar/${me.uuid}/64`, alt: '', onerror: (e) => e.target.remove() }),
      h('div', {}, h('h2', {}, inv.name || me.name), h('span', { class: 'mu' }, `Stand: ${ago(inv.updated)} · der Server aktualisiert alle paar Minuten, mit „Neu laden“ holst du den neuesten Stand`)),
      h('button', { class: 'alt', onclick: () => { stopAcc(); render(); } }, 'Neu laden'),
      h('button', { class: 'alt', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); stopAcc(); render(); } }, 'Abmelden')),
    h('div', { class: 'grid' }, stat('Bargeld', money(st.money)), stat('Bank', money(st.bank)), stat('Stars', num(st.crystals)), stat('Gems', num(st.gems)), stat('Level', num(st.level))),
    h('h3', {}, 'Inventar'),
    h('div', { class: 'invwrap' },
      h('div', { class: 'cols' },
        h('div', {}, h('p', { class: 'mu', style: 'margin:0 0 4px' }, 'Rüstung'), grid('side', 1, inv.inventory, [39, 38, 37, 36], pick)),
        h('div', {}, h('p', { class: 'mu', style: 'margin:0 0 4px' }, 'Zweithand'), grid('side', 1, inv.inventory, [40], pick))),
      h('div', { style: 'flex:1 1 380px;max-width:560px' }, grid('', 9, inv.inventory, range(9, 36), pick), h('div', { style: 'height:8px' }), grid('', 9, inv.inventory, range(0, 9), pick))),
    h('h3', {}, `Endertruhe (${inv.enderRows} Reihen)`),
    h('div', { style: 'max-width:560px' }, grid('', 9, inv.enderchest, range(0, inv.enderRows * 9), pick)),
    h('h3', {}, 'Details'), detail,
    h('p', { class: 'mu' }, 'Nur du siehst diese Daten. Beenden kannst du die Verknüpfung jederzeit im Spiel mit /verify logout.'));
  return box;
}
function loginView(done) {
  const box = h('div', { class: 'login card' });
  const start = h('button', {}, 'Mit Minecraft anmelden');
  const info = h('div', {});
  let left = 0;
  const wait = () => {
    stopAcc();
    accTimer = setInterval(async () => {
      left--;
      const cd = $('#cd'); if (cd) cd.textContent = Math.max(0, left) + 's';
      if (left % 3 !== 0 && left > 0) return;
      const [, j] = await api('/api/auth/status');
      if (j.state === 'ok') { stopAcc(); done(); }
      else if (j.state === 'expired' || j.state === 'none' || left <= 0) { stopAcc(); info.replaceChildren(h('p', { class: 'mu' }, 'Der Code ist abgelaufen.'), start); start.hidden = false; }
    }, 1000);
  };
  start.onclick = async () => {
    start.disabled = true;
    const [s, j] = await api('/api/auth/start', { method: 'POST' });
    start.disabled = false;
    if (s !== 200) { info.replaceChildren(h('p', { class: 'mu' }, j.error || 'Fehler. Bitte später erneut versuchen.'), start); return; }
    left = j.expiresIn;
    start.hidden = true;
    info.replaceChildren(h('p', {}, 'Tippe im Spiel (auf dem Server) diesen Befehl ein:'), h('div', { class: 'code' }, j.code),
      h('p', {}, h('b', {}, '/verify ' + j.code)), h('p', { class: 'mu' }, 'Diese Seite meldet dich automatisch an. Der Code gilt noch ', h('span', { id: 'cd' }, left + 's'), '.'),
      h('div', { class: 'note' }, 'Gib nur einen Code ein, den du ', h('b', {}, 'selbst hier'), ' siehst, und teile ihn nie. Wer dich bittet, einen fremden Code einzugeben, will an dein Inventar.'));
    wait();
  };
  box.append(h('h2', {}, 'Mein Konto'), h('p', {}, 'Verknüpfe deinen Minecraft-Account und sieh dein Inventar und deine Endertruhe direkt hier.'), info, start,
    h('p', { class: 'mu' }, 'Du kannst die Verknüpfung jederzeit im Spiel mit /verify logout beenden. Dann werden alle Sitzungen beendet und deine Daten hier gelöscht.'));
  return box;
}
function viewAccount() {
  const root = h('div', {}, h('p', { class: 'mu' }, 'Lade …'));
  (async () => {
    const [s, me] = await api('/api/me');
    if (s !== 200) { root.replaceChildren(loginView(() => render())); return; }
    const [s2, inv] = await api('/api/me/inventory');
    if (s2 === 404) { root.replaceChildren(h('div', { class: 'card' }, h('h2', {}, me.name), h('p', {}, 'Noch keine Inventardaten empfangen. Das dauert nach der Verknüpfung bis zu 2 Minuten. Du musst dafür online sein.'),
      h('button', { onclick: () => render() }, 'Neu laden'), ' ', h('button', { class: 'alt', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); render(); } }, 'Abmelden'))); return; }
    if (s2 !== 200) { root.replaceChildren(h('p', { class: 'mu' }, 'Daten konnten nicht geladen werden.')); return; }
    root.replaceChildren(accountView(inv, me));
  })();
  return root;
}

const VIEWS = { account: viewAccount, overview: viewOverview, ah: viewAH, orders: viewOrders, prices: viewPrices, wealth: viewWealth, trades: viewTrades, rtp: viewRTP };

/* ---------- Laden & Anzeigen ---------- */
function render() {
  const nav = $('#tabs');
  nav.replaceChildren(...TABS.map(([id, t]) => h('a', { href: '#' + id, class: id === tab ? 'on' : '' }, t)));
  const app = $('#app');
  if (tab === 'account') { app.replaceChildren(VIEWS.account()); return; } // Konto braucht keine Marktdaten
  if (!D || D.empty) { app.replaceChildren(h('p', { class: 'mu' }, D ? 'Noch keine Daten vom Server empfangen. Sobald das Plugin die ersten Daten sendet, erscheinen sie hier.' : 'Lade …')); return; }
  try { app.replaceChildren(VIEWS[tab]()); } catch (e) { console.error(e); app.replaceChildren(h('p', { class: 'mu' }, 'Anzeige-Fehler. Bitte Seite neu laden.')); }
}
function setTab() { stopAcc(); const t = location.hash.slice(1); tab = VIEWS[t] ? t : 'overview'; render(); }

async function load() {
  try {
    const r = await fetch('/api/market');
    D = await r.json();
    if (D && !D.empty) {
      priceMap = new Map(D.market.prices.map((p) => [p.item, p]));
      $('#upd').textContent = new Date(D.receivedAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
      $('#live').className = 'pill ' + (D.stale ? 'off' : 'on');
      $('#live').textContent = D.stale ? 'Server offline?' : (D.status.online != null ? D.status.online + ' online' : 'live');
      $('#warn').hidden = !D.stale;
      $('#warn').textContent = 'Die Daten sind älter als 15 Minuten. Der Server ist eventuell offline.';
    } else { $('#live').textContent = 'keine Daten'; }
  } catch { if (!D) D = { empty: true }; $('#live').className = 'pill off'; $('#live').textContent = 'Fehler'; }
  if (tab !== 'account') render(); // Konto-Ansicht nicht neu zeichnen (Code/Anmeldung läuft)
}
addEventListener('hashchange', setTab);
const hadFocus = () => document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
tab = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
render();
load();
setInterval(() => { if (!hadFocus()) load(); }, 60000); // nicht neu zeichnen, solange jemand tippt
