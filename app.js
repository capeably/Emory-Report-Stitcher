'use strict';

/* ============================================================
   1. CONSTANTS
   ============================================================ */

const NAVY_ARGB        = 'FF1F3864';
const WHITE_ARGB       = 'FFFFFFFF';
const LIGHT_BLUE_ARGB  = 'FFD9E1F2';
const GRAY_FILL_ARGB   = 'FFE7E6E6';
const RED_TITLE_ARGB   = 'FFC00000';

const NAVY_HEX  = '#1F3864';
const SOFT_BLUE = '#8FAADC';   // for "Enrolled" series in stacked charts (lighter than navy)
const NAVY_DARK = '#15264a';

const SUBTYPE_BUCKET = {
  'Course Landing Page'    : 'Website',
  'Website RFI'            : 'Website',
  'Facebook Lead Form'     : 'Social',
  'Instagram'              : 'Social',
  'LinkedIn Lead Form'     : 'Social',
  'Instagram Sponsored Ad' : 'Social',
};
// Locked bucket display order (parent rows in this order on the Summary sheet)
const BUCKET_ORDER = ['Website', 'Social'];

const COURSE_STOPWORDS = new Set([
  'the','a','an','of','for','and','to','with','in','on',
  '&','-','program','certificate','course'
]);

// Default 19 columns. `source` drives where the value comes from.
//   pa     → from Participant row (with optional cmFallback)
//   cm     → from Campaign Member row
//   derived→ computed (subtype_bucket, match_method, course_score)
const DEFAULT_COLUMNS = [
  { key:'pa_created',         label:'Program Participant: Created Date', source:'pa',     sourceField:'Program Participant: Created Date' },
  { key:'course_registered',  label:'Course (Registered)',                source:'pa',     sourceField:'Course Name' },
  { key:'status',             label:'Status',                             source:'pa',     sourceField:'Status' },
  { key:'last_name',          label:'Last Name',                          source:'pa',     sourceField:'Last Name', cmFallback:'Last Name' },
  { key:'first_name',         label:'First Name',                         source:'pa',     sourceField:'First Name', cmFallback:'First Name' },
  { key:'email',              label:'Email',                              source:'pa',     sourceField:'Email' },
  { key:'parent_campaign',    label:'Parent Campaign Name',               source:'cm',     sourceField:'Parent Campaign Name' },
  { key:'campaign',           label:'Campaign Name',                      source:'cm',     sourceField:'Campaign Name' },
  { key:'subtype_bucket',     label:'Sub-Type Bucket',                    source:'derived',sourceField:'subtype_bucket' },
  { key:'subtype',            label:'Sub-Type',                           source:'cm',     sourceField:'Sub-Type' },
  { key:'course_start',       label:'Course Instance: Start Date',        source:'pa',     sourceField:'Course Instance: Start Date' },
  { key:'first_responded',    label:'Member First Responded Date',        source:'cm',     sourceField:'Member First Responded Date' },
  { key:'status_update',      label:'Member Status Update Date',          source:'cm',     sourceField:'Member Status Update Date' },
  { key:'cm_related_course',  label:'CM Related Course',                  source:'cm',     sourceField:'Related Course' },
  { key:'phone',              label:'Phone',                              source:'pa',     sourceField:'Phone', cmFallback:'Phone' },
  { key:'pa_contact_id',      label:'Contact ID (PA)',                    source:'pa',     sourceField:'Contact ID' },
  { key:'cm_contact_id',      label:'Contact ID (CM)',                    source:'cm',     sourceField:'Contact ID' },
  { key:'match_method',       label:'Match Method',                       source:'derived',sourceField:'match_method' },
  { key:'course_score',       label:'Course Match Score',                 source:'derived',sourceField:'course_score' },
];

const STORAGE_KEY = 'stitcher.columns.v1';

const REQUIRED_CM_COLS = ['Last Name','First Name','Email','Contact ID','Sub-Type','Related Course','Parent Campaign Name','Campaign Name','Member Status Update Date','Member First Responded Date'];
const REQUIRED_PA_COLS = ['Last Name','First Name','Email','Contact ID','Course Name','Status','Program Participant: Created Date','Course Instance: Start Date'];

/* ============================================================
   2. STATE
   ============================================================ */

const STATE = {
  cm:        { rows: null, fileName: null },
  pa:        { rows: null, fileName: null },
  stitched:  null,    // [{ pa, cm, method, score, subtypeBucket }]
  unmatched: null,    // [pa rows]
  methodCounts: null, // { ContactID, Email, Phone }
  testRemovedCount: 0,
  columns: null,      // [ { ...DEFAULT col, enabled: bool } ]
};

/* ============================================================
   3. NORMALIZATION HELPERS  (port of stitch.py)
   ============================================================ */

function normEmail(s) {
  return (s || '').toString().trim().toLowerCase();
}

function normPhone(s) {
  if (s == null) return '';
  const digits = String(s).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

const TEST_RE = /(?:^|\s)test(?:\s|$)/i;
function isTestRow(first, last) {
  const f = (first || '').toString().trim();
  const l = (last  || '').toString().trim();
  if (f.toLowerCase() === 'test' || l.toLowerCase() === 'test') return true;
  if (TEST_RE.test(f) || TEST_RE.test(l)) return true;
  return false;
}

const TOKEN_RE = /[A-Za-z0-9]+/g;
function courseTokens(s) {
  if (!s) return new Set();
  const matches = String(s).toLowerCase().match(TOKEN_RE) || [];
  return new Set(matches.filter(t => !COURSE_STOPWORDS.has(t)));
}

function courseSimilarity(a, b) {
  if (!a || !b) return 0.0;
  if (String(a).trim().toLowerCase() === String(b).trim().toLowerCase()) return 1.0;
  const ta = courseTokens(a);
  const tb = courseTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0.0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0.0 : inter / union;
}

function bucket(subtype) {
  const s = (subtype || '').toString().trim();
  if (!s) return 'Unknown';
  return SUBTYPE_BUCKET[s] || 'Unknown';
}

/* ============================================================
   4. CSV LAYER
   ============================================================ */

async function readCsv(file) {
  // Auto-detect encoding: UTF-8 (with or without BOM) is preferred; otherwise
  // assume Salesforce default (Windows-1252). Strict UTF-8 decode throws on
  // invalid sequences, which is how cp1252 high-bytes get caught.
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  let encoding;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    encoding = 'utf-8';
  } else {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      encoding = 'utf-8';
    } catch (e) {
      encoding = 'windows-1252';
    }
  }

  const text = new TextDecoder(encoding).decode(buf);

  return new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
      transformHeader: h => h.trim(),
      complete: (res) => {
        if (res.errors && res.errors.length) {
          const fatal = res.errors.find(e => e.type === 'Quotes' || e.type === 'Delimiter');
          if (fatal) console.warn('CSV parse warnings:', res.errors);
        }
        resolve(res.data);
      },
      error: (err) => reject(err),
    });
  });
}

function validateHeaders(rows, required, label) {
  if (!rows || rows.length === 0) {
    throw new Error(`${label} appears to be empty.`);
  }
  const headers = Object.keys(rows[0]);
  const missing = required.filter(r => !headers.includes(r));
  if (missing.length) {
    throw new Error(`${label} is missing required columns: ${missing.join(', ')}`);
  }
}

/* ============================================================
   CACHE LAYER (IndexedDB) — persist uploaded CSVs across sessions
   ============================================================
   Stores parsed CSV rows so users can come back to view the dashboard
   without re-uploading. Cache writes happen on every successful upload;
   reads happen once at init() to restore last-known-good state. The
   restore path re-runs validateHeaders + stitch, so a code change that
   alters schema requirements falls back gracefully (cache is wiped
   instead of producing stale results). All data stays on-device. */

const CACHE_DB = 'stitcher-cache';
const CACHE_STORE = 'csvs';
const CACHE_VERSION = 1;

function cacheOpenDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(CACHE_DB, CACHE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function cachePutCsv(target, fileName, rows) {
  const db = await cacheOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    tx.objectStore(CACHE_STORE).put({ id: target, fileName, rows, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function cacheLoadAll() {
  const db = await cacheOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readonly');
    const out = {};
    tx.objectStore(CACHE_STORE).openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out[cur.value.id] = cur.value; cur.continue(); }
      else resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function cacheDeleteCsv(target) {
  const db = await cacheOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    tx.objectStore(CACHE_STORE).delete(target);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function cacheClearAll() {
  const db = await cacheOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    tx.objectStore(CACHE_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/* ============================================================
   5. STITCH
   ============================================================ */

function indexCm(cmRows) {
  const byId    = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  for (const row of cmRows) {
    const id = (row['Contact ID'] || '').toString().trim();
    if (id) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(row);
    }
    const email = normEmail(row['Email']);
    if (email) {
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(row);
    }
    const phone = normPhone(row['Phone']);
    if (phone) {
      if (!byPhone.has(phone)) byPhone.set(phone, []);
      byPhone.get(phone).push(row);
    }
  }
  return { byId, byEmail, byPhone };
}

function findCmMatches(paRow, cmIdx) {
  const id = (paRow['Contact ID'] || '').toString().trim();
  if (id && cmIdx.byId.has(id)) {
    return { method: 'ContactID', candidates: cmIdx.byId.get(id) };
  }
  const email = normEmail(paRow['Email']);
  if (email && cmIdx.byEmail.has(email)) {
    return { method: 'Email', candidates: cmIdx.byEmail.get(email) };
  }
  const phone = normPhone(paRow['Phone']);
  if (phone && cmIdx.byPhone.has(phone)) {
    return { method: 'Phone', candidates: cmIdx.byPhone.get(phone) };
  }
  return null;
}

function pickBestCm(candidates, paCourseName) {
  if (candidates.length === 1) {
    return { cm: candidates[0], score: courseSimilarity(candidates[0]['Related Course'], paCourseName) };
  }
  let best = candidates[0];
  let bestScore = courseSimilarity(best['Related Course'], paCourseName);
  for (let i = 1; i < candidates.length; i++) {
    const s = courseSimilarity(candidates[i]['Related Course'], paCourseName);
    if (s > bestScore) { best = candidates[i]; bestScore = s; }
  }
  return { cm: best, score: bestScore };
}

function stitch(cmRows, paRows) {
  const cmClean = cmRows.filter(r => !isTestRow(r['First Name'], r['Last Name']));
  const paClean = paRows.filter(r => !isTestRow(r['First Name'], r['Last Name']));
  const testRemovedCount = (cmRows.length - cmClean.length) + (paRows.length - paClean.length);

  const cmIdx = indexCm(cmClean);
  const stitched = [];
  const unmatched = [];
  const methodCounts = { ContactID: 0, Email: 0, Phone: 0 };

  for (const pa of paClean) {
    const match = findCmMatches(pa, cmIdx);
    if (!match) { unmatched.push(pa); continue; }
    const { cm, score } = pickBestCm(match.candidates, pa['Course Name']);
    methodCounts[match.method]++;
    stitched.push({
      pa, cm,
      method: match.method,
      score: Math.round(score * 1000) / 1000,
      subtypeBucket: bucket(cm['Sub-Type']),
    });
  }

  return { stitched, unmatched, methodCounts, testRemovedCount };
}

/* ============================================================
   6. CELL VALUE LOOKUP  (unifies pa/cm/derived sources)
   ============================================================ */

function getCellValue(row, col) {
  const { pa, cm, method, score, subtypeBucket } = row;
  if (col.source === 'pa') {
    let v = pa[col.sourceField];
    if ((v == null || v === '') && col.cmFallback) v = cm[col.cmFallback];
    return v == null ? '' : v;
  }
  if (col.source === 'cm') {
    return cm[col.sourceField] == null ? '' : cm[col.sourceField];
  }
  if (col.source === 'derived') {
    if (col.sourceField === 'subtype_bucket') return subtypeBucket;
    if (col.sourceField === 'match_method')   return method;
    if (col.sourceField === 'course_score')   return score;
  }
  return '';
}

/* ============================================================
   7. COLUMN CONFIG  (load/save/render)
   ============================================================ */

function loadSavedConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return Array.isArray(saved) ? saved : null;
  } catch (e) {
    console.warn('Failed to load column config.', e);
    return null;
  }
}

function sanitizeKey(s) {
  return String(s).toLowerCase().replace(/\W+/g, '_').replace(/^_+|_+$/g, '');
}

// Canonical default column list given the actual file headers. The 19 documented
// defaults come first (enabled). Any additional CM/PA header in the uploaded
// files is appended (disabled), so the user can opt-in to columns like
// "Lead Source Details" or "Contact Owner" without touching code.
function buildDefaultColumnList(cmHeaders, paHeaders) {
  const cols = DEFAULT_COLUMNS.map(d => ({ ...d, enabled: true }));
  const coveredCm = new Set();
  const coveredPa = new Set();
  for (const c of cols) {
    if (c.source === 'cm') coveredCm.add(c.sourceField);
    if (c.source === 'pa') coveredPa.add(c.sourceField);
  }
  for (const h of (cmHeaders || [])) {
    if (!coveredCm.has(h)) {
      cols.push({ key: 'cm__' + sanitizeKey(h), label: h, source: 'cm', sourceField: h, enabled: false });
      coveredCm.add(h);
    }
  }
  for (const h of (paHeaders || [])) {
    if (!coveredPa.has(h)) {
      cols.push({ key: 'pa__' + sanitizeKey(h), label: h, source: 'pa', sourceField: h, enabled: false });
      coveredPa.add(h);
    }
  }
  return cols;
}

// Build the column list applying any saved user preferences (order, label, enabled).
// New columns the saved config didn't know about are appended at the end.
function buildColumnList(cmHeaders, paHeaders) {
  const fullDefaults = buildDefaultColumnList(cmHeaders, paHeaders);
  const saved = loadSavedConfig();
  if (!saved) return fullDefaults;

  const knownByKey = new Map(fullDefaults.map(c => [c.key, c]));
  const reordered = [];
  const seenKeys = new Set();
  for (const item of saved) {
    if (!item || !knownByKey.has(item.key)) continue;
    const def = knownByKey.get(item.key);
    reordered.push({
      ...def,
      label: typeof item.label === 'string' && item.label.trim() ? item.label : def.label,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : def.enabled,
    });
    seenKeys.add(item.key);
  }
  for (const c of fullDefaults) {
    if (!seenKeys.has(c.key)) reordered.push(c);
  }
  return reordered;
}

function saveColumnConfig(cols) {
  try {
    const data = cols.map(c => ({ key: c.key, label: c.label, enabled: c.enabled }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Failed to save column config.', e);
  }
}

function renderColumnPicker(container, cols, onChange) {
  container.innerHTML = '';
  cols.forEach((col, idx) => {
    const row = document.createElement('div');
    row.className = 'col-row';
    row.dataset.key = col.key;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = col.enabled;
    cb.addEventListener('change', () => { col.enabled = cb.checked; onChange(); });

    const upBtn = document.createElement('button');
    upBtn.className = 'reorder-btn';
    upBtn.textContent = '↑';
    upBtn.disabled = idx === 0;
    upBtn.title = 'Move up';
    upBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (idx > 0) {
        [cols[idx-1], cols[idx]] = [cols[idx], cols[idx-1]];
        renderColumnPicker(container, cols, onChange);
        onChange();
      }
    });

    const downBtn = document.createElement('button');
    downBtn.className = 'reorder-btn';
    downBtn.textContent = '↓';
    downBtn.disabled = idx === cols.length - 1;
    downBtn.title = 'Move down';
    downBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (idx < cols.length - 1) {
        [cols[idx], cols[idx+1]] = [cols[idx+1], cols[idx]];
        renderColumnPicker(container, cols, onChange);
        onChange();
      }
    });

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = col.label;
    labelInput.className = 'rename-input';
    labelInput.addEventListener('input', () => { col.label = labelInput.value; onChange(); });

    const sourceSpan = document.createElement('span');
    sourceSpan.className = 'col-source ' + col.source;
    sourceSpan.textContent = col.source === 'derived' ? 'CALC' : col.source.toUpperCase();

    row.append(cb, upBtn, downBtn, labelInput, sourceSpan);
    container.append(row);
  });
}

/* ============================================================
   8. PREVIEW TABLE + KPIs
   ============================================================ */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPreviewTable() {
  const enabled = STATE.columns.filter(c => c.enabled);
  const rows = STATE.stitched;
  const limit = Math.min(100, rows.length);
  const tbl = document.getElementById('preview-table');

  let html = '<thead><tr>';
  for (const col of enabled) html += `<th>${escapeHtml(col.label)}</th>`;
  html += '</tr></thead><tbody>';
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    html += '<tr>';
    for (const col of enabled) {
      let val = getCellValue(r, col);
      if (col.key === 'course_score') {
        const cls = val === 1 ? 'score-1' : (val === 0 ? 'score-0' : 'score-fuzzy');
        html += `<td class="${cls}">${val.toFixed(3)}</td>`;
      } else {
        html += `<td title="${escapeHtml(val)}">${escapeHtml(val)}</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody>';
  tbl.innerHTML = html;

  document.getElementById('preview-meta').textContent =
    `Showing ${limit.toLocaleString()} of ${rows.length.toLocaleString()} stitched rows · ${enabled.length} columns selected`;
}

function renderKpis() {
  // Campaign Member funnel — headline metrics for the new CM-centered view.
  // Each CM (post test-row removal) lands in exactly one bucket via the same
  // derivation the Campaign Members xlsx sheet uses.
  const cmClean = STATE.cm.rows.filter(r => !isTestRow(r['First Name'], r['Last Name']));
  const cmToStitched = new Map();
  for (const s of STATE.stitched) {
    if (!cmToStitched.has(s.cm)) cmToStitched.set(s.cm, []);
    cmToStitched.get(s.cm).push(s);
  }
  let cmNc = 0, cmCx = 0, cmRg = 0, cmEn = 0;
  for (const cm of cmClean) {
    const status = deriveCourseStatus(cmToStitched.get(cm) || []);
    if (status === 'Not Converted')                 cmNc++;
    else if (status === 'Cancelled/Withdrawn/Etc')  cmCx++;
    else if (status === 'Registered')               cmRg++;
    else if (status === 'Enrolled')                 cmEn++;
  }
  const cmConverted = cmRg + cmEn;
  const conversionRate = cmClean.length === 0 ? 0 : (cmConverted / cmClean.length) * 100;

  document.getElementById('kpi-cm-total').textContent        = cmClean.length.toLocaleString();
  document.getElementById('kpi-cm-notconverted').textContent = cmNc.toLocaleString();
  document.getElementById('kpi-cm-cancelled').textContent    = cmCx.toLocaleString();
  document.getElementById('kpi-cm-registered').textContent   = cmRg.toLocaleString();
  document.getElementById('kpi-cm-enrolled').textContent     = cmEn.toLocaleString();
  document.getElementById('kpi-conversion-rate').textContent =
    conversionRate < 10 ? conversionRate.toFixed(1) + '%' : Math.round(conversionRate) + '%';

  // Participant matching — secondary metrics
  const stitched = STATE.stitched.length;
  const unmatchedPa = STATE.unmatched.length;
  document.getElementById('kpi-pa-total').textContent     = (stitched + unmatchedPa).toLocaleString();
  document.getElementById('kpi-stitched').textContent     = stitched.toLocaleString();
  document.getElementById('kpi-pa-unmatched').textContent = unmatchedPa.toLocaleString();

  // Match details
  const m = STATE.methodCounts;
  document.getElementById('match-methods').textContent =
    `${m.ContactID.toLocaleString()} / ${m.Email.toLocaleString()} / ${m.Phone.toLocaleString()}`;

  let s1 = 0, sFuzzy = 0, s0 = 0;
  for (const r of STATE.stitched) {
    if (r.score === 1) s1++; else if (r.score === 0) s0++; else sFuzzy++;
  }
  document.getElementById('score-dist').textContent   = `${s1} / ${sFuzzy} / ${s0}`;
  document.getElementById('test-removed').textContent = STATE.testRemovedCount.toLocaleString();
}

/* ============================================================
   9. AGGREGATIONS  (used for in-page charts AND the xlsx Summary tables)
   ============================================================ */

function aggregateAll(stitched) {
  // Returns three structures with consistent shape:
  //   subtype:  { buckets: { Website: [{name,reg,enr},...], Social:[...], Unknown:[...] } }
  //   parent:   [{ name, reg, enr }] (sorted desc by total)
  //   course:   [{ name, reg, enr }] (sorted desc by total)
  const subtypeMap = new Map();   // bucket → Map(subtypeName → { reg, enr })
  const parentMap  = new Map();
  const courseMap  = new Map();

  // Counts include only Registered + Enrolled per R1 Feedback.
  for (const r of stitched) {
    const status = r.pa['Status'];
    const isReg = status === 'Registered';
    const isEnr = status === 'Enrolled';
    if (!isReg && !isEnr) continue;

    const subtype = (r.cm['Sub-Type'] || '').trim() || '(blank)';
    const bkt = r.subtypeBucket;
    if (!subtypeMap.has(bkt)) subtypeMap.set(bkt, new Map());
    const sub = subtypeMap.get(bkt);
    if (!sub.has(subtype)) sub.set(subtype, { reg:0, enr:0 });
    if (isReg) sub.get(subtype).reg++;
    if (isEnr) sub.get(subtype).enr++;

    const parent = (r.cm['Parent Campaign Name'] || '').trim() || '(blank)';
    if (!parentMap.has(parent)) parentMap.set(parent, { reg:0, enr:0 });
    if (isReg) parentMap.get(parent).reg++;
    if (isEnr) parentMap.get(parent).enr++;

    const course = (r.pa['Course Name'] || '').trim() || '(blank)';
    if (!courseMap.has(course)) courseMap.set(course, { reg:0, enr:0 });
    if (isReg) courseMap.get(course).reg++;
    if (isEnr) courseMap.get(course).enr++;
  }

  // Materialize subtype in locked bucket order, with Unknown last.
  const subtypeBuckets = {};
  const orderedBuckets = [...BUCKET_ORDER];
  if (subtypeMap.has('Unknown')) orderedBuckets.push('Unknown');
  for (const bkt of orderedBuckets) {
    if (!subtypeMap.has(bkt)) continue;
    const arr = [];
    for (const [name, c] of subtypeMap.get(bkt)) arr.push({ name, reg:c.reg, enr:c.enr });
    arr.sort((a,b) => (b.reg+b.enr) - (a.reg+a.enr));
    subtypeBuckets[bkt] = arr;
  }

  const sortByTotal = arr => arr.sort((a,b) => (b.reg+b.enr) - (a.reg+a.enr));
  const parentArr = sortByTotal([...parentMap.entries()].map(([name,c]) => ({ name, reg:c.reg, enr:c.enr })));
  const courseArr = sortByTotal([...courseMap.entries()].map(([name,c]) => ({ name, reg:c.reg, enr:c.enr })));

  return { subtypeBuckets, parent: parentArr, course: courseArr };
}

/* ============================================================
   10. CHART RENDER  (in-page + offscreen for PNG embed)
   ============================================================ */

const PAGE_CHARTS = {};   // key → Chart instance
const OFF_CHARTS  = {};   // key → Chart instance for offscreen high-res render

function buildHorizontalStackedConfig(labels, regSeries, enrSeries, opts = {}) {
  const isPng = !!opts.forPng;
  // For PNG render we draw at 2x the embed size, so font sizes scale up to stay
  // crisp when displayed in Excel at the embed dimensions.
  const scale = isPng ? (opts.scale || 2) : 1;
  const fontSize   = (isPng ? 13 : 12) * scale;
  const totalsSize = (isPng ? 14 : 11) * scale;
  const padRight   = (isPng ? 44 : 30) * scale;

  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Registered', data: regSeries, backgroundColor: NAVY_HEX,  borderWidth: 0 },
        { label: 'Enrolled',   data: enrSeries, backgroundColor: SOFT_BLUE, borderWidth: 0 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: !isPng,
      maintainAspectRatio: false,
      animation: false,
      devicePixelRatio: isPng ? 1 : (window.devicePixelRatio || 1),
      layout: { padding: { right: padRight, top: 6 * scale, bottom: 6 * scale } },
      scales: {
        x: {
          stacked: true,
          beginAtZero: true,
          ticks: { font: { size: fontSize, family: 'Arial' }, color: '#000', precision: 0 },
          grid:  { color: 'rgba(0,0,0,.12)' },
        },
        y: {
          stacked: true,
          ticks: {
            font: { size: fontSize, family: 'Arial' },
            color: '#000',
            // Wrap long category labels across two lines so they don't clip on the
            // canvas's left edge. Returning an array → Chart.js renders multi-line.
            callback: function(value) {
              const label = this.getLabelForValue(value);
              if (!label || label.length <= 34) return label;
              const mid = Math.floor(label.length / 2);
              let breakAt = label.lastIndexOf(' ', mid + 8);
              if (breakAt < mid - 12) breakAt = label.indexOf(' ', mid);
              if (breakAt < 0) return label.length > 60 ? label.slice(0, 57) + '…' : label;
              return [label.slice(0, breakAt), label.slice(breakAt + 1)];
            },
          },
          grid:  { display: false },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            font: { size: fontSize, family: 'Arial', weight: '600' },
            color: '#000',
            boxWidth: 14 * scale,
            padding: 8 * scale,
          },
        },
        // Per R1 Feedback: only show TOTAL value at the right (outer) edge of each bar.
        tooltip: { enabled: !isPng },
      },
    },
    plugins: [totalsLabelPlugin(totalsSize)],
  };
}

function totalsLabelPlugin(fontSize) {
  return {
    id: 'totalsLabel',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta1 = chart.getDatasetMeta(1);
      if (!meta1) return;
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const data0 = chart.data.datasets[0].data;
      const data1 = chart.data.datasets[1].data;
      meta1.data.forEach((bar, i) => {
        const total = (Number(data0[i]) || 0) + (Number(data1[i]) || 0);
        if (total === 0) return;
        ctx.fillText(String(total), bar.x + Math.max(4, fontSize * 0.3), bar.y);
      });
      ctx.restore();
    },
  };
}

function destroyChart(map, key) {
  if (map[key]) { try { map[key].destroy(); } catch(e) {} delete map[key]; }
}

function renderInPageCharts(agg) {
  // Sub-type chart: detail rows only (NO bucket parents — matches stitch.py chart source).
  const sLabels = [], sReg = [], sEnr = [];
  for (const bkt of Object.keys(agg.subtypeBuckets)) {
    for (const r of agg.subtypeBuckets[bkt]) {
      sLabels.push(r.name);
      sReg.push(r.reg);
      sEnr.push(r.enr);
    }
  }
  destroyChart(PAGE_CHARTS, 'subtype');
  const subCanvas = document.getElementById('chart-subtype');
  subCanvas.parentElement.style.height = Math.max(220, sLabels.length * 38 + 80) + 'px';
  PAGE_CHARTS.subtype = new Chart(subCanvas, buildHorizontalStackedConfig(sLabels, sReg, sEnr));

  destroyChart(PAGE_CHARTS, 'parent');
  const pLabels = agg.parent.map(r => r.name);
  const pReg = agg.parent.map(r => r.reg);
  const pEnr = agg.parent.map(r => r.enr);
  const pCanvas = document.getElementById('chart-parent');
  pCanvas.parentElement.style.height = Math.max(260, pLabels.length * 30 + 80) + 'px';
  PAGE_CHARTS.parent = new Chart(pCanvas, buildHorizontalStackedConfig(pLabels, pReg, pEnr));

  destroyChart(PAGE_CHARTS, 'course');
  const cLabels = agg.course.map(r => r.name);
  const cReg = agg.course.map(r => r.reg);
  const cEnr = agg.course.map(r => r.enr);
  const cCanvas = document.getElementById('chart-course');
  cCanvas.parentElement.style.height = Math.max(280, cLabels.length * 28 + 80) + 'px';
  PAGE_CHARTS.course = new Chart(cCanvas, buildHorizontalStackedConfig(cLabels, cReg, cEnr));
}

async function renderOffscreenChartPng(canvasId, labels, reg, enr) {
  // Compute embed dimensions FIRST, then render the canvas at the same aspect ratio
  // (scaled up 2x for crisp display in Excel). Matching aspect ratios prevents
  // Excel from stretching the bitmap when the user resizes columns/rows.
  const embedW = 720;
  const embedH = Math.max(280, labels.length * 28 + 100);
  const scale  = 2;
  const canvas = document.getElementById(canvasId);
  canvas.width  = embedW * scale;
  canvas.height = embedH * scale;
  destroyChart(OFF_CHARTS, canvasId);
  const cfg = buildHorizontalStackedConfig(labels, reg, enr, { forPng: true, scale });
  OFF_CHARTS[canvasId] = new Chart(canvas, cfg);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { dataUrl: canvas.toDataURL('image/png'), embedW, embedH };
}

/* ============================================================
   11. xlsx — STITCHED DATA SHEET
   ============================================================ */

const FONT_HEADER = { name: 'Arial', size: 11, bold: true, color: { argb: WHITE_ARGB } };
const FONT_BODY   = { name: 'Arial', size: 10 };
const FILL_NAVY   = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY_ARGB } };
const FILL_LBLUE  = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_BLUE_ARGB } };
const FILL_GRAY   = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY_FILL_ARGB } };
const BORDER_THIN = {
  top:    { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  left:   { style: 'thin', color: { argb: 'FF000000' } },
  right:  { style: 'thin', color: { argb: 'FF000000' } },
};
const BORDER_MED_BOTTOM = { ...BORDER_THIN, bottom: { style: 'medium', color: { argb: 'FF000000' } } };
const BORDER_MED_TOP    = { ...BORDER_THIN, top:    { style: 'medium', color: { argb: 'FF000000' } } };

function colLetter(n) {
  // 1 -> A, 27 -> AA
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildStitchedSheet(wb) {
  const ws = wb.addWorksheet('Stitched Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  const enabled = STATE.columns.filter(c => c.enabled);
  if (enabled.length === 0) throw new Error('Column picker: at least one column must be selected.');

  const tableColumns = enabled.map(c => ({ name: c.label, filterButton: true }));
  const tableRows = STATE.stitched.map(r => enabled.map(col => {
    const v = getCellValue(r, col);
    if (col.key === 'course_score') return Number(v);
    return v == null ? '' : v;
  }));
  // ExcelJS requires at least one row in addTable; pad with empty if no data.
  if (tableRows.length === 0) tableRows.push(enabled.map(() => ''));

  ws.addTable({
    name: 'StitchedData',
    ref: 'A1',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: tableColumns,
    rows: tableRows,
  });

  // Override header styling to navy + white Arial 11 bold (table style sets a different theme color)
  const headerRow = ws.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell, colNum) => {
    if (colNum > enabled.length) return;
    cell.font = FONT_HEADER;
    cell.fill = FILL_NAVY;
    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
    cell.border = BORDER_THIN;
  });

  // Body styling + column widths (autosize, capped at 45 chars).
  for (let c = 1; c <= enabled.length; c++) {
    let maxLen = enabled[c-1].label.length;
    for (let r = 0; r < tableRows.length; r++) {
      const v = tableRows[r][c-1];
      const s = v == null ? '' : String(v);
      if (s.length > maxLen) maxLen = s.length;
    }
    ws.getColumn(c).width = Math.min(Math.max(maxLen + 2, 10), 45);
  }
  for (let r = 2; r <= tableRows.length + 1; r++) {
    const row = ws.getRow(r);
    row.eachCell((cell, colNum) => {
      if (colNum > enabled.length) return;
      cell.font = FONT_BODY;
      cell.alignment = { vertical: 'middle' };
    });
  }

  return { ws, enabledCols: enabled, dataLastRow: tableRows.length + 1 };
}

/* ============================================================
   12. xlsx — SUMMARY SHEET
   ============================================================ */

function findEnabledColIndex(enabled, key) {
  // Returns 1-based column index in the Stitched Data sheet, or null if not enabled.
  const i = enabled.findIndex(c => c.key === key);
  return i === -1 ? null : i + 1;
}

function buildParticipantSummarySheet(wb, ctx) {
  const { enabledCols, dataLastRow } = ctx;
  const ws = wb.addWorksheet('Participant Summary', { views: [{ showGridLines: false }] });

  const dataSheet = "'Stitched Data'";
  const lastRow = dataLastRow;

  const colStatus  = findEnabledColIndex(enabledCols, 'status');
  const colSubBkt  = findEnabledColIndex(enabledCols, 'subtype_bucket');
  const colSub     = findEnabledColIndex(enabledCols, 'subtype');
  const colParent  = findEnabledColIndex(enabledCols, 'parent_campaign');
  const colCourse  = findEnabledColIndex(enabledCols, 'course_registered');

  // Helper to build a sheet-qualified absolute column reference like 'Stitched Data'!$C$2:$C$N
  const colRef = (c) => c == null ? null : `${dataSheet}!$${colLetter(c)}$2:$${colLetter(c)}$${lastRow}`;

  const ref_status  = colRef(colStatus);
  const ref_subBkt  = colRef(colSubBkt);
  const ref_sub     = colRef(colSub);
  const ref_parent  = colRef(colParent);
  const ref_course  = colRef(colCourse);

  // Default column widths
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 30;
  ws.getColumn(3).width = 13;
  ws.getColumn(4).width = 13;
  ws.getColumn(5).width = 13;
  ws.getColumn(6).width = 3;
  ws.getColumn(7).width = 38;
  ws.getColumn(8).width = 13;
  ws.getColumn(9).width = 13;
  ws.getColumn(10).width = 13;

  // ===== Title (A1:E1) =====
  ws.mergeCells('A1:E1');
  const titleCell = ws.getCell('A1');
  titleCell.value = 'Stitched Report — Summary';
  titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: NAVY_ARGB } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(1).height = 26;

  // ===== KPI block (A3:B5) =====
  // A3 navy fill, white text, "Total Influenced" + COUNTA on Status col
  const kpiNavyCell = (row, label, formulaOrValue, isFormula) => {
    const a = ws.getCell(`A${row}`);
    a.value = label;
    a.font = { name: 'Arial', size: 11, bold: true, color: { argb: WHITE_ARGB } };
    a.fill = FILL_NAVY;
    a.alignment = { horizontal: 'right', vertical: 'middle' };
    const b = ws.getCell(`B${row}`);
    b.value = isFormula ? { formula: formulaOrValue } : formulaOrValue;
    b.font = { name: 'Arial', size: 11, bold: true, color: { argb: WHITE_ARGB } };
    b.fill = FILL_NAVY;
    b.alignment = { horizontal: 'center', vertical: 'middle' };
    b.numFmt = '#,##0';
  };
  const kpiPlainCell = (row, label, formula) => {
    const a = ws.getCell(`A${row}`);
    a.value = label;
    a.font = { name: 'Arial', size: 11, color: { argb: NAVY_ARGB }, bold: true };
    a.alignment = { horizontal: 'right', vertical: 'middle' };
    const b = ws.getCell(`B${row}`);
    b.value = { formula };
    b.font = { name: 'Arial', size: 11, color: { argb: NAVY_ARGB }, bold: true };
    b.alignment = { horizontal: 'center', vertical: 'middle' };
    b.numFmt = '#,##0';
  };

  // Total Influenced = COUNTA over the status column (counts every stitched row)
  // We use COUNTA on Status because every stitched row has a Status value.
  if (ref_status) {
    kpiNavyCell(3, 'Total Influenced', `COUNTA(${ref_status})`, true);
    kpiPlainCell(4, 'Total Registered', `COUNTIF(${ref_status},"Registered")`);
    kpiPlainCell(5, 'Total Enrolled',   `COUNTIF(${ref_status},"Enrolled")`);
  } else {
    kpiNavyCell(3, 'Total Influenced', STATE.stitched.length, false);
    kpiPlainCell(4, 'Total Registered', STATE.stitched.filter(r => r.pa['Status']==='Registered').length.toString());
    kpiPlainCell(5, 'Total Enrolled',   STATE.stitched.filter(r => r.pa['Status']==='Enrolled').length.toString());
  }
  // Bottom medium border on row 5
  ['A5','B5'].forEach(addr => {
    const c = ws.getCell(addr);
    c.border = { ...c.border, bottom: { style: 'medium', color: { argb: 'FF000000' } } };
  });

  // ===== Sub-Type Bucket / Sub-Type table (A7 onwards) =====
  const agg = aggregateAll(STATE.stitched);
  // Compose the rows: bucket parent + sub-type detail rows + grand total
  // Track row numbers as we emit so chart sources can target detail-only rows.
  let r = 7;
  ws.mergeCells(`A${r}:E${r}`);
  const sectionTitle = ws.getCell(`A${r}`);
  sectionTitle.value = 'Sub-Type Bucket / Sub-Type';
  sectionTitle.font = { name: 'Arial', size: 12, bold: true, color: { argb: NAVY_ARGB } };
  sectionTitle.fill = FILL_GRAY;
  sectionTitle.alignment = { horizontal: 'center', vertical: 'middle' };
  applyBorderRange(ws, `A${r}:E${r}`, BORDER_THIN);
  r++;

  // Header row
  const subHeaderRow = r;
  const subHeaders = ['Sub-Type Bucket', 'Sub-Type', 'Registered', 'Enrolled', 'Total'];
  subHeaders.forEach((label, idx) => {
    const cell = ws.getCell(`${colLetter(idx+1)}${r}`);
    cell.value = label;
    cell.font = FONT_HEADER;
    cell.fill = FILL_NAVY;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = BORDER_THIN;
  });
  ws.getRow(r).height = 20;
  r++;

  // Bucket parent rows + detail rows
  const detailRowAddrs = [];   // for chart sources (detail rows only, exclude parents)
  for (const bkt of Object.keys(agg.subtypeBuckets)) {
    const details = agg.subtypeBuckets[bkt];
    if (details.length === 0) continue;

    // Bucket parent row (light blue, bold navy text)
    const parentRowNum = r;
    const aCell = ws.getCell(`A${r}`);
    aCell.value = bkt;
    aCell.font = { name: 'Arial', size: 11, bold: true, color: { argb: NAVY_ARGB } };
    aCell.fill = FILL_LBLUE;
    aCell.alignment = { horizontal: 'left', vertical: 'middle' };
    aCell.border = BORDER_THIN;
    const bCell = ws.getCell(`B${r}`);
    bCell.value = '';
    bCell.fill = FILL_LBLUE;
    bCell.border = BORDER_THIN;
    if (ref_subBkt && ref_status) {
      ws.getCell(`C${r}`).value = { formula: `COUNTIFS(${ref_subBkt},$A${r},${ref_status},"Registered")` };
      ws.getCell(`D${r}`).value = { formula: `COUNTIFS(${ref_subBkt},$A${r},${ref_status},"Enrolled")` };
    } else {
      ws.getCell(`C${r}`).value = details.reduce((a,b)=>a+b.reg,0);
      ws.getCell(`D${r}`).value = details.reduce((a,b)=>a+b.enr,0);
    }
    ws.getCell(`E${r}`).value = { formula: `C${r}+D${r}` };
    ['C','D','E'].forEach(c => {
      const cell = ws.getCell(`${c}${r}`);
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: NAVY_ARGB } };
      cell.fill = FILL_LBLUE;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = BORDER_THIN;
      cell.numFmt = '#,##0';
    });
    r++;

    // Detail rows
    for (const d of details) {
      detailRowAddrs.push(r);
      ws.getCell(`A${r}`).value = '';
      ws.getCell(`A${r}`).border = BORDER_THIN;
      const bCell2 = ws.getCell(`B${r}`);
      bCell2.value = '  ' + d.name;     // two-space indent matches stitch.py style
      bCell2.font = FONT_BODY;
      bCell2.alignment = { horizontal: 'left', vertical: 'middle' };
      bCell2.border = BORDER_THIN;
      if (ref_sub && ref_status) {
        ws.getCell(`C${r}`).value = { formula: `COUNTIFS(${ref_sub},"${escapeFormula(d.name)}",${ref_status},"Registered")` };
        ws.getCell(`D${r}`).value = { formula: `COUNTIFS(${ref_sub},"${escapeFormula(d.name)}",${ref_status},"Enrolled")` };
      } else {
        ws.getCell(`C${r}`).value = d.reg;
        ws.getCell(`D${r}`).value = d.enr;
      }
      ws.getCell(`E${r}`).value = { formula: `C${r}+D${r}` };
      ['C','D','E'].forEach(c => {
        const cell = ws.getCell(`${c}${r}`);
        cell.font = FONT_BODY;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = BORDER_THIN;
        cell.numFmt = '#,##0';
      });
      r++;
    }
  }

  // Grand Total row for the sub-type table
  const subTotalRow = r;
  const aTotal = ws.getCell(`A${r}`);
  aTotal.value = 'Grand Total';
  aTotal.font = { name: 'Arial', size: 11, bold: true, color: { argb: NAVY_ARGB } };
  aTotal.fill = FILL_GRAY;
  aTotal.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getCell(`B${r}`).value = '';
  ws.getCell(`B${r}`).fill = FILL_GRAY;
  ws.getCell(`C${r}`).value = { formula: 'B4' };
  ws.getCell(`D${r}`).value = { formula: 'B5' };
  ws.getCell(`E${r}`).value = { formula: `C${r}+D${r}` };
  ['A','B','C','D','E'].forEach(c => {
    const cell = ws.getCell(`${c}${r}`);
    cell.fill = FILL_GRAY;
    cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: NAVY_ARGB } };
    cell.alignment = { horizontal: c === 'A' || c === 'B' ? 'left' : 'center', vertical: 'middle' };
    cell.border = BORDER_MED_BOTTOM;
    if (c === 'C' || c === 'D' || c === 'E') cell.numFmt = '#,##0';
  });
  const subTableLastRow = r;
  r++;

  // ===== Parent Campaign table (G1:J?) =====
  let pr = 1;
  ws.mergeCells(`G${pr}:J${pr}`);
  const pcTitle = ws.getCell(`G${pr}`);
  pcTitle.value = 'Registrations by Parent Campaign';
  pcTitle.font = { name: 'Arial', size: 12, bold: true, color: { argb: NAVY_ARGB } };
  pcTitle.fill = FILL_GRAY;
  pcTitle.alignment = { horizontal: 'center', vertical: 'middle' };
  applyBorderRange(ws, `G${pr}:J${pr}`, BORDER_THIN);
  pr++;

  // Header
  ['Parent Campaign','Registered','Enrolled','Total'].forEach((label, idx) => {
    const cell = ws.getCell(`${colLetter(7+idx)}${pr}`);
    cell.value = label;
    cell.font = FONT_HEADER;
    cell.fill = FILL_NAVY;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = BORDER_THIN;
  });
  pr++;

  const parentDetailRows = [];
  for (const row of agg.parent) {
    parentDetailRows.push(pr);
    const gCell = ws.getCell(`G${pr}`);
    gCell.value = row.name;
    gCell.font = FONT_BODY;
    gCell.alignment = { horizontal: 'left', vertical: 'middle' };
    gCell.border = BORDER_THIN;
    if (ref_parent && ref_status) {
      ws.getCell(`H${pr}`).value = { formula: `COUNTIFS(${ref_parent},"${escapeFormula(row.name)}",${ref_status},"Registered")` };
      ws.getCell(`I${pr}`).value = { formula: `COUNTIFS(${ref_parent},"${escapeFormula(row.name)}",${ref_status},"Enrolled")` };
    } else {
      ws.getCell(`H${pr}`).value = row.reg;
      ws.getCell(`I${pr}`).value = row.enr;
    }
    ws.getCell(`J${pr}`).value = { formula: `H${pr}+I${pr}` };
    ['H','I','J'].forEach(c => {
      const cell = ws.getCell(`${c}${pr}`);
      cell.font = FONT_BODY;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = BORDER_THIN;
      cell.numFmt = '#,##0';
    });
    pr++;
  }

  // Grand Total row
  const pcTotalRow = pr;
  ws.getCell(`G${pr}`).value = 'Grand Total';
  ws.getCell(`H${pr}`).value = { formula: parentDetailRows.length ? `SUM(H${parentDetailRows[0]}:H${parentDetailRows[parentDetailRows.length-1]})` : '0' };
  ws.getCell(`I${pr}`).value = { formula: parentDetailRows.length ? `SUM(I${parentDetailRows[0]}:I${parentDetailRows[parentDetailRows.length-1]})` : '0' };
  ws.getCell(`J${pr}`).value = { formula: `H${pr}+I${pr}` };
  ['G','H','I','J'].forEach(c => {
    const cell = ws.getCell(`${c}${pr}`);
    cell.fill = FILL_GRAY;
    cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: NAVY_ARGB } };
    cell.alignment = { horizontal: c === 'G' ? 'left' : 'center', vertical: 'middle' };
    cell.border = BORDER_MED_BOTTOM;
    if (c !== 'G') cell.numFmt = '#,##0';
  });
  pr++;
  pr++;   // blank gap before Course table

  // ===== Course table (G{pr}:J?) =====
  const courseTitleRow = pr;
  ws.mergeCells(`G${pr}:J${pr}`);
  const cTitle = ws.getCell(`G${pr}`);
  cTitle.value = 'Registrations by Course';
  cTitle.font = { name: 'Arial', size: 12, bold: true, color: { argb: NAVY_ARGB } };
  cTitle.fill = FILL_GRAY;
  cTitle.alignment = { horizontal: 'center', vertical: 'middle' };
  applyBorderRange(ws, `G${pr}:J${pr}`, BORDER_THIN);
  pr++;

  ['Course','Registered','Enrolled','Total'].forEach((label, idx) => {
    const cell = ws.getCell(`${colLetter(7+idx)}${pr}`);
    cell.value = label;
    cell.font = FONT_HEADER;
    cell.fill = FILL_NAVY;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = BORDER_THIN;
  });
  pr++;

  const courseDetailRows = [];
  for (const row of agg.course) {
    courseDetailRows.push(pr);
    const gCell = ws.getCell(`G${pr}`);
    gCell.value = row.name;
    gCell.font = FONT_BODY;
    gCell.alignment = { horizontal: 'left', vertical: 'middle' };
    gCell.border = BORDER_THIN;
    if (ref_course && ref_status) {
      ws.getCell(`H${pr}`).value = { formula: `COUNTIFS(${ref_course},"${escapeFormula(row.name)}",${ref_status},"Registered")` };
      ws.getCell(`I${pr}`).value = { formula: `COUNTIFS(${ref_course},"${escapeFormula(row.name)}",${ref_status},"Enrolled")` };
    } else {
      ws.getCell(`H${pr}`).value = row.reg;
      ws.getCell(`I${pr}`).value = row.enr;
    }
    ws.getCell(`J${pr}`).value = { formula: `H${pr}+I${pr}` };
    ['H','I','J'].forEach(c => {
      const cell = ws.getCell(`${c}${pr}`);
      cell.font = FONT_BODY;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = BORDER_THIN;
      cell.numFmt = '#,##0';
    });
    pr++;
  }

  // Course grand total row
  const courseTotalRow = pr;
  ws.getCell(`G${pr}`).value = 'Grand Total';
  ws.getCell(`H${pr}`).value = { formula: courseDetailRows.length ? `SUM(H${courseDetailRows[0]}:H${courseDetailRows[courseDetailRows.length-1]})` : '0' };
  ws.getCell(`I${pr}`).value = { formula: courseDetailRows.length ? `SUM(I${courseDetailRows[0]}:I${courseDetailRows[courseDetailRows.length-1]})` : '0' };
  ws.getCell(`J${pr}`).value = { formula: `H${pr}+I${pr}` };
  ['G','H','I','J'].forEach(c => {
    const cell = ws.getCell(`${c}${pr}`);
    cell.fill = FILL_GRAY;
    cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: NAVY_ARGB } };
    cell.alignment = { horizontal: c === 'G' ? 'left' : 'center', vertical: 'middle' };
    cell.border = BORDER_MED_BOTTOM;
    if (c !== 'G') cell.numFmt = '#,##0';
  });

  return {
    ws,
    subtypeChartAnchorRow: subTableLastRow + 2,    // Sub-Type chart anchor (1-based row)
    parentChartAnchorRow:  pcTotalRow + 2,
    courseChartAnchorRow:  subTableLastRow + 2 + 13,  // matches stitch.py spacing
  };
}

function escapeFormula(s) {
  return String(s).replace(/"/g, '""');
}

function applyBorderRange(ws, ref, border) {
  // Apply the same border to every cell in the merged range string A1:E1
  const m = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!m) return;
  const c1 = letterToCol(m[1]), r1 = +m[2];
  const c2 = letterToCol(m[3]), r2 = +m[4];
  for (let rr = r1; rr <= r2; rr++) {
    for (let cc = c1; cc <= c2; cc++) {
      ws.getCell(`${colLetter(cc)}${rr}`).border = border;
    }
  }
}

function letterToCol(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

/* ============================================================
   13. xlsx — CAMPAIGN MEMBERS DATA SHEET + CAMPAIGN SUMMARY
   ============================================================
   Two paired sheets:

   1. **Campaign Members** (data) — every CM (post test-row removal) appears
      exactly once. If matched to a Participant, the PA's key fields appear
      inline (best match wins when there are several: Enrolled > Registered >
      anything else). Wrapped as an Excel Table named "CampaignMembers" so the
      Course Status column drives the Campaign Summary's COUNTIFS formulas.

   2. **Campaign Summary** — pivot-style view of CM counts by Course Status
      bucket, grouped by Parent Campaign → Campaign Name with subtotals and a
      grand total. All count cells are COUNTIFS formulas referencing the
      CampaignMembers table, so deleting rows in the data sheet auto-updates
      the totals here.

   Course Status buckets:
     - Not Converted           — no matching Participant row
     - Cancelled/Withdrawn/Etc — matched a Participant whose Status isn't
                                 Registered or Enrolled (catch-all bucket)
     - Registered              — matched Participant with Status "Registered"
     - Enrolled                — matched Participant with Status "Enrolled" */

function aggregateCmStatusByCampaign() {
  // Used only to determine which (parent, campaign) rows to render in the
  // Campaign Summary — the cell values themselves are formulas.
  const cmClean = STATE.cm.rows.filter(r => !isTestRow(r['First Name'], r['Last Name']));
  const cmToPas = new Map();
  for (const s of STATE.stitched) {
    if (!cmToPas.has(s.cm)) cmToPas.set(s.cm, []);
    cmToPas.get(s.cm).push(s.pa);
  }
  const out = new Map();
  for (const cm of cmClean) {
    const matched = cmToPas.get(cm) || [];
    let bucket;
    if (matched.length === 0) {
      bucket = 'notConverted';
    } else {
      const statuses = matched.map(p => (p['Status'] || '').trim());
      if (statuses.includes('Enrolled'))        bucket = 'enrolled';
      else if (statuses.includes('Registered')) bucket = 'registered';
      else                                       bucket = 'cancelled';
    }
    const parent   = (cm['Parent Campaign Name'] || '').trim() || '(blank)';
    const campaign = (cm['Campaign Name']        || '').trim() || '(blank)';
    if (!out.has(parent)) out.set(parent, new Map());
    const inner = out.get(parent);
    if (!inner.has(campaign)) inner.set(campaign, { notConverted:0, cancelled:0, enrolled:0, registered:0 });
    inner.get(campaign)[bucket]++;
  }
  return out;
}

function deriveCourseStatus(matches) {
  if (!matches || matches.length === 0) return 'Not Converted';
  const statuses = matches.map(s => (s.pa['Status'] || '').trim());
  if (statuses.includes('Enrolled'))        return 'Enrolled';
  if (statuses.includes('Registered'))      return 'Registered';
  return 'Cancelled/Withdrawn/Etc';
}

function buildCampaignMembersSheet(wb) {
  const ws = wb.addWorksheet('Campaign Members', { views: [{ state: 'frozen', ySplit: 1 }] });

  const cmClean = STATE.cm.rows.filter(r => !isTestRow(r['First Name'], r['Last Name']));

  // Reverse-index: CM row → list of stitched matches (each carries pa, method, score)
  const cmToStitched = new Map();
  for (const s of STATE.stitched) {
    if (!cmToStitched.has(s.cm)) cmToStitched.set(s.cm, []);
    cmToStitched.get(s.cm).push(s);
  }

  // When a CM has multiple PA matches, pick the one with the highest course status.
  const rankPa = (s) => {
    const status = (s.pa['Status'] || '').trim();
    if (status === 'Enrolled')   return 3;
    if (status === 'Registered') return 2;
    return 1;
  };

  const headers = [
    'Parent Campaign Name', 'Campaign Name', 'Sub-Type Bucket', 'Sub-Type',
    'Last Name', 'First Name', 'Email', 'Phone', 'Contact ID',
    'Member Status', 'Member Status Update Date', 'Member First Responded Date',
    'CM Related Course', 'Course Status', 'Match Method', 'Course Match Score',
    'PA Course Name', 'PA Status', 'PA Created Date',
    'PA Course Instance: Start Date', 'PA Contact ID',
  ];

  // Sort by Parent Campaign → Campaign Name → Last Name for ease of scanning.
  const sortedCms = [...cmClean].sort((a, b) => {
    const pa = (a['Parent Campaign Name'] || '');
    const pb = (b['Parent Campaign Name'] || '');
    if (pa !== pb) return pa.localeCompare(pb);
    const ca = (a['Campaign Name'] || '');
    const cb = (b['Campaign Name'] || '');
    if (ca !== cb) return ca.localeCompare(cb);
    return (a['Last Name'] || '').localeCompare(b['Last Name'] || '');
  });

  const rows = [];
  for (const cm of sortedCms) {
    const matches = cmToStitched.get(cm) || [];
    const courseStatus = deriveCourseStatus(matches);
    const best = matches.length === 0 ? null : matches.reduce((a, b) => rankPa(b) > rankPa(a) ? b : a);
    const pa = best ? best.pa : null;
    rows.push([
      cm['Parent Campaign Name'] || '',
      cm['Campaign Name'] || '',
      bucket(cm['Sub-Type']),
      cm['Sub-Type'] || '',
      cm['Last Name'] || '',
      cm['First Name'] || '',
      cm['Email'] || '',
      cm['Phone'] || '',
      cm['Contact ID'] || '',
      cm['Member Status'] || '',
      cm['Member Status Update Date'] || '',
      cm['Member First Responded Date'] || '',
      cm['Related Course'] || '',
      courseStatus,
      best ? best.method : '',
      best ? best.score : '',
      pa ? (pa['Course Name'] || '') : '',
      pa ? (pa['Status'] || '') : '',
      pa ? (pa['Program Participant: Created Date'] || '') : '',
      pa ? (pa['Course Instance: Start Date'] || '') : '',
      pa ? (pa['Contact ID'] || '') : '',
    ]);
  }

  // ExcelJS requires at least one row in addTable
  if (rows.length === 0) rows.push(headers.map(() => ''));

  ws.addTable({
    name: 'CampaignMembers',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: headers.map(name => ({ name, filterButton: true })),
    rows,
  });

  // Override header styling (table style sets a different theme color)
  const headerRow = ws.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell, colNum) => {
    if (colNum > headers.length) return;
    cell.font = FONT_HEADER;
    cell.fill = FILL_NAVY;
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
    cell.border = BORDER_THIN;
  });

  // Column widths (autosize, capped at 45 chars)
  for (let c = 1; c <= headers.length; c++) {
    let maxLen = headers[c - 1].length;
    for (const row of rows) {
      const v = row[c - 1];
      const s = v == null ? '' : String(v);
      if (s.length > maxLen) maxLen = s.length;
    }
    ws.getColumn(c).width = Math.min(Math.max(maxLen + 2, 10), 45);
  }
  for (let r = 2; r <= rows.length + 1; r++) {
    const row = ws.getRow(r);
    row.eachCell((cell, colNum) => {
      if (colNum > headers.length) return;
      cell.font = FONT_BODY;
      cell.alignment = { vertical: 'middle' };
    });
  }

  return {
    ws,
    sheetName: 'Campaign Members',
    tableName: 'CampaignMembers',
    dataLastRow: rows.length + 1,
  };
}

function buildCampaignSummarySheet(wb, cmCtx) {
  const ws = wb.addWorksheet('Campaign Summary', { views: [{ state: 'frozen', ySplit: 3 }] });
  const data = aggregateCmStatusByCampaign();

  // Structured table references — auto-resize when rows are added/removed.
  const tbl = cmCtx.tableName;
  const refParent   = `${tbl}[Parent Campaign Name]`;
  const refCampaign = `${tbl}[Campaign Name]`;
  const refStatus   = `${tbl}[Course Status]`;

  // Title (A1:G1)
  ws.mergeCells('A1:G1');
  const title = ws.getCell('A1');
  title.value = 'Campaign Members — Course Status Distribution';
  title.font = { name: 'Arial', size: 14, bold: true, color: { argb: NAVY_ARGB } };
  title.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(1).height = 26;

  // Header row 3
  const headers = ['Parent Campaign', 'Campaign Name', 'Not Converted', 'Cancelled/Withdrawn/Etc', 'Enrolled', 'Registered', 'Total'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(`${colLetter(i+1)}3`);
    cell.value = h;
    cell.font = FONT_HEADER;
    cell.fill = FILL_NAVY;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = BORDER_THIN;
  });
  ws.getRow(3).height = 32;

  const styleNumCells = (rowNum, opts = {}) => {
    ['C','D','E','F','G'].forEach(col => {
      const cell = ws.getCell(`${col}${rowNum}`);
      cell.font = opts.font || FONT_BODY;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = opts.border || BORDER_THIN;
      cell.numFmt = '#,##0';
      if (opts.fill) cell.fill = opts.fill;
    });
  };

  // Build a COUNTIFS formula. Pass null campaign to mean "any campaign" (subtotals).
  const cellFormula = (parentVal, campaignVal, statusVal) => {
    return campaignVal == null
      ? `COUNTIFS(${refParent},"${escapeFormula(parentVal)}",${refStatus},"${statusVal}")`
      : `COUNTIFS(${refParent},"${escapeFormula(parentVal)}",${refCampaign},"${escapeFormula(campaignVal)}",${refStatus},"${statusVal}")`;
  };

  let r = 4;
  const sortedParents = [...data.keys()].sort((a, b) => a.localeCompare(b));

  for (const parent of sortedParents) {
    const inner = data.get(parent);
    const sortedCampaigns = [...inner.keys()].sort((a, b) => a.localeCompare(b));

    sortedCampaigns.forEach((campaign, idx) => {
      ws.getCell(`A${r}`).value = idx === 0 ? parent : '';
      ws.getCell(`B${r}`).value = campaign;
      ws.getCell(`C${r}`).value = { formula: cellFormula(parent, campaign, 'Not Converted') };
      ws.getCell(`D${r}`).value = { formula: cellFormula(parent, campaign, 'Cancelled/Withdrawn/Etc') };
      ws.getCell(`E${r}`).value = { formula: cellFormula(parent, campaign, 'Enrolled') };
      ws.getCell(`F${r}`).value = { formula: cellFormula(parent, campaign, 'Registered') };
      ws.getCell(`G${r}`).value = { formula: `C${r}+D${r}+E${r}+F${r}` };

      ['A', 'B'].forEach(col => {
        const cell = ws.getCell(`${col}${r}`);
        cell.font = (idx === 0 && col === 'A')
          ? { name: 'Arial', size: 10, bold: true, color: { argb: NAVY_ARGB } }
          : FONT_BODY;
        cell.alignment = { vertical: 'middle' };
        cell.border = BORDER_THIN;
      });
      styleNumCells(r);
      r++;
    });

    // Subtotal row (light blue) — formula counts CMs in this parent across all campaigns
    ws.getCell(`A${r}`).value = '';
    ws.getCell(`B${r}`).value = 'Subtotal';
    ws.getCell(`C${r}`).value = { formula: cellFormula(parent, null, 'Not Converted') };
    ws.getCell(`D${r}`).value = { formula: cellFormula(parent, null, 'Cancelled/Withdrawn/Etc') };
    ws.getCell(`E${r}`).value = { formula: cellFormula(parent, null, 'Enrolled') };
    ws.getCell(`F${r}`).value = { formula: cellFormula(parent, null, 'Registered') };
    ws.getCell(`G${r}`).value = { formula: `C${r}+D${r}+E${r}+F${r}` };
    ['A', 'B'].forEach(col => {
      const cell = ws.getCell(`${col}${r}`);
      cell.fill = FILL_LBLUE;
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: NAVY_ARGB } };
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
      cell.border = BORDER_THIN;
    });
    styleNumCells(r, {
      fill: FILL_LBLUE,
      font: { name: 'Arial', size: 10, bold: true, color: { argb: NAVY_ARGB } },
    });
    r++;
  }

  // Grand Total — count across the entire CampaignMembers table
  ws.getCell(`A${r}`).value = 'Grand Total';
  ws.getCell(`B${r}`).value = '';
  ws.getCell(`C${r}`).value = { formula: `COUNTIF(${refStatus},"Not Converted")` };
  ws.getCell(`D${r}`).value = { formula: `COUNTIF(${refStatus},"Cancelled/Withdrawn/Etc")` };
  ws.getCell(`E${r}`).value = { formula: `COUNTIF(${refStatus},"Enrolled")` };
  ws.getCell(`F${r}`).value = { formula: `COUNTIF(${refStatus},"Registered")` };
  ws.getCell(`G${r}`).value = { formula: `C${r}+D${r}+E${r}+F${r}` };
  ['A', 'B'].forEach(col => {
    const cell = ws.getCell(`${col}${r}`);
    cell.fill = FILL_GRAY;
    cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: NAVY_ARGB } };
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
    cell.border = BORDER_MED_BOTTOM;
  });
  styleNumCells(r, {
    fill: FILL_GRAY,
    font: { name: 'Arial', size: 11, bold: true, color: { argb: NAVY_ARGB } },
    border: BORDER_MED_BOTTOM,
  });

  const widths = [38, 48, 14, 22, 11, 12, 10];
  widths.forEach((w, i) => ws.getColumn(i + 1).width = w);
}

/* ============================================================
   14. xlsx — CHARTS  (PNG embed via ExcelJS addImage)
   ============================================================
   ExcelJS does not write native chart objects in v4. The plan budgets the
   PNG fallback as the realistic path: render Chart.js to an offscreen canvas,
   capture as PNG, embed via worksheet.addImage at the same anchor cells the
   Python prototype used (A17, G19, A30) — adjusted to dynamic anchors based
   on the Summary sheet table sizes. */

async function embedChartPngs(wb, summaryWs, ctx) {
  const agg = aggregateAll(STATE.stitched);

  // Sub-Type detail series (excludes bucket parents)
  const sLabels = [], sReg = [], sEnr = [];
  for (const bkt of Object.keys(agg.subtypeBuckets)) {
    for (const r of agg.subtypeBuckets[bkt]) {
      sLabels.push(r.name); sReg.push(r.reg); sEnr.push(r.enr);
    }
  }
  const sub    = await renderOffscreenChartPng('off-subtype', sLabels, sReg, sEnr);

  const pLabels = agg.parent.map(r => r.name);
  const pReg    = agg.parent.map(r => r.reg);
  const pEnr    = agg.parent.map(r => r.enr);
  const parent  = await renderOffscreenChartPng('off-parent', pLabels, pReg, pEnr);

  const cLabels = agg.course.map(r => r.name);
  const cReg    = agg.course.map(r => r.reg);
  const cEnr    = agg.course.map(r => r.enr);
  const course  = await renderOffscreenChartPng('off-course', cLabels, cReg, cEnr);

  // Embed at the exact dimensions the canvas was rendered for, so aspect ratio
  // is preserved and Excel doesn't stretch the bitmap. The PNG itself is at 2x
  // these dimensions for crispness.
  const subId = wb.addImage({ base64: sub.dataUrl, extension: 'png' });
  summaryWs.addImage(subId, {
    tl:  { col: 0, row: ctx.subtypeChartAnchorRow - 1 },
    ext: { width: sub.embedW, height: sub.embedH },
    editAs: 'oneCell',
  });

  const parentId = wb.addImage({ base64: parent.dataUrl, extension: 'png' });
  summaryWs.addImage(parentId, {
    tl:  { col: 6, row: ctx.parentChartAnchorRow - 1 },
    ext: { width: parent.embedW, height: parent.embedH },
    editAs: 'oneCell',
  });

  const courseId = wb.addImage({ base64: course.dataUrl, extension: 'png' });
  summaryWs.addImage(courseId, {
    tl:  { col: 0, row: ctx.courseChartAnchorRow - 1 },
    ext: { width: course.embedW, height: course.embedH },
    editAs: 'oneCell',
  });
}

/* ============================================================
   15. xlsx — TOP-LEVEL BUILD + DOWNLOAD
   ============================================================ */

async function generateXlsx() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Report Stitcher';
  wb.created = new Date();

  const stitchedCtx = buildStitchedSheet(wb);
  const summaryCtx  = buildParticipantSummarySheet(wb, stitchedCtx);
  const cmCtx       = buildCampaignMembersSheet(wb);
  buildCampaignSummarySheet(wb, cmCtx);
  await embedChartPngs(wb, summaryCtx.ws, summaryCtx);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const stamp = new Date().toISOString().slice(0, 10);
  saveAs(blob, `Stitched_Report_${stamp}.xlsx`);
}

/* ============================================================
   16. DASHBOARD — interactive exploration tab
   ============================================================
   Single-tab interactive dashboard with date-range slider, multi-select
   filters, live KPIs, conversion funnel chart, dual-line acquisition vs.
   conversion time-series, and click-to-drill-down modal. */

const PALETTE = {
  navy:     '#1F3864',
  blue:     '#8FAADC',
  green:    '#1f7a3a',
  amber:    '#d97706',
  slate:    '#6b7280',
  burgundy: '#9b1c1c',
};
const STATUS_ORDER = ['Not Converted', 'Cancelled/Withdrawn/Etc', 'Registered', 'Enrolled'];
const STATUS_COLOR = {
  'Not Converted':            PALETTE.slate,
  'Cancelled/Withdrawn/Etc':  PALETTE.burgundy,
  'Registered':               PALETTE.navy,
  'Enrolled':                 PALETTE.green,
};
const BUCKET_OPTIONS = ['Website', 'Social', 'Unknown'];
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ONE_DAY = 86400000;

const FILTERS = {
  dateMin: null,           // Date or null
  dateMax: null,
  dateMode: 'activity',    // 'activity' | 'courseStart'
  parentCampaigns: null,   // null = all, else Set<string>
  subTypeBuckets: null,    // null = all (= empty selection), else Set<string>
  courseStatuses: null,    // null = all, else Set<string>
};
const DASH = {
  initialized:    false,
  cmDataset:      null,    // [{ cm, pa, courseStatus, parentCampaign, ... }]
  parentList:     [],
  parentSelected: null,    // Set<string>
  dateMinAvail:   null,    // Date
  dateMaxAvail:   null,
  funnelChart:    null,
  timeseriesChart:null,
  drillRows:      [],
  drillPage:      0,
  drillPageSize:  12,
};

/* --- Date helpers -------------------------------------------------------- */

function parseSfDate(s) {
  if (s == null || s === '') return null;
  const str = String(s).trim();
  if (!str) return null;
  // ISO: YYYY-MM-DD[ THH:MM[:SS]]
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const d = new Date(+iso[1], +iso[2]-1, +iso[3], +(iso[4]||0), +(iso[5]||0), +(iso[6]||0));
    return isFinite(d.getTime()) ? d : null;
  }
  // US: M/D/YYYY [HH:MM[:SS]] [AM|PM]
  const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (us) {
    let year = +us[3];
    if (year < 100) year += year < 50 ? 2000 : 1900;
    let h = +(us[4] || 0);
    const m = +(us[5] || 0);
    const sec = +(us[6] || 0);
    const ampm = us[7];
    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && h < 12) h += 12;
      if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
    }
    const d = new Date(year, +us[1]-1, +us[2], h, m, sec);
    return isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function fmtDate(d) {
  if (!(d instanceof Date) || !isFinite(d.getTime())) return '—';
  return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfWeek(d) {
  const day = d.getDay(); // 0 = Sun
  const offset = day === 0 ? 6 : day - 1;  // ISO week starts Mon
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function cacheParsedDatesOnRows() {
  // Called once at stitch time. Each row gets a parsed Date attached so we
  // never re-parse during filter changes.
  for (const r of STATE.cm.rows) {
    if (r._datesCached) continue;
    r._memberStatusUpdate = parseSfDate(r['Member Status Update Date']);
    r._memberFirstResponded = parseSfDate(r['Member First Responded Date']);
    r._datesCached = true;
  }
  for (const r of STATE.pa.rows) {
    if (r._datesCached) continue;
    r._paCreated   = parseSfDate(r['Program Participant: Created Date']);
    r._courseStart = parseSfDate(r['Course Instance: Start Date']);
    r._datesCached = true;
  }
}

/* --- CM-centric dataset for the dashboard ------------------------------- */

function buildCmDataset() {
  const cmClean = STATE.cm.rows.filter(r => !isTestRow(r['First Name'], r['Last Name']));
  const cmToStitched = new Map();
  for (const s of STATE.stitched) {
    if (!cmToStitched.has(s.cm)) cmToStitched.set(s.cm, []);
    cmToStitched.get(s.cm).push(s);
  }
  const rankPa = (s) => {
    const st = (s.pa['Status'] || '').trim();
    if (st === 'Enrolled')   return 3;
    if (st === 'Registered') return 2;
    return 1;
  };
  return cmClean.map(cm => {
    const matches = cmToStitched.get(cm) || [];
    const courseStatus = deriveCourseStatus(matches);
    const best = matches.length === 0 ? null : matches.reduce((a, b) => rankPa(b) > rankPa(a) ? b : a);
    return {
      cm,
      pa:             best ? best.pa : null,
      bestMatch:      best,
      courseStatus,
      parentCampaign: (cm['Parent Campaign Name'] || '').trim() || '(blank)',
      campaignName:   (cm['Campaign Name']        || '').trim() || '(blank)',
      subTypeBucket:  bucket(cm['Sub-Type']),
      cmUpdate:       cm._memberStatusUpdate,
      paCreated:      best ? best.pa._paCreated   : null,
      courseStart:    best ? best.pa._courseStart : null,
    };
  });
}

function applyDashboardFilters(dataset) {
  const { dateMin, dateMax, dateMode, parentCampaigns, subTypeBuckets, courseStatuses } = FILTERS;
  return dataset.filter(d => {
    const dateVal = dateMode === 'courseStart' ? d.courseStart : d.cmUpdate;
    // Rows lacking a date in the active mode are excluded when a range is set —
    // they have no place on a time-axis view.
    if ((dateMin || dateMax) && !dateVal) return false;
    if (dateMin && dateVal < dateMin) return false;
    if (dateMax && dateVal > new Date(dateMax.getTime() + ONE_DAY - 1)) return false;
    if (parentCampaigns && !parentCampaigns.has(d.parentCampaign)) return false;
    if (subTypeBuckets  && !subTypeBuckets.has(d.subTypeBucket)) return false;
    if (courseStatuses  && !courseStatuses.has(d.courseStatus)) return false;
    return true;
  });
}

/* --- Tab routing -------------------------------------------------------- */

function setActiveTab(name) {
  if (name !== 'configure' && name !== 'dashboard') name = 'configure';
  if (name === 'dashboard' && !DASH.initialized) {
    name = 'configure';
    if (location.hash === '#dashboard') location.hash = '#configure';
  }
  document.querySelectorAll('.tab-link').forEach(link => {
    link.classList.toggle('active', link.dataset.tab === name);
  });
  document.querySelectorAll('.tab-content').forEach(el => {
    el.hidden = el.id !== `tab-${name}`;
  });
  // Tab swaps preserve scroll position by default, which surfaces the wrong
  // chunk of the new tab when the user clicked from mid-page (e.g. the
  // "Slice it on the Dashboard" callout near the bottom of Step 2). Reset.
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'dashboard') {
    // The slider + charts were created while the panel was display:none, so
    // their pixel-based layout may be wrong. Force a resize after layout has
    // settled so handles land where the values say they should.
    requestAnimationFrame(() => {
      const sliderEl = document.getElementById('date-slider');
      if (sliderEl && sliderEl.noUiSlider) {
        const vals = sliderEl.noUiSlider.get();
        sliderEl.noUiSlider.set(vals);
      }
      window.dispatchEvent(new Event('resize'));
      refreshDashboard();
    });
  }
}

function enableDashboardTab(showCue = true) {
  const link = document.getElementById('tab-link-dashboard');
  // Diff first so a re-stitch in the same session doesn't re-fire the cue.
  // Cache restores also skip the cue (showCue=false) — it's a quiet welcome-back.
  const wasDisabled = link.classList.contains('disabled');
  link.classList.remove('disabled');
  link.removeAttribute('title');
  if (wasDisabled && showCue) {
    link.classList.add('fresh');
    link.addEventListener('click', () => link.classList.remove('fresh'), { once: true });
  }
}

/* --- Filter UI ---------------------------------------------------------- */

function initDashboard(opts = {}) {
  cacheParsedDatesOnRows();
  DASH.cmDataset = buildCmDataset();

  // Compute slider domain — union of CM update dates and PA created dates
  const allDates = [];
  for (const d of DASH.cmDataset) {
    if (d.cmUpdate)    allDates.push(d.cmUpdate.getTime());
    if (d.paCreated)   allDates.push(d.paCreated.getTime());
    if (d.courseStart) allDates.push(d.courseStart.getTime());
  }
  const minTs = allDates.length ? Math.min(...allDates) : Date.now();
  const maxTs = allDates.length ? Math.max(...allDates) : Date.now();
  DASH.dateMinAvail = startOfDay(new Date(minTs));
  DASH.dateMaxAvail = startOfDay(new Date(maxTs));

  // Initial filter state — all on except Not Converted (per consultant pitfall §5.3)
  FILTERS.dateMin         = DASH.dateMinAvail;
  FILTERS.dateMax         = DASH.dateMaxAvail;
  FILTERS.dateMode        = 'activity';
  FILTERS.parentCampaigns = null;
  FILTERS.subTypeBuckets  = new Set(BUCKET_OPTIONS);
  FILTERS.courseStatuses  = new Set(['Cancelled/Withdrawn/Etc', 'Registered', 'Enrolled']);

  // Date slider
  const sliderEl = document.getElementById('date-slider');
  if (sliderEl.noUiSlider) sliderEl.noUiSlider.destroy();
  if (DASH.dateMinAvail.getTime() === DASH.dateMaxAvail.getTime()) {
    // Degenerate single-day dataset — pad by 1 day so the slider can render
    DASH.dateMaxAvail = new Date(DASH.dateMinAvail.getTime() + ONE_DAY);
    FILTERS.dateMax = DASH.dateMaxAvail;
  }
  noUiSlider.create(sliderEl, {
    start:   [DASH.dateMinAvail.getTime(), DASH.dateMaxAvail.getTime()],
    connect: true,
    range:   { min: DASH.dateMinAvail.getTime(), max: DASH.dateMaxAvail.getTime() },
    step:    ONE_DAY,
    tooltips: [
      { to: ts => fmtDate(new Date(+ts)) },
      { to: ts => fmtDate(new Date(+ts)) },
    ],
  });
  const dateMinInput = document.getElementById('filter-date-min');
  const dateMaxInput = document.getElementById('filter-date-max');
  // Set the bounds so users can't pick outside the dataset's available range.
  const _toIso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  dateMinInput.min = dateMaxInput.min = _toIso(DASH.dateMinAvail);
  dateMinInput.max = dateMaxInput.max = _toIso(DASH.dateMaxAvail);

  sliderEl.noUiSlider.on('update', (values) => {
    FILTERS.dateMin = startOfDay(new Date(+values[0]));
    FILTERS.dateMax = startOfDay(new Date(+values[1]));
    // Keep the date inputs in sync with the slider unless the user is actively editing
    if (document.activeElement !== dateMinInput) dateMinInput.value = _toIso(FILTERS.dateMin);
    if (document.activeElement !== dateMaxInput) dateMaxInput.value = _toIso(FILTERS.dateMax);
  });
  sliderEl.noUiSlider.on('change', refreshDashboard);

  // Editable date inputs feed the slider — clamp + swap if the user inverts the range.
  const _onDateInput = (which) => {
    const v = which === 'min' ? dateMinInput.value : dateMaxInput.value;
    if (!v) return;
    const parsed = startOfDay(new Date(v + 'T00:00:00'));
    if (isNaN(parsed.getTime())) return;
    let lo = FILTERS.dateMin.getTime();
    let hi = FILTERS.dateMax.getTime();
    if (which === 'min') lo = Math.max(DASH.dateMinAvail.getTime(), Math.min(parsed.getTime(), hi));
    else                 hi = Math.min(DASH.dateMaxAvail.getTime(), Math.max(parsed.getTime(), lo));
    sliderEl.noUiSlider.set([lo, hi]);
    refreshDashboard();
  };
  dateMinInput.addEventListener('change', () => _onDateInput('min'));
  dateMaxInput.addEventListener('change', () => _onDateInput('max'));

  // Parent campaign multi-select
  DASH.parentList = [...new Set(DASH.cmDataset.map(d => d.parentCampaign))].sort((a,b) => a.localeCompare(b));
  DASH.parentSelected = new Set(DASH.parentList);
  renderParentMultiselect();

  // Sub-Type Bucket chips
  renderChipGroup('filter-bucket-chips', BUCKET_OPTIONS, FILTERS.subTypeBuckets, (set) => {
    FILTERS.subTypeBuckets = set.size === 0 ? null : set;
    refreshDashboard();
  });

  // Course Status chips
  renderChipGroup('filter-status-chips', STATUS_ORDER, FILTERS.courseStatuses, (set) => {
    FILTERS.courseStatuses = set.size === 0 ? null : set;
    refreshDashboard();
  });

  // Date mode toggle
  document.getElementById('filter-date-mode').onclick = () => {
    FILTERS.dateMode = FILTERS.dateMode === 'activity' ? 'courseStart' : 'activity';
    document.getElementById('filter-date-label').textContent =
      FILTERS.dateMode === 'activity' ? 'Activity' : 'Course start';
    refreshDashboard();
  };

  // Reset filters
  document.getElementById('btn-filter-reset').onclick = () => {
    FILTERS.subTypeBuckets = new Set(BUCKET_OPTIONS);
    FILTERS.courseStatuses = new Set(['Cancelled/Withdrawn/Etc', 'Registered', 'Enrolled']);
    FILTERS.parentCampaigns = null;
    FILTERS.dateMode = 'activity';
    DASH.parentSelected = new Set(DASH.parentList);
    sliderEl.noUiSlider.set([DASH.dateMinAvail.getTime(), DASH.dateMaxAvail.getTime()]);
    document.getElementById('filter-date-label').textContent = 'Activity';
    renderChipGroup('filter-bucket-chips', BUCKET_OPTIONS, FILTERS.subTypeBuckets, (set) => {
      FILTERS.subTypeBuckets = set.size === 0 ? null : set;
      refreshDashboard();
    });
    renderChipGroup('filter-status-chips', STATUS_ORDER, FILTERS.courseStatuses, (set) => {
      FILTERS.courseStatuses = set.size === 0 ? null : set;
      refreshDashboard();
    });
    renderParentMultiselect();
    refreshDashboard();
  };

  DASH.initialized = true;
  enableDashboardTab(opts.showCue !== false);
}

function renderChipGroup(containerId, options, activeSet, onChange) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  for (const opt of options) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (activeSet.has(opt) ? ' active' : '');
    chip.textContent = opt;
    chip.dataset.status = opt;
    chip.addEventListener('click', () => {
      if (activeSet.has(opt)) activeSet.delete(opt);
      else activeSet.add(opt);
      chip.classList.toggle('active', activeSet.has(opt));
      onChange(activeSet);
    });
    container.appendChild(chip);
  }
}

function renderParentMultiselect() {
  const toggle   = document.getElementById('filter-parent-toggle');
  const dropdown = document.getElementById('filter-parent-dropdown');

  function updateLabel() {
    const total = DASH.parentList.length;
    const sel = DASH.parentSelected.size;
    if (sel === total)      toggle.innerHTML = `All campaigns (${total}) &#x25BE;`;
    else if (sel === 0)     toggle.innerHTML = `No campaigns selected &#x25BE;`;
    else if (sel === 1)     toggle.innerHTML = `${escapeHtml([...DASH.parentSelected][0]).slice(0, 32)} &#x25BE;`;
    else                    toggle.innerHTML = `${sel} of ${total} campaigns &#x25BE;`;
  }

  function rebuild(filterText) {
    dropdown.innerHTML = '';
    const search = document.createElement('input');
    search.className   = 'filter-multi-search';
    search.placeholder = 'Search…';
    search.value       = filterText || '';
    search.addEventListener('input', e => rebuild(e.target.value));
    dropdown.appendChild(search);
    setTimeout(() => search.focus(), 0);

    const ft = (filterText || '').toLowerCase();
    const visible = DASH.parentList.filter(p => !ft || p.toLowerCase().includes(ft));

    const allRow = document.createElement('label');
    allRow.className = 'filter-multi-option all-row';
    const allCb = document.createElement('input');
    allCb.type  = 'checkbox';
    allCb.checked = visible.length > 0 && visible.every(p => DASH.parentSelected.has(p));
    allCb.indeterminate = !allCb.checked && visible.some(p => DASH.parentSelected.has(p));
    allCb.addEventListener('change', () => {
      if (allCb.checked) for (const p of visible) DASH.parentSelected.add(p);
      else               for (const p of visible) DASH.parentSelected.delete(p);
      rebuild(filterText);
      updateLabel();
      FILTERS.parentCampaigns = DASH.parentSelected.size === DASH.parentList.length ? null : DASH.parentSelected;
      refreshDashboard();
    });
    const allLbl = document.createElement('span');
    allLbl.textContent = ft ? `Select all visible (${visible.length})` : `Select all (${DASH.parentList.length})`;
    allRow.appendChild(allCb);
    allRow.appendChild(allLbl);
    dropdown.appendChild(allRow);

    for (const p of visible) {
      const row = document.createElement('label');
      row.className = 'filter-multi-option';
      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = DASH.parentSelected.has(p);
      cb.addEventListener('change', () => {
        if (cb.checked) DASH.parentSelected.add(p);
        else            DASH.parentSelected.delete(p);
        updateLabel();
        FILTERS.parentCampaigns = DASH.parentSelected.size === DASH.parentList.length ? null : DASH.parentSelected;
        refreshDashboard();
      });
      const lbl = document.createElement('span');
      lbl.textContent = p;
      row.appendChild(cb);
      row.appendChild(lbl);
      dropdown.appendChild(row);
    }
  }

  toggle.onclick = (e) => {
    e.stopPropagation();
    if (dropdown.hidden) { rebuild(''); dropdown.hidden = false; }
    else                 { dropdown.hidden = true; }
  };
  // Single document-level handler — register only once
  if (!renderParentMultiselect._docHandlerInstalled) {
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== toggle && !toggle.contains(e.target)) {
        dropdown.hidden = true;
      }
    });
    renderParentMultiselect._docHandlerInstalled = true;
  }

  updateLabel();
}

