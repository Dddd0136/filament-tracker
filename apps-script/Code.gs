/**
 * Учёт филамента для Neptune 4.
 * Таблица: листы «Катушки» и «Печати». Веб-приложение:
 *   - без параметра data — мобильная страница (нужен ключ ?k=ТОКЕН);
 *   - с параметрами token и data — приём отчёта о печати от принтера.
 */

const SPOOLS = 'Катушки';
const PRINTS = 'Печати';
const SPOOL_HEAD = ['id', 'name', 'material', 'color', 'brand', 'initial_g', 'used_g', 'active', 'archived', 'created'];
const PRINT_HEAD = ['time', 'file', 'status', 'mm', 'grams', 'spool_id', 'report_id'];

// Плотность, г/см³
const DENSITY = { 'PLA': 1.24, 'PLA+': 1.24, 'PETG': 1.27, 'ABS': 1.04, 'ASA': 1.07, 'TPU': 1.21, 'PC': 1.20, 'NYLON': 1.14 };
const AREA_MM2 = Math.PI * 0.875 * 0.875; // сечение прутка 1.75 мм
const LOW_G = 100;                       // порог «мало осталось»

/** Запустить один раз вручную: создаёт листы и секретный ключ. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SHEET_ID', ss.getId());
  ensureSheet_(ss, SPOOLS, SPOOL_HEAD);
  ensureSheet_(ss, PRINTS, PRINT_HEAD);
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  }
  Logger.log('ТОКЕН: ' + props.getProperty('TOKEN'));
}

function ensureSheet_(ss, name, head) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight('bold');
  }
  return sh;
}

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function token_() {
  return PropertiesService.getScriptProperties().getProperty('TOKEN') || '';
}

function check_(key) {
  if (!key || key !== token_()) throw new Error('Неверный ключ доступа');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- web entry

// Функции, доступные приложению (GitHub Pages) через ?action=call
const API_FNS = { getState: getState, addSpool: addSpool, setActive: setActive, setRemaining: setRemaining, archiveSpool: archiveSpool };

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'call') {
    try {
      const fn = API_FNS[p.fn];
      if (!fn) throw new Error('Неизвестная функция');
      const args = p.args ? JSON.parse(p.args) : [];
      return json_({ ok: true, result: fn.apply(null, [p.k].concat(args)) });
    } catch (err) {
      return json_({ ok: false, error: String(err.message || err) });
    }
  }
  if (p.data) {
    try {
      return json_(logPrint_(p.token, p.data));
    } catch (err) {
      return json_({ ok: false, error: String(err.message || err) });
    }
  }
  const t = HtmlService.createTemplateFromFile('Index');
  t.key = p.k || '';
  return t.evaluate()
    .setTitle('Филамент')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------- data helpers

function readSpools_() {
  const sh = ss_().getSheetByName(SPOOLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, SPOOL_HEAD.length).getValues().map((r, i) => ({
    row: i + 2,
    id: String(r[0]),
    name: String(r[1]),
    material: String(r[2]).toUpperCase(),
    color: String(r[3] || '#7fb3d5'),
    brand: String(r[4] || ''),
    initial_g: Number(r[5]) || 0,
    used_g: Number(r[6]) || 0,
    active: r[7] === true || String(r[7]).toUpperCase() === 'TRUE',
    archived: r[8] === true || String(r[8]).toUpperCase() === 'TRUE',
    created: r[9] ? new Date(r[9]).getTime() : 0
  }));
}

function density_(material) {
  return DENSITY[String(material).toUpperCase()] || 1.24;
}

function grams_(mm, material) {
  return mm * AREA_MM2 / 1000 * density_(material);
}

// ---------------------------------------------------------------- printer report

function logPrint_(token, dataStr) {
  if (!token || token !== token_()) throw new Error('bad token');
  const d = JSON.parse(dataStr);
  const mm = Number(d.mm) || 0;
  const status = String(d.status || 'done');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = ss_();
    const pr = ss.getSheetByName(PRINTS);
    // повторная отправка из очереди принтера — не считать дважды
    if (d.id && pr.getLastRow() > 1) {
      const ids = pr.getRange(2, 7, pr.getLastRow() - 1, 1).getValues().flat().map(String);
      if (ids.indexOf(String(d.id)) >= 0) return { ok: true, dup: true };
    }
    const spools = readSpools_();
    const sp = spools.find(s => s.active && !s.archived);
    const time = d.ts ? new Date(Number(d.ts) * 1000) : new Date();
    if (status === 'test' || !sp) {
      const g = sp ? grams_(mm, sp.material) : grams_(mm, 'PLA');
      pr.appendRow([time, d.file || '', status === 'test' ? 'test' : status + ' (нет активной катушки)', mm, round1_(g), '', d.id || '']);
      return { ok: true, counted: false, reason: sp ? 'test' : 'no active spool' };
    }
    const g = grams_(mm, sp.material);
    ss.getSheetByName(SPOOLS).getRange(sp.row, 7).setValue(round1_(sp.used_g + g));
    pr.appendRow([time, d.file || '', status, mm, round1_(g), sp.id, d.id || '']);
    return { ok: true, counted: true, spool: sp.name, grams: round1_(g), remaining: round1_(sp.initial_g - sp.used_g - g) };
  } finally {
    lock.releaseLock();
  }
}

function round1_(x) { return Math.round(x * 10) / 10; }

// ---------------------------------------------------------------- page API (google.script.run)

function getState(key) {
  check_(key);
  const spools = readSpools_().map(s => ({
    id: s.id, name: s.name, material: s.material, color: s.color, brand: s.brand,
    initial_g: s.initial_g, used_g: round1_(s.used_g),
    remaining_g: round1_(Math.max(0, s.initial_g - s.used_g)),
    pct: s.initial_g > 0 ? Math.max(0, Math.min(100, (s.initial_g - s.used_g) / s.initial_g * 100)) : 0,
    low: s.initial_g - s.used_g < LOW_G,
    active: s.active, archived: s.archived, created: s.created
  }));
  const pr = ss_().getSheetByName(PRINTS);
  const n = pr.getLastRow() - 1;
  let prints = [];
  if (n > 0) {
    const from = Math.max(2, pr.getLastRow() - 49);
    prints = pr.getRange(from, 1, pr.getLastRow() - from + 1, PRINT_HEAD.length).getValues()
      .map(r => ({ time: new Date(r[0]).getTime(), file: String(r[1]), status: String(r[2]), mm: Number(r[3]), grams: Number(r[4]), spool_id: String(r[5]) }))
      .reverse();
  }
  return { spools: spools, prints: prints, materials: Object.keys(DENSITY), low: LOW_G };
}

function addSpool(key, s) {
  check_(key);
  const name = String(s.name || '').trim();
  if (!name) throw new Error('Укажите название');
  const initial = Number(s.initial_g);
  if (!(initial > 0)) throw new Error('Укажите вес пластика, г');
  const sh = ss_().getSheetByName(SPOOLS);
  const id = 'S' + Date.now().toString(36).toUpperCase();
  const first = readSpools_().filter(x => !x.archived).length === 0;
  sh.appendRow([id, name, String(s.material || 'PLA').toUpperCase(), s.color || '#7fb3d5', s.brand || '', initial, 0, first, false, new Date()]);
  return getState(key);
}

function setActive(key, id) {
  check_(key);
  const sh = ss_().getSheetByName(SPOOLS);
  readSpools_().forEach(s => sh.getRange(s.row, 8).setValue(s.id === id));
  return getState(key);
}

/** Взвесили катушку: net_g — вес пластика без пустой катушки. */
function setRemaining(key, id, netG) {
  check_(key);
  const net = Number(netG);
  if (!(net >= 0)) throw new Error('Неверный вес');
  const s = readSpools_().find(x => x.id === id);
  if (!s) throw new Error('Катушка не найдена');
  const sh = ss_().getSheetByName(SPOOLS);
  if (net > s.initial_g) sh.getRange(s.row, 6).setValue(net);
  sh.getRange(s.row, 7).setValue(round1_(Math.max(s.initial_g, net) - net));
  return getState(key);
}

function archiveSpool(key, id) {
  check_(key);
  const s = readSpools_().find(x => x.id === id);
  if (!s) throw new Error('Катушка не найдена');
  const sh = ss_().getSheetByName(SPOOLS);
  sh.getRange(s.row, 8).setValue(false);
  sh.getRange(s.row, 9).setValue(true);
  return getState(key);
}
