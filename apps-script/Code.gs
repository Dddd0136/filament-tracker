/**
 * Учёт филамента для 3D-принтера на Klipper.
 * Таблица: листы «Катушки» и «Печати»; превью моделей — в папке Google Drive.
 *
 * Веб-приложение:
 *   POST {token, data}                 — отчёт о печати от принтера (с картинкой);
 *   GET  ?token=…&data=…               — то же, без картинки (старый формат);
 *   GET  ?action=call&fn=…&k=…&args=…  — API для приложения (GitHub Pages);
 *   GET  ?k=ТОКЕН                      — встроенная веб-страница.
 */

const SPOOLS = 'Катушки';
const PRINTS = 'Печати';
const SPOOL_HEAD = ['id', 'name', 'material', 'color', 'brand', 'initial_g', 'used_g', 'active', 'archived', 'created', 'price'];
const PRINT_HEAD = ['time', 'file', 'status', 'mm', 'grams', 'spool_id', 'report_id',
  'start', 'print_s', 'total_s', 'progress', 'est_s', 'est_mm', 'est_g',
  'layer_h', 'object_h', 'layers', 'nozzle_t', 'bed_t', 'nozzle_d', 'fil_type', 'slicer', 'thumb_id', 'cost'];
const PC = {}; PRINT_HEAD.forEach((h, i) => PC[h] = i); // индексы колонок

// Плотность, г/см³
const DENSITY = { 'PLA': 1.24, 'PLA+': 1.24, 'PETG': 1.27, 'ABS': 1.04, 'ASA': 1.07, 'TPU': 1.21, 'PC': 1.20, 'NYLON': 1.14 };
const AREA_MM2 = Math.PI * 0.875 * 0.875; // сечение прутка 1.75 мм
const LOW_G = 100;                       // порог «мало осталось»

/** Запустить вручную после вставки кода (и после каждого обновления структуры). */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SHEET_ID', ss.getId());
  ensureSheet_(ss, SPOOLS, SPOOL_HEAD);
  ensureSheet_(ss, PRINTS, PRINT_HEAD);
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  }
  thumbFolder_(); // заодно запросит доступ к Google Drive
  Logger.log('ТОКЕН: ' + props.getProperty('TOKEN'));
}

function ensureSheet_(ss, name, head) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(head);
    sh.setFrozenRows(1);
  } else {
    // дописать новые колонки в заголовок (обновление со старой версии)
    const cur = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
    head.forEach((h, i) => { if (cur[i] !== h) sh.getRange(1, i + 1).setValue(h); });
  }
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold');
  return sh;
}

function thumbFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('THUMB_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Филамент — превью моделей');
  props.setProperty('THUMB_FOLDER', f.getId());
  return f;
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

function round1_(x) { return Math.round(x * 10) / 10; }
function num_(x) { const n = Number(x); return isFinite(n) ? n : ''; }

// ---------------------------------------------------------------- web entry

// Функции, доступные приложению через ?action=call
const API_FNS = {
  getState: getState, addSpool: addSpool, setActive: setActive,
  setRemaining: setRemaining, setPrice: setPrice, archiveSpool: archiveSpool
};

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
      return json_(logPrint_(p.token, JSON.parse(p.data)));
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

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    return json_(logPrint_(body.token, body.data));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
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
    created: r[9] ? new Date(r[9]).getTime() : 0,
    price: Number(r[10]) || 0
  }));
}

function density_(material) {
  return DENSITY[String(material).toUpperCase()] || 1.24;
}

function grams_(mm, material) {
  return mm * AREA_MM2 / 1000 * density_(material);
}

// ---------------------------------------------------------------- printer report

/**
 * d = { id, ts, start_ts, file, status, mm, print_s, total_s, progress,
 *       meta: { estimated_time, filament_total, filament_weight_total, layer_height,
 *               object_height, layer_count, first_layer_extr_temp, first_layer_bed_temp,
 *               nozzle_diameter, filament_type, slicer, slicer_version },
 *       thumb: base64 PNG }
 */