/* --- Refresh orchestration --------------------------------------------- */

function refreshDashboard() {
  if (!DASH.initialized) return;
  const filtered = applyDashboardFilters(DASH.cmDataset);
  renderDashKpis(filtered, DASH.cmDataset);
  renderFunnelChart(filtered);
  renderTimeSeriesChart(filtered);
  // Distribution charts: feed the subset of stitched rows whose CM passed the
  // dashboard filter. aggregateAll only counts Registered + Enrolled so the
  // status chips don't matter to these charts — date/parent/bucket filters do.
  const filteredCmSet = new Set(filtered.map(d => d.cm));
  const filteredStitched = STATE.stitched.filter(s => filteredCmSet.has(s.cm));
  renderInPageCharts(aggregateAll(filteredStitched));
  renderCampaignSummaryTable(filtered);
  renderFilterSummary(filtered, DASH.cmDataset);
}

function renderCampaignSummaryTable(filtered) {
  const tbl = document.getElementById('campaign-summary-table');
  if (filtered.length === 0) {
    tbl.innerHTML = '<tbody><tr><td class="campaign-summary-empty">No Campaign Members match the current filter.</td></tr></tbody>';
    return;
  }

  // Group by parent → campaign → status counts
  const byParent = new Map();
  for (const d of filtered) {
    const p = d.parentCampaign;
    const c = d.campaignName;
    if (!byParent.has(p)) byParent.set(p, new Map());
    const inner = byParent.get(p);
    if (!inner.has(c)) inner.set(c, { 'Not Converted':0, 'Cancelled/Withdrawn/Etc':0, 'Registered':0, 'Enrolled':0 });
    inner.get(c)[d.courseStatus]++;
  }

  const sortedParents = [...byParent.keys()].sort((a, b) => a.localeCompare(b));
  let html = '<thead><tr>'
    + '<th class="col-text">Parent Campaign</th>'
    + '<th class="col-text">Campaign Name</th>'
    + '<th>Not Converted</th>'
    + '<th>Cancelled / Withdrawn / Etc</th>'
    + '<th>Enrolled</th>'
    + '<th>Registered</th>'
    + '<th>Total</th>'
    + '</tr></thead><tbody>';

  let grNc = 0, grCx = 0, grEn = 0, grRg = 0;
  for (const parent of sortedParents) {
    const inner = byParent.get(parent);
    const sortedCampaigns = [...inner.keys()].sort((a, b) => a.localeCompare(b));
    let pNc = 0, pCx = 0, pEn = 0, pRg = 0;

    sortedCampaigns.forEach((campaign, idx) => {
      const c = inner.get(campaign);
      const total = c['Not Converted'] + c['Cancelled/Withdrawn/Etc'] + c['Enrolled'] + c['Registered'];
      html += '<tr>'
        + `<td class="col-text" title="${escapeHtml(parent)}">${idx === 0 ? `<span class="parent-name">${escapeHtml(parent)}</span>` : ''}</td>`
        + `<td class="col-text indent" title="${escapeHtml(campaign)}">${escapeHtml(campaign)}</td>`
        + `<td>${c['Not Converted'].toLocaleString()}</td>`
        + `<td>${c['Cancelled/Withdrawn/Etc'].toLocaleString()}</td>`
        + `<td>${c['Enrolled'].toLocaleString()}</td>`
        + `<td>${c['Registered'].toLocaleString()}</td>`
        + `<td>${total.toLocaleString()}</td>`
        + '</tr>';
      pNc += c['Not Converted']; pCx += c['Cancelled/Withdrawn/Etc'];
      pEn += c['Enrolled']; pRg += c['Registered'];
    });

    html += '<tr class="subtotal">'
      + `<td class="col-text"></td>`
      + `<td class="col-text">Subtotal</td>`
      + `<td>${pNc.toLocaleString()}</td>`
      + `<td>${pCx.toLocaleString()}</td>`
      + `<td>${pEn.toLocaleString()}</td>`
      + `<td>${pRg.toLocaleString()}</td>`
      + `<td>${(pNc + pCx + pEn + pRg).toLocaleString()}</td>`
      + '</tr>';
    grNc += pNc; grCx += pCx; grEn += pEn; grRg += pRg;
  }

  html += '<tr class="grand-total">'
    + `<td class="col-text">Grand Total</td>`
    + `<td class="col-text"></td>`
    + `<td>${grNc.toLocaleString()}</td>`
    + `<td>${grCx.toLocaleString()}</td>`
    + `<td>${grEn.toLocaleString()}</td>`
    + `<td>${grRg.toLocaleString()}</td>`
    + `<td>${(grNc + grCx + grEn + grRg).toLocaleString()}</td>`
    + '</tr>';

  html += '</tbody>';
  tbl.innerHTML = html;
}

function renderFilterSummary(filtered, all) {
  const summary = document.getElementById('filter-summary');
  const dateLbl = FILTERS.dateMode === 'activity' ? 'activity date' : 'course start date';
  summary.innerHTML =
    `Showing <strong>${filtered.length.toLocaleString()}</strong> of ${all.length.toLocaleString()} Campaign Members ` +
    `(${fmtDate(FILTERS.dateMin)} – ${fmtDate(FILTERS.dateMax)} on ${dateLbl})`;
}

function renderDashKpis(filtered) {
  let nc = 0, cx = 0, rg = 0, en = 0;
  for (const d of filtered) {
    if (d.courseStatus === 'Not Converted')                 nc++;
    else if (d.courseStatus === 'Cancelled/Withdrawn/Etc')  cx++;
    else if (d.courseStatus === 'Registered')               rg++;
    else if (d.courseStatus === 'Enrolled')                 en++;
  }
  document.getElementById('dash-kpi-total').textContent        = filtered.length.toLocaleString();
  document.getElementById('dash-kpi-notconverted').textContent = nc.toLocaleString();
  document.getElementById('dash-kpi-cancelled').textContent    = cx.toLocaleString();
  document.getElementById('dash-kpi-registered').textContent   = rg.toLocaleString();
  document.getElementById('dash-kpi-enrolled').textContent     = en.toLocaleString();
}