function logPrint_(token, d) {
  if (!token || token !== token_()) throw new Error('bad token');
  if (typeof d === 'string') d = JSON.parse(d);
  const mm = Number(d.mm) || 0;
  const status = String(d.status || 'done');
  const meta = d.meta || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ss = ss_();
    const pr = ss.getSheetByName(PRINTS);
    // повторная отправка из очереди принтера — не считать дважды
    if (d.id && pr.getLastRow() > 1) {
      const ids = pr.getRange(2, PC.report_id + 1, pr.getLastRow() - 1, 1).getValues().flat().map(String);
      const at = ids.indexOf(String(d.id));
      if (at >= 0) return d.update ? enrichRow_(ss, pr, at + 2, d) : { ok: true, dup: true };
      if (d.update) throw new Error('Печать с номером ' + d.id + ' не найдена');
    }
    const spools = readSpools_();
    const sp = spools.find(s => s.active && !s.archived);
    const counted = status !== 'test' && !!sp;
    const g = grams_(mm, sp ? sp.material : (meta.filament_type || 'PLA'));
    const cost = sp && sp.price > 0 && sp.initial_g > 0 ? g * sp.price / sp.initial_g : '';

    let thumbId = '';
    if (d.thumb) {
      try {
        const name = (d.file || 'model').replace(/\.gcode$/i, '') + ' ' + (d.id || Date.now()) + '.png';
        const f = thumbFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(d.thumb), 'image/png', name));
        f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        thumbId = f.getId();
      } catch (e) { /* без картинки — не страшно */ }
    }

    const row = new Array(PRINT_HEAD.length).fill('');
    row[PC.time] = d.ts ? new Date(Number(d.ts) * 1000) : new Date();
    row[PC.file] = d.file || '';
    row[PC.status] = status === 'test' ? 'test' : (sp ? status : status + ' (нет активной катушки)');
    row[PC.mm] = round1_(mm);
    row[PC.grams] = round1_(g);
    row[PC.spool_id] = counted ? sp.id : '';
    row[PC.report_id] = d.id || '';
    row[PC.start] = d.start_ts ? new Date(Number(d.start_ts) * 1000) : '';
    row[PC.print_s] = num_(d.print_s);
    row[PC.total_s] = num_(d.total_s);
    row[PC.progress] = d.progress !== undefined ? num_(d.progress) : '';
    row[PC.est_s] = num_(meta.estimated_time);
    row[PC.est_mm] = num_(meta.filament_total);
    row[PC.est_g] = num_(meta.filament_weight_total);
    row[PC.layer_h] = num_(meta.layer_height);
    row[PC.object_h] = num_(meta.object_height);
    row[PC.layers] = num_(meta.layer_count);
    row[PC.nozzle_t] = num_(meta.first_layer_extr_temp);
    row[PC.bed_t] = num_(meta.first_layer_bed_temp);
    row[PC.nozzle_d] = num_(meta.nozzle_diameter);
    row[PC.fil_type] = meta.filament_type || '';
    row[PC.slicer] = [meta.slicer, meta.slicer_version].filter(Boolean).join(' ');
    row[PC.thumb_id] = thumbId;
    row[PC.cost] = counted && cost !== '' ? Math.round(cost * 100) / 100 : '';

    if (counted) ss.getSheetByName(SPOOLS).getRange(sp.row, 7).setValue(round1_(sp.used_g + g));
    pr.appendRow(row);
    return counted
      ? { ok: true, counted: true, spool: sp.name, grams: round1_(g), remaining: round1_(sp.initial_g - sp.used_g - g), thumb: !!thumbId }
      : { ok: true, counted: false, reason: sp ? 'test' : 'no active spool', thumb: !!thumbId };
  } finally {
    lock.releaseLock();
  }
}

/** Дополнить уже записанную печать (повторная отправка): граммы и катушку не трогает. */
function enrichRow_(ss, pr, rowNum, d) {
  const meta = d.meta || {};
  const row = pr.getRange(rowNum, 1, 1, PRINT_HEAD.length).getValues()[0];
  const set = (k, v) => { if (v !== '' && v !== null && v !== undefined) row[PC[k]] = v; };
  if (d.start_ts) set('start', new Date(Number(d.start_ts) * 1000));
  set('print_s', num_(d.print_s));
  set('total_s', num_(d.total_s));
  if (d.progress !== undefined) set('progress', num_(d.progress));
  set('est_s', num_(meta.estimated_time));
  set('est_mm', num_(meta.filament_total));
  set('est_g', num_(meta.filament_weight_total));
  set('layer_h', num_(meta.layer_height));
  set('object_h', num_(meta.object_height));
  set('layers', num_(meta.layer_count));
  set('nozzle_t', num_(meta.first_layer_extr_temp));
  set('bed_t', num_(meta.first_layer_bed_temp));
  set('nozzle_d', num_(meta.nozzle_diameter));
  set('fil_type', meta.filament_type || '');
  set('slicer', [meta.slicer, meta.slicer_version].filter(Boolean).join(' '));
  if (d.thumb && !row[PC.thumb_id]) {
    try {
      const name = String(row[PC.file] || 'model').replace(/\.gcode$/i, '') + ' ' + d.id + '.png';
      const f = thumbFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(d.thumb), 'image/png', name));
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      row[PC.thumb_id] = f.getId();
    } catch (e) {}
  }
  const sp = readSpools_().find(s => s.id === String(row[PC.spool_id]));
  if (sp && sp.price > 0 && sp.initial_g > 0 && row[PC.cost] === '') {
    row[PC.cost] = Math.round(Number(row[PC.grams]) * sp.price / sp.initial_g * 100) / 100;
  }
  pr.getRange(rowNum, 1, 1, PRINT_HEAD.length).setValues([row]);
  return { ok: true, updated: true, row: rowNum, thumb: !!row[PC.thumb_id] };
}