/* --- Funnel chart ------------------------------------------------------- */

function renderFunnelChart(filtered) {
  const counts = { 'Not Converted': 0, 'Cancelled/Withdrawn/Etc': 0, 'Registered': 0, 'Enrolled': 0 };
  for (const d of filtered) counts[d.courseStatus]++;
  const total = filtered.length || 1;
  const pct = (n) => ((n / total) * 100).toFixed(1) + '%';

  const canvas = document.getElementById('chart-funnel');
  if (DASH.funnelChart) { try { DASH.funnelChart.destroy(); } catch(e) {} DASH.funnelChart = null; }

  // Build aria-label dynamically for screen readers
  const ariaParts = STATUS_ORDER.map(s => `${s} ${counts[s]}`);
  canvas.setAttribute('aria-label', `Conversion funnel: total ${filtered.length}, ${ariaParts.join(', ')}`);

  DASH.funnelChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['Funnel'],
      datasets: STATUS_ORDER.map(status => ({
        label: `${status} — ${counts[status]} (${pct(counts[status])})`,
        data: [counts[status]],
        backgroundColor: STATUS_COLOR[status],
        borderWidth: 0,
        _statusKey: status,
      })),
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 4, bottom: 4 } },
      scales: {
        x: { stacked: true, beginAtZero: true, ticks: { font: { size: 12 }, color: '#000', precision: 0 }, grid: { color: 'rgba(0,0,0,.06)' } },
        y: { stacked: true, display: false },
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 12 }, color: '#000', boxWidth: 14, padding: 10 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const s = STATUS_ORDER[ctx.datasetIndex];
              return `${s}: ${ctx.raw.toLocaleString()} (${pct(ctx.raw)})`;
            },
          },
        },
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const status = STATUS_ORDER[elements[0].datasetIndex];
        const matching = filtered.filter(d => d.courseStatus === status);
        openDrilldown(`${status} — ${matching.length.toLocaleString()} Campaign Member${matching.length === 1 ? '' : 's'}`, matching);
      },
    },
    plugins: [funnelLabelPlugin()],
  });
}