// ---------------------------------------------------------------- page API

function readPrints_() {
  const pr = ss_().getSheetByName(PRINTS);
  const n = pr.getLastRow() - 1;
  if (n < 1) return [];
  return pr.getRange(2, 1, n, PRINT_HEAD.length).getValues().map(r => {
    const o = {};
    PRINT_HEAD.forEach((h, i) => o[h] = r[i]);
    o.time = o.time ? new Date(o.time).getTime() : 0;
    o.start = o.start ? new Date(o.start).getTime() : 0;
    ['mm', 'grams', 'print_s', 'total_s', 'progress', 'est_s', 'est_mm', 'est_g', 'layer_h', 'object_h', 'layers', 'nozzle_t', 'bed_t', 'nozzle_d', 'cost']
      .forEach(k => o[k] = o[k] === '' || o[k] === null ? null : Number(o[k]));
    ['file', 'status', 'spool_id', 'fil_type', 'slicer', 'thumb_id'].forEach(k => o[k] = String(o[k] || ''));
    delete o.report_id;
    o.thumb = o.thumb_id ? 'https://drive.google.com/thumbnail?id=' + o.thumb_id + '&sz=w600' : '';
    return o;
  });
}

function stats_(prints) {
  const now = Date.now(), DAY = 86400000;
  const real = prints.filter(p => p.status !== 'test');
  function agg(from) {
    const a = { prints: 0, done: 0, cancelled: 0, seconds: 0, grams: 0, cost: 0 };
    real.forEach(p => {
      if (p.time < from) return;
      a.prints++;
      if (p.status.indexOf('cancel') === 0) a.cancelled++; else a.done++;
      a.seconds += p.print_s || 0;
      a.grams += p.grams || 0;
      a.cost += p.cost || 0;
    });
    a.grams = round1_(a.grams); a.cost = Math.round(a.cost);
    return a;
  }
  const days = [];
  const tz = Session.getScriptTimeZone();
  for (let i = 13; i >= 0; i--) {
    const d0 = new Date(now - i * DAY);
    const key = Utilities.formatDate(d0, tz, 'yyyy-MM-dd');
    days.push({ day: key, label: Utilities.formatDate(d0, tz, 'dd.MM'), grams: 0, seconds: 0 });
  }
  const idx = {}; days.forEach((d, i) => idx[d.day] = i);
  real.forEach(p => {
    const k = Utilities.formatDate(new Date(p.time), tz, 'yyyy-MM-dd');
    if (k in idx) { days[idx[k]].grams += p.grams || 0; days[idx[k]].seconds += p.print_s || 0; }
  });
  days.forEach(d => d.grams = round1_(d.grams));
  const byMat = {};
  real.forEach(p => { const m = p.fil_type || '—'; byMat[m] = round1_((byMat[m] || 0) + (p.grams || 0)); });
  return { week: agg(now - 7 * DAY), month: agg(now - 30 * DAY), all: agg(0), days: days, byMaterial: byMat };
}

function getState(key) {
  check_(key);
  const spools = readSpools_().map(s => ({
    id: s.id, name: s.name, material: s.material, color: s.color, brand: s.brand,
    initial_g: s.initial_g, used_g: round1_(s.used_g), price: s.price,
    remaining_g: round1_(Math.max(0, s.initial_g - s.used_g)),
    pct: s.initial_g > 0 ? Math.max(0, Math.min(100, (s.initial_g - s.used_g) / s.initial_g * 100)) : 0,
    low: s.initial_g - s.used_g < LOW_G,
    active: s.active, archived: s.archived, created: s.created
  }));
  const all = readPrints_();
  return {
    spools: spools,
    prints: all.slice(-60).reverse(),
    stats: stats_(all),
    materials: Object.keys(DENSITY),
    low: LOW_G
  };
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
  sh.appendRow([id, name, String(s.material || 'PLA').toUpperCase(), s.color || '#7fb3d5', s.brand || '',
    initial, 0, first, false, new Date(), Number(s.price) || '']);
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

/** Цена всей катушки, ₽ (для расчёта стоимости печатей). */
function setPrice(key, id, price) {
  check_(key);
  const v = Number(price);
  if (!(v >= 0)) throw new Error('Неверная цена');
  const s = readSpools_().find(x => x.id === id);
  if (!s) throw new Error('Катушка не найдена');
  ss_().getSheetByName(SPOOLS).getRange(s.row, 11).setValue(v);
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