function funnelLabelPlugin() {
  return {
    id: 'funnelLabel',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = 'bold 12px Arial, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      for (let i = 0; i < chart.data.datasets.length; i++) {
        const meta = chart.getDatasetMeta(i);
        const value = chart.data.datasets[i].data[0];
        if (value === 0) continue;
        const bar = meta.data[0];
        const segWidth = bar.x - bar.base;
        if (segWidth >= 28) {
          ctx.fillText(String(value), (bar.base + bar.x) / 2, bar.y);
        }
      }
      ctx.restore();
    },
  };
}

/* --- Time-series chart -------------------------------------------------- */

function renderTimeSeriesChart(filtered) {
  // CM acquisition (cmUpdate) and PA conversion (paCreated), filtered cohort only
  const cmDates = filtered.filter(d => d.cmUpdate).map(d => d.cmUpdate);
  const paDates = filtered.filter(d => d.paCreated).map(d => d.paCreated);

  const rangeMs = (FILTERS.dateMax && FILTERS.dateMin) ? FILTERS.dateMax - FILTERS.dateMin : 0;
  const days = rangeMs / ONE_DAY;
  const bin = days < 60 ? 'day' : days < 540 ? 'week' : 'month';
  const binStart = bin === 'day' ? startOfDay : bin === 'week' ? startOfWeek : startOfMonth;
  const binAdvance = (start) => {
    if (bin === 'day')  return new Date(start.getTime() + ONE_DAY);
    if (bin === 'week') return new Date(start.getTime() + 7 * ONE_DAY);
    return new Date(start.getFullYear(), start.getMonth() + 1, 1);
  };

  // Build bin sequence covering the active range
  const startBin = FILTERS.dateMin ? binStart(FILTERS.dateMin) : (cmDates.length || paDates.length ? binStart(new Date(Math.min(...[...cmDates, ...paDates].map(d => d.getTime())))) : new Date());
  const endBin   = FILTERS.dateMax ? binStart(FILTERS.dateMax) : startBin;
  const bins = [];
  for (let cur = new Date(startBin.getTime()); cur <= endBin; cur = binAdvance(cur)) {
    bins.push(cur.getTime());
  }

  const cmCounts = new Map(bins.map(t => [t, 0]));
  const paCounts = new Map(bins.map(t => [t, 0]));
  for (const d of cmDates) {
    const k = binStart(d).getTime();
    if (cmCounts.has(k)) cmCounts.set(k, cmCounts.get(k) + 1);
  }
  for (const d of paDates) {
    const k = binStart(d).getTime();
    if (paCounts.has(k)) paCounts.set(k, paCounts.get(k) + 1);
  }

  const labels   = bins.map(t => fmtBinLabel(new Date(t), bin));
  const cmSeries = bins.map(t => cmCounts.get(t));
  const paSeries = bins.map(t => paCounts.get(t));

  const canvas = document.getElementById('chart-timeseries');
  canvas.setAttribute('aria-label', `Time series: ${cmDates.length} CMs acquired, ${paDates.length} PAs created in the filtered range, binned by ${bin}.`);

  if (DASH.timeseriesChart) { try { DASH.timeseriesChart.destroy(); } catch(e) {} DASH.timeseriesChart = null; }
  DASH.timeseriesChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `CMs acquired (${cmDates.length})`,
          data: cmSeries,
          borderColor: PALETTE.navy,
          backgroundColor: PALETTE.navy,
          borderWidth: 2.5,
          tension: 0.25,
          yAxisID: 'y',
          pointRadius: 3,
          pointHoverRadius: 5,
          fill: false,
        },
        {
          label: `PAs created (${paDates.length})`,
          data: paSeries,
          borderColor: PALETTE.amber,
          backgroundColor: PALETTE.amber,
          borderWidth: 2.5,
          tension: 0.25,
          yAxisID: 'y1',
          pointRadius: 3,
          pointHoverRadius: 5,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { font: { size: 11 }, color: '#000', maxRotation: 45, minRotation: 0 } },
        y:  { position: 'left',  beginAtZero: true, ticks: { font: { size: 11 }, color: PALETTE.navy,  precision: 0 }, title: { display: true, text: 'CMs acquired',  color: PALETTE.navy  } },
        y1: { position: 'right', beginAtZero: true, ticks: { font: { size: 11 }, color: PALETTE.amber, precision: 0 }, grid: { drawOnChartArea: false }, title: { display: true, text: 'PAs created', color: PALETTE.amber } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 12 }, color: '#000', padding: 10 } },
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const el = elements[0];
        const idx = el.index;
        const dsIdx = el.datasetIndex;
        const t0 = bins[idx];
        const t1 = idx + 1 < bins.length ? bins[idx + 1] : binAdvance(new Date(t0)).getTime();
        const labelTxt = labels[idx];
        if (dsIdx === 0) {
          const matching = filtered.filter(d => d.cmUpdate && d.cmUpdate.getTime() >= t0 && d.cmUpdate.getTime() < t1);
          openDrilldown(`CMs acquired ${labelTxt} — ${matching.length.toLocaleString()}`, matching);
        } else {
          const matching = filtered.filter(d => d.paCreated && d.paCreated.getTime() >= t0 && d.paCreated.getTime() < t1);
          openDrilldown(`PAs created ${labelTxt} — ${matching.length.toLocaleString()}`, matching);
        }
      },
    },
  });
}

function fmtBinLabel(d, bin) {
  if (bin === 'day')  return `${d.getMonth()+1}/${d.getDate()}`;
  if (bin === 'week') return `Wk of ${d.getMonth()+1}/${d.getDate()}`;
  return `${MONTH_ABBR[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
}

/* --- Drill-down modal -------------------------------------------------- */

function openDrilldown(title, cmRows) {
  DASH.drillRows = cmRows;
  DASH.drillPage = 0;
  document.getElementById('drilldown-title').textContent = title;
  document.getElementById('drilldown-meta').innerHTML =
    `<strong>${cmRows.length.toLocaleString()}</strong> Campaign Member${cmRows.length === 1 ? '' : 's'} ` +
    `match the current filter and selection.`;
  renderDrilldownPage();
  document.getElementById('drilldown-dialog').showModal();
}

function renderDrilldownPage() {
  const { drillRows: rows, drillPage: page, drillPageSize: size } = DASH;
  const start = page * size;
  const end   = Math.min(rows.length, start + size);
  const slice = rows.slice(start, end);

  const headers = ['Parent Campaign', 'Campaign', 'Status', 'Last', 'First', 'Email', 'CM Update', 'PA Course', 'PA Status', 'PA Created'];
  let html = '<thead><tr>';
  for (const h of headers) html += `<th>${escapeHtml(h)}</th>`;
  html += '</tr></thead><tbody>';
  for (const d of slice) {
    html += '<tr>';
    html += `<td>${escapeHtml(d.parentCampaign)}</td>`;
    html += `<td>${escapeHtml(d.campaignName)}</td>`;
    html += `<td>${escapeHtml(d.courseStatus)}</td>`;
    html += `<td>${escapeHtml(d.cm['Last Name'] || '')}</td>`;
    html += `<td>${escapeHtml(d.cm['First Name'] || '')}</td>`;
    html += `<td>${escapeHtml(d.cm['Email'] || '')}</td>`;
    html += `<td>${d.cmUpdate ? escapeHtml(fmtDate(d.cmUpdate)) : ''}</td>`;
    html += `<td>${d.pa ? escapeHtml(d.pa['Course Name'] || '') : ''}</td>`;
    html += `<td>${d.pa ? escapeHtml(d.pa['Status'] || '') : ''}</td>`;
    html += `<td>${d.paCreated ? escapeHtml(fmtDate(d.paCreated)) : ''}</td>`;
    html += '</tr>';
  }
  if (slice.length === 0) html += `<tr><td colspan="${headers.length}" style="text-align:center;color:var(--text-muted);padding:24px;">(no matching rows)</td></tr>`;
  html += '</tbody>';
  document.getElementById('drilldown-table').innerHTML = html;

  document.getElementById('drilldown-prev').disabled = page === 0;
  document.getElementById('drilldown-next').disabled = end >= rows.length;
  document.getElementById('drilldown-pager-meta').textContent =
    rows.length === 0 ? '0 of 0' : `${start + 1}–${end} of ${rows.length.toLocaleString()}`;
}

function setupDrilldownHandlers() {
  document.getElementById('drilldown-close').addEventListener('click', () => {
    document.getElementById('drilldown-dialog').close();
  });
  document.getElementById('drilldown-prev').addEventListener('click', () => {
    if (DASH.drillPage > 0) { DASH.drillPage--; renderDrilldownPage(); }
  });
  document.getElementById('drilldown-next').addEventListener('click', () => {
    if ((DASH.drillPage + 1) * DASH.drillPageSize < DASH.drillRows.length) { DASH.drillPage++; renderDrilldownPage(); }
  });
}

/* ============================================================
   17. UI WIRE-UP
   ============================================================ */

function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

function showError(containerId, msg) {
  const el = document.getElementById(containerId);
  if (!el) { showToast(msg, true); return; }
  el.innerHTML = `<div class="error-banner">${escapeHtml(msg)}</div>`;
  el.hidden = false;
}

function clearError(containerId) {
  const el = document.getElementById(containerId);
  if (el) { el.innerHTML = ''; el.hidden = true; }
}

function refreshStitchButton() {
  const btn = document.getElementById('btn-stitch');
  const hint = document.getElementById('stitch-hint');
  const ready = STATE.cm.rows && STATE.pa.rows;
  btn.disabled = !ready;
  hint.textContent = ready
    ? `Ready: ${STATE.cm.rows.length.toLocaleString()} CM rows, ${STATE.pa.rows.length.toLocaleString()} PA rows.`
    : 'Upload both reports to enable.';
}

function setupDropZone(zoneEl, target, required, label) {
  const input = zoneEl.querySelector('input[type="file"]');
  const status = zoneEl.querySelector('.file-status');

  const handleFile = async (file) => {
    if (!file) return;
    clearError('upload-error');
    status.innerHTML = `<span class="spinner"></span>Reading…`;
    try {
      const rows = await readCsv(file);
      validateHeaders(rows, required, label);
      STATE[target].rows = rows;
      STATE[target].fileName = file.name;
      zoneEl.classList.add('loaded');
      // A fresh upload supersedes any "restored from last session" badge.
      zoneEl.classList.remove('from-cache');
      status.innerHTML = `<span class="filename">${escapeHtml(file.name)}</span><br><span class="row-count">${rows.length.toLocaleString()} rows</span> <span class="clear-link" data-clear="${target}">remove</span>`;
      refreshStitchButton();
      cachePutCsv(target, file.name, rows).catch(e => console.warn('Cache write failed', e));
      refreshResetButton();
    } catch (err) {
      console.error(err);
      zoneEl.classList.remove('loaded');
      status.innerHTML = '';
      STATE[target].rows = null;
      STATE[target].fileName = null;
      showError('upload-error', `${label}: ${err.message}`);
      refreshStitchButton();
    }
  };

  zoneEl.addEventListener('click', (e) => {
    // Don't fire when clicking the inline 'remove' link
    if (e.target.classList.contains('clear-link')) return;
    input.click();
  });
  input.addEventListener('change', () => handleFile(input.files[0]));
  zoneEl.addEventListener('dragover', (e) => { e.preventDefault(); zoneEl.classList.add('dragover'); });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('dragover'));
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    zoneEl.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // Delegate clear-link clicks
  zoneEl.addEventListener('click', (e) => {
    if (e.target.dataset && e.target.dataset.clear) {
      e.stopPropagation();
      e.preventDefault();
      STATE[target].rows = null;
      STATE[target].fileName = null;
      zoneEl.classList.remove('loaded', 'from-cache');
      status.innerHTML = '';
      input.value = '';
      refreshStitchButton();
      cacheDeleteCsv(target).catch(e => console.warn('Cache delete failed', e));
      refreshResetButton();
    }
  });
}

function rerenderDownstream() {
  // After any column-picker edit, refresh preview only (charts use derived data, not column choices)
  if (!STATE.stitched) return;
  saveColumnConfig(STATE.columns);
  renderPreviewTable();
}

function runStitch(opts = {}) {
  if (!STATE.cm.rows || !STATE.pa.rows) return;
  const t0 = performance.now();
  try {
    const result = stitch(STATE.cm.rows, STATE.pa.rows);
    STATE.stitched        = result.stitched;
    STATE.unmatched       = result.unmatched;
    STATE.methodCounts    = result.methodCounts;
    STATE.testRemovedCount = result.testRemovedCount;
  } catch (err) {
    console.error(err);
    showError('upload-error', `Stitch failed: ${err.message}`);
    return;
  }
  const t1 = performance.now();
  console.log(`Stitch complete in ${(t1-t0).toFixed(0)}ms`);

  // Build the column list now that we know which headers each CSV provides.
  const cmHeaders = STATE.cm.rows.length ? Object.keys(STATE.cm.rows[0]) : [];
  const paHeaders = STATE.pa.rows.length ? Object.keys(STATE.pa.rows[0]) : [];
  STATE.columns = buildColumnList(cmHeaders, paHeaders);

  // Reveal downstream sections
  for (const id of ['step-stats','step-columns','step-preview','step-download']) {
    document.getElementById(id).hidden = false;
  }
  renderKpis();
  renderColumnPicker(document.getElementById('column-list'), STATE.columns, rerenderDownstream);
  renderPreviewTable();
  // The 3 distribution charts (sub-type / parent / course) now live in the Dashboard tab
  // and render on demand via refreshDashboard, so they pick up the active filters.

  // Initialize the Dashboard tab now that we have a stitched dataset.
  // Skip the "fresh data" cue on cache restore — it's a quiet welcome-back, not new arrival.
  try { initDashboard({ showCue: !opts.fromCache }); }
  catch (err) { console.error('Dashboard init failed:', err); }

  refreshResetButton();

  // Auto-scroll only when the user clicked Stitch — restoring from cache shouldn't yank the page.
  if (!opts.fromCache) {
    document.getElementById('step-stats').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* --- Cache restore + reset orchestration -------------------------------- */

async function restoreFromCacheIfPresent() {
  let cached;
  try { cached = await cacheLoadAll(); }
  catch (e) { console.warn('IndexedDB unavailable; skipping restore.', e); return; }

  if (!cached.cm || !cached.pa) {
    refreshResetButton();
    return;
  }

  // Re-validate against current schema. If app code has tightened requirements
  // since the cache was written, wipe rather than restore broken state.
  try {
    validateHeaders(cached.cm.rows, REQUIRED_CM_COLS, 'Cached CM CSV');
    validateHeaders(cached.pa.rows, REQUIRED_PA_COLS, 'Cached PA CSV');
  } catch (e) {
    console.warn('Cached files no longer meet schema; clearing.', e);
    await cacheClearAll().catch(() => {});
    refreshResetButton();
    return;
  }

  STATE.cm.rows     = cached.cm.rows;
  STATE.cm.fileName = cached.cm.fileName;
  STATE.pa.rows     = cached.pa.rows;
  STATE.pa.fileName = cached.pa.fileName;
  markZoneRestored('cm', cached.cm);
  markZoneRestored('pa', cached.pa);
  refreshStitchButton();
  refreshResetButton();

  // Silently re-stitch so the dashboard is ready the moment the user clicks the tab.
  runStitch({ fromCache: true });
}

function markZoneRestored(target, cached) {
  const zoneEl = document.getElementById('drop-' + target);
  const status = zoneEl.querySelector('.file-status');
  zoneEl.classList.add('loaded', 'from-cache');
  status.innerHTML =
    `<span class="filename">${escapeHtml(cached.fileName)}</span><br>` +
    `<span class="row-count">${cached.rows.length.toLocaleString()} rows</span> ` +
    `<span class="cache-tag">Restored</span> ` +
    `<span class="clear-link" data-clear="${target}">remove</span>`;
}

function refreshResetButton() {
  const btn = document.getElementById('btn-reset');
  if (!btn) return;
  const hasData = !!(STATE.cm.rows || STATE.pa.rows || STATE.stitched);
  btn.hidden = !hasData;
}

async function resetApp() {
  const hasData = !!(STATE.cm.rows || STATE.pa.rows || STATE.stitched);
  if (!hasData) return;
  if (!confirm('Reset everything? This clears the cached files, the dashboard, and any stitched data on this device. Column preferences and theme tweaks are kept.')) return;

  await cacheClearAll().catch(e => console.warn('Cache clear failed', e));

  // In-memory state
  STATE.cm.rows = null;     STATE.cm.fileName = null;
  STATE.pa.rows = null;     STATE.pa.fileName = null;
  STATE.stitched = null;
  STATE.unmatched = null;
  STATE.methodCounts = null;
  STATE.testRemovedCount = 0;
  STATE.columns = null;

  // Drop zones
  for (const target of ['cm', 'pa']) {
    const zoneEl = document.getElementById('drop-' + target);
    zoneEl.classList.remove('loaded', 'from-cache', 'dragover');
    zoneEl.querySelector('.file-status').innerHTML = '';
    zoneEl.querySelector('input[type="file"]').value = '';
  }

  // Hide all downstream sections
  for (const id of ['step-stats', 'step-columns', 'step-preview', 'step-download']) {
    document.getElementById(id).hidden = true;
  }

  // Tear down dashboard charts and disable the tab
  if (DASH.funnelChart)     { try { DASH.funnelChart.destroy(); }     catch(e){} DASH.funnelChart = null; }
  if (DASH.timeseriesChart) { try { DASH.timeseriesChart.destroy(); } catch(e){} DASH.timeseriesChart = null; }
  for (const k of Object.keys(PAGE_CHARTS)) {
    try { PAGE_CHARTS[k].destroy(); } catch(e) {}
    delete PAGE_CHARTS[k];
  }
  DASH.initialized = false;
  DASH.cmDataset = null;
  const dashLink = document.getElementById('tab-link-dashboard');
  dashLink.classList.add('disabled');
  dashLink.classList.remove('fresh');
  dashLink.setAttribute('title', 'Upload and stitch reports first');

  if (location.hash === '#dashboard') location.hash = '#configure';
  else setActiveTab('configure');

  clearError('upload-error');

  refreshStitchButton();
  refreshResetButton();
  showToast('Reset complete. Upload your reports to start over.');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function init() {
  // STATE.columns is built after stitch (we need the actual CSV headers to
  // include all source columns, not just the documented defaults).

  setupDropZone(document.getElementById('drop-cm'), 'cm', REQUIRED_CM_COLS, 'Campaign Member CSV');
  setupDropZone(document.getElementById('drop-pa'), 'pa', REQUIRED_PA_COLS, 'Participant CSV');

  // Wrap so the click event isn't passed in as the opts arg.
  document.getElementById('btn-stitch').addEventListener('click', () => runStitch());

  document.getElementById('btn-reset').addEventListener('click', resetApp);

  document.getElementById('btn-reset-cols').addEventListener('click', () => {
    const cmHeaders = STATE.cm.rows ? Object.keys(STATE.cm.rows[0]) : [];
    const paHeaders = STATE.pa.rows ? Object.keys(STATE.pa.rows[0]) : [];
    STATE.columns = buildDefaultColumnList(cmHeaders, paHeaders);
    saveColumnConfig(STATE.columns);
    renderColumnPicker(document.getElementById('column-list'), STATE.columns, rerenderDownstream);
    renderPreviewTable();
  });
  document.getElementById('btn-uncheck-cols').addEventListener('click', () => {
    STATE.columns.forEach(c => c.enabled = false);
    saveColumnConfig(STATE.columns);
    renderColumnPicker(document.getElementById('column-list'), STATE.columns, rerenderDownstream);
    renderPreviewTable();
  });
  document.getElementById('btn-check-cols').addEventListener('click', () => {
    STATE.columns.forEach(c => c.enabled = true);
    saveColumnConfig(STATE.columns);
    renderColumnPicker(document.getElementById('column-list'), STATE.columns, rerenderDownstream);
    renderPreviewTable();
  });

  document.getElementById('btn-xlsx').addEventListener('click', async () => {
    const btn = document.getElementById('btn-xlsx');
    const status = document.getElementById('xlsx-status');
    btn.disabled = true;
    status.innerHTML = '<span class="spinner" style="border-color:rgba(31,56,100,.2);border-top-color:#1F3864;"></span>Building xlsx…';
    try {
      await generateXlsx();
      status.textContent = 'Done.';
      setTimeout(() => { status.textContent = ''; }, 2500);
    } catch (err) {
      console.error(err);
      status.textContent = '';
      showToast('xlsx generation failed: ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // Tab routing
  document.querySelectorAll('.tab-link').forEach(link => {
    link.addEventListener('click', (e) => {
      if (link.classList.contains('disabled')) { e.preventDefault(); return; }
    });
  });
  window.addEventListener('hashchange', () => {
    setActiveTab((location.hash.replace('#','') || 'configure'));
  });
  setupDrilldownHandlers();

  // Restore cached CSVs before routing so a deep-link to #dashboard lands
  // correctly when there's a previous session waiting.
  await restoreFromCacheIfPresent();

  setActiveTab(location.hash.replace('#','') || 'configure');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
