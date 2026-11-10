'use strict';
/* Plan de course – logique partagée (connexion GitHub, données, générateur de plan, calculs).
   Les données de chaque personne vivent dans SON dépôt privé GitHub
   (<son-compte>/journal-course, fichier course.json). Le jeton reste dans le navigateur. */
const JC = (() => {
  const API = 'https://api.github.com';
  const FILE = 'course.json';
  const DEFAULT_REPO = 'journal-course';
  const K = { token: 'jc_token', repo: 'jc_repo', login: 'jc_login', cache: 'jc_cache', dirty: 'jc_dirty' };

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* idem */ } }
  };

  const blank = () => ({ version: 1, records: [] });
  let data = blank();
  let status = { state: 'idle', msg: '' };
  const listeners = [];
  let busy = false, again = false, seq = 0, timer = null;

  // ---------- utilitaires ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const today = () => iso(new Date());
  const toDate = s => { const p = String(s).split('-').map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); };
  const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return iso(d); };
  const diffDays = (a, b) => Math.round((toDate(a) - toDate(b)) / 864e5);
  const weekday = s => (toDate(s).getDay() + 6) % 7;                      // 0 = lundi … 6 = dimanche
  const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const fmtDate = (s, long) => toDate(s).toLocaleDateString('fr-CA', long
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDay = s => toDate(s).toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtShort = s => toDate(s).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
  const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.').replace(/\s/g, '')); return isFinite(n) ? n : NaN; };
  const fmtNum = n => (Math.round(n * 10) / 10).toLocaleString('fr-CA');
  const fmtKm = n => fmtNum(n) + ' km';
  const p2 = n => String(n).padStart(2, '0');
  function fmtDur(sec) {
    sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h ? h + ' h ' + p2(m) + ' min ' + p2(s) + ' s' : m + ' min ' + p2(s) + ' s';
  }
  function fmtClock(sec) {
    sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h ? h + ':' + p2(m) + ':' + p2(s) : m + ':' + p2(s);
  }
  function fmtPace(secPerKm) { let s = Math.round(secPerKm); return Math.floor(s / 60) + ':' + p2(s % 60) + '/km'; }
  /* h, min, s (champs texte) -> secondes ; 0 si tout est vide ; NaN si invalide */
  function hms(h, m, s) {
    const v = [h, m, s].map(x => String(x == null ? '' : x).trim());
    if (v.every(x => !x)) return 0;
    const n = v.map(x => x ? num(x) : 0);
    if (n.some(x => !(x >= 0))) return NaN;
    return Math.round(n[0] * 3600 + n[1] * 60 + n[2]);
  }
  const splitHms = sec => sec > 0 ? [Math.floor(sec / 3600), Math.floor(sec % 3600 / 60), Math.round(sec % 60)] : ['', '', ''];

  function enc(str) {
    const b = new TextEncoder().encode(str); let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function dec(b64) {
    const s = atob(String(b64).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(s, c => c.charCodeAt(0)));
  }

  // ---------- état ----------
  const connected = () => !!(ls.get(K.token) && ls.get(K.repo));
  const login = () => ls.get(K.login) || '';
  const repo = () => ls.get(K.repo) || '';
  function emit() { listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
  function setStatus(state, msg) { status = { state, msg: msg || '' }; emit(); }
  function cache() { ls.set(K.cache, JSON.stringify(data)); }
  function loadCache() {
    try { const c = JSON.parse(ls.get(K.cache) || 'null'); if (c && Array.isArray(c.records)) data = c; } catch (e) { /* cache illisible */ }
  }

  // ---------- GitHub ----------
  function gh(path, opts) {
    opts = opts || {};
    const headers = { 'Authorization': 'Bearer ' + ls.get(K.token), 'Accept': opts.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: opts.method || 'GET', body: opts.body, headers, cache: 'no-store' });
  }

  async function connect(tokenStr, repoStr) {
    tokenStr = String(tokenStr || '').trim();
    if (!tokenStr) throw new Error('Colle ton jeton GitHub.');
    ls.set(K.token, tokenStr);
    try {
      const u = await gh('/user');
      if (u.status === 401) throw new Error('Jeton invalide ou expiré.');
      if (!u.ok) throw new Error('GitHub a répondu ' + u.status + '.');
      const user = await u.json();
      let r = String(repoStr || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      if (!r) r = user.login + '/' + DEFAULT_REPO;
      else if (r.indexOf('/') < 0) r = user.login + '/' + r;
      const rr = await gh('/repos/' + r);
      if (rr.status === 404 || rr.status === 403) throw new Error('Dépôt « ' + r + ' » introuvable avec ce jeton. Vérifie que le dépôt existe et que le jeton y donne accès.');
      if (!rr.ok) throw new Error('GitHub a répondu ' + rr.status + '.');
      ls.set(K.login, user.login); ls.set(K.repo, r);
      ls.del(K.cache); ls.del(K.dirty);
      data = blank();
      await sync();
      return user.login;
    } catch (e) {
      if (!ls.get(K.repo)) ls.del(K.token);
      throw e;
    }
  }

  function disconnect() {
    [K.token, K.repo, K.login, K.cache, K.dirty].forEach(ls.del);
    data = blank();
    setStatus('idle');
  }

  async function fetchRemote() {
    const path = '/repos/' + repo() + '/contents/' + FILE;
    const r = await gh(path);
    if (r.status === 404) return { data: null, sha: null };
    if (r.status === 401) throw new Error('Jeton invalide ou expiré – reconnecte-toi.');
    if (!r.ok) throw new Error('Lecture impossible (GitHub ' + r.status + ').');
    const j = await r.json();
    let text;
    if (j.content) text = dec(j.content);
    else { const raw = await gh(path, { accept: 'application/vnd.github.raw+json' }); text = await raw.text(); }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('Le fichier ' + FILE + ' du dépôt est illisible.'); }
    if (!parsed || !Array.isArray(parsed.records)) parsed = { records: [] };
    return { data: parsed, sha: j.sha };
  }

  /* Fusion par enregistrement (plan ou séance) : le plus récent `updatedAt` gagne. */
  function merge(a, b) {
    const m = new Map();
    for (const r of (b.records || []).concat(a.records || [])) {
      if (!r || !r.id) continue;
      const o = m.get(r.id);
      if (!o || (r.updatedAt || 0) > (o.updatedAt || 0)) m.set(r.id, r);
    }
    return { version: 1, records: Array.from(m.values()) };
  }

  async function sync() {
    if (!connected()) return;
    if (busy) { again = true; return; }
    busy = true;
    setStatus(ls.get(K.dirty) === '1' ? 'saving' : 'loading');
    try {
      for (let i = 0; i < 4; i++) {
        const rem = await fetchRemote();
        if (rem.data) data = merge(data, rem.data);
        cache();
        if (ls.get(K.dirty) !== '1') break;
        const mySeq = seq;
        const body = { message: 'Plan de course – mise à jour', content: enc(JSON.stringify(data, null, 1)) };
        if (rem.sha) body.sha = rem.sha;
        const r = await gh('/repos/' + repo() + '/contents/' + FILE, { method: 'PUT', body: JSON.stringify(body) });
        if (r.ok) { if (mySeq === seq) ls.del(K.dirty); break; }
        if (r.status === 403 || r.status === 404) throw new Error('Écriture refusée : le jeton doit avoir la permission « Contents : Read and write » sur le dépôt.');
        if (r.status !== 409 && r.status !== 422) throw new Error('Enregistrement impossible (GitHub ' + r.status + ').');
        if (i === 3) throw new Error('Enregistrement impossible (conflit répété). Réessaie.');
      }
      setStatus('ok');
    } catch (e) {
      const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || e instanceof TypeError;
      setStatus(offline ? 'offline' : 'error', offline ? '' : e.message);
    } finally {
      busy = false;
      if (again) { again = false; sync(); }
    }
  }

  function changed() {
    seq++; ls.set(K.dirty, '1'); cache(); emit();
    clearTimeout(timer); timer = setTimeout(sync, 700);
  }
  function put(rec) {
    rec.updatedAt = Date.now();
    const i = data.records.findIndex(x => x.id === rec.id);
    if (i >= 0) data.records[i] = rec; else data.records.push(rec);
    changed(); return rec;
  }

  // ---------- générateur de plan ----------
  const DIST = {
    '5': { label: '5 km', km: 5, exact: 5 },
    '10': { label: '10 km', km: 10, exact: 10 },
    '21.1': { label: 'Demi-marathon', km: 21.1, exact: 21.0975 },
    '42.2': { label: 'Marathon', km: 42.2, exact: 42.195 }
  };
  const LEVELS = ['Débutant', 'Intermédiaire', 'Avancé'];
  const PEAK = { '5': [25, 35, 50], '10': [30, 45, 60], '21.1': [38, 52, 68], '42.2': [52, 68, 88] };   // km / semaine au sommet
  const LONG = { '5': [9, 12, 15], '10': [13, 16, 19], '21.1': [18, 21, 24], '42.2': [30, 32, 35] };    // sortie longue max
  const TAPER = { '5': 2, '10': 2, '21.1': 2, '42.2': 3 };                                             // semaines d'affûtage (avec celle de la course)
  const MINW = { '5': 6, '10': 8, '21.1': 10, '42.2': 16 };                                            // durée conseillée
  const DAYF = { 3: 0.72, 4: 0.86, 5: 1, 6: 1.1 };
  const OFFS = { 3: [5, 3, 0], 4: [5, 3, 1, 0], 5: [5, 4, 3, 1, 0], 6: [5, 4, 3, 2, 1, 0] };          // jours avant la sortie longue
  const DEF_WEEKLY = [10, 25, 45];
  const PHASES = { base: 'Base', build: 'Développement', peak: 'Spécifique', taper: 'Affûtage', race: 'Course' };
  const TYPES = { easy: 'Facile', long: 'Longue', fartlek: 'Fartlek', tempo: 'Seuil', intervals: 'Intervalles', specific: 'Allure course', race: 'Course' };

  const riegel = (t1, d1, d2) => t1 * Math.pow(d2 / d1, 1.06);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* Allures d'entraînement (s/km) à partir d'une performance récente, sinon du temps visé. */
  function computePaces(g) {
    const D = DIST[g.dist]; let base = null, src = '';
    const refKm = g.refKm > 0 ? g.refKm : DIST[g.refDist] ? DIST[g.refDist].exact : 0;   // distance libre (km) ou distance standard
    if (g.refSec > 0 && refKm > 0) { base = { d: refKm, t: g.refSec }; src = 'ref'; }
    else if (g.targetSec > 0) { base = { d: D.exact, t: g.targetSec }; src = 'target'; }
    else if (g.learnedEasy > 0) { base = { d: 42.195, t: g.learnedEasy / 1.175 * 42.195 }; src = 'learned'; }   // appris des sorties faciles
    if (!base) return null;
    const f = g.adj && g.adj.pace > 0 ? clamp(g.adj.pace, 0.85, 1.12) : 1;      // ajustement selon les séances réalisées (< 1 = plus vite)
    base.t *= f;
    const p = d => riegel(base.t, base.d, d) / d;
    const mar = p(42.195);
    const thr = 3600 / (base.d * Math.pow(3600 / base.t, 1 / 1.06));      // allure tenable environ 1 h
    const predicted = riegel(base.t, base.d, D.exact);
    return { src, p5: p(5), p10: p(10), half: p(21.0975), mar, thr, easyLo: mar * 1.10, easyHi: mar * 1.25,
      race: g.targetSec > 0 ? g.targetSec / D.exact : predicted / D.exact, predicted: src === 'target' && f === 1 ? null : predicted };
  }

  const r1 = v => Math.round(v);
  const rh = v => Math.round(v * 2) / 2;

  function generatePlan(g) {
    const D = DIST[g.dist];
    if (!D) throw new Error('Choisis une distance.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g.raceDate || '')) throw new Error('Choisis la date de la course.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g.startDate || '')) throw new Error('Choisis la date de début.');
    const total = diffDays(g.raceDate, g.startDate) + 1;
    if (total < 4) throw new Error('La course doit être au moins quelques jours après le début du plan.');
    const N = Math.ceil(total / 7);
    if (N > 60) throw new Error('La course est trop loin (maximum environ 14 mois).');
    const lv = clamp(g.level | 0, 0, 2), d = clamp(g.days | 0, 3, 6);
    const P = computePaces(g);
    const warnings = [];

    // phases
    const T = Math.min(TAPER[g.dist], Math.max(1, Math.floor(N / 3)));
    const M = N - T;
    const peakW = M >= 10 ? (D.km > 20 ? 3 : 2) : M >= 6 ? 2 : M >= 3 ? 1 : 0;
    let baseW = Math.round((M - peakW) * (lv === 0 ? 0.5 : 0.4));
    baseW = Math.min(baseW, 8);
    if (M - peakW >= 2) baseW = clamp(baseW, 1, M - peakW - 1);
    const buildW = M - peakW - baseW;
    const phaseOf = i => i >= M ? 'taper' : i < baseW ? 'base' : i < baseW + buildW ? 'build' : 'peak';

    // volumes visés
    const S = clamp(g.weeklyKm > 0 ? g.weeklyKm : DEF_WEEKLY[lv], 6, 160);
    let Pk = PEAK[g.dist][lv] * DAYF[d];
    if (S > Pk) Pk = S * 1.05;
    const Lp = LONG[g.dist][lv];
    const L0 = clamp(r1(S * 0.4), 4, Lp);
    const R = Math.max(1, M - peakW);
    const frac = i => R > 1 ? Math.min(1, i / (R - 1)) : 1;

    // allures (pour les textes et pour estimer les km des séances au temps)
    const defP5 = [6.6, 5.3, 4.4][lv] * 60, defThr = [7.0, 5.6, 4.6][lv] * 60;
    const pc = k => P ? ' (' + fmtPace(P[k]) + ')' : '';
    const easyTxt = P ? ' Allure : ' + fmtPace(P.easyLo).replace('/km', '') + ' à ' + fmtPace(P.easyHi) + '.' : '';
    const raceName = { '5': 'allure 5 km', '10': 'allure 10 km', '21.1': 'allure demi-marathon', '42.2': 'allure marathon' }[g.dist];
    const raceP = P ? ' (' + fmtPace(P.race) + ')' : '';
    const wu = lv === 0 ? 1.5 : 2, cd = lv === 0 ? 1 : 1.5;
    const em = P ? (P.easyLo + P.easyHi) / 2 : null;
    /* allure moyenne attendue d'une séance mixte : travail + récupérations + le reste en facile */
    const mix = (total, workKm, workPace, recKm) => P ? (workKm * workPace + recKm * P.easyHi * 1.1 + Math.max(0, total - workKm - recKm) * em) / total : null;
    const volF = g.adj && g.adj.vol > 0 ? clamp(g.adj.vol, 0.8, 1.2) : 1;
    const wuTxt = 'Échauffement ' + fmtKm(wu) + ' facile. ', cdTxt = ' Retour au calme ' + fmtKm(cd) + ' facile.';

    const INT = [[6, 400], [4, 800], [8, 400], [5, 800], [4, 1000], [6, 800], [5, 1000], [6, 1000], [5, 1200], [4, 1600]];
    const TMP = [[1, 15], [2, 10], [1, 20], [2, 12], [1, 25], [2, 15], [1, 30], [3, 12], [2, 20], [1, 40]];
    const SPEC = {
      '5': [[4, 1], [5, 1], [3, 1.6], [6, 1], [4, 1.6]],
      '10': [[3, 2], [4, 2], [5, 1.6], [3, 3], [5, 2]],
      '21.1': [[2, 3], [3, 3], [2, 5], [3, 4], [1, 10], [3, 5]],
      '42.2': [[2, 5], [3, 5], [2, 8], [1, 14], [3, 6], [1, 16]]
    };
    let qi = 0, qt = 0, qs = 0;
    let capKm = 99;                                                 // une séance de qualité ne dépasse pas ~1/3 de la semaine
    function fit(fn, list, n) {
      let i = Math.min(list.length - 1, n + lv), s = fn(list[i]);
      while (s.km > capKm && i > 0) s = fn(list[--i]);
      return s.km > capKm ? fartlek(false) : s;
    }

    const intervals = () => fit(intervalsOf, INT, qi++), tempo = () => fit(tempoOf, TMP, qt++), specific = () => fit(specificOf, SPEC[g.dist], qs++);
    function intervalsOf([n, m]) {
      const rec = m === 400 ? '1 min 15' : m === 800 ? '2 min' : m === 1000 ? '2 min 30' : '3 min';
      const km = rh(wu + cd + n * m / 1000 + n * 0.25);
      return { type: 'intervals', title: n + ' × ' + m + ' m', km, pace: P && mix(km, n * m / 1000, P.p5, n * 0.25),
        desc: wuTxt + n + ' × ' + m + ' m à allure 5 km' + pc('p5') + (P ? '' : ' – dur mais contrôlé, 8/10') + ', récupération ' + rec + ' en trottinant.' + cdTxt };
    }
    function tempoOf([n, min]) {
      const work = n * min * 60 / (P ? P.thr : defThr);
      const km = rh(wu + cd + work + (n - 1) * 0.4);
      return { type: 'tempo', title: (n > 1 ? n + ' × ' : '') + min + ' min au seuil', km, pace: P && mix(km, work, P.thr, (n - 1) * 0.4),
        desc: wuTxt + (n > 1 ? n + ' × ' + min + ' min' : min + ' min en continu') + ' à allure seuil' + pc('thr') + ' – confortablement dur, 7/10' +
          (n > 1 ? ', récupération 2 min en trottinant.' : '.') + cdTxt };
    }
    function specificOf([n, km]) {
      const t = n > 1 ? n + ' × ' + fmtKm(km) : fmtKm(km) + ' en continu';
      const tot = rh(wu + cd + n * km + (n - 1) * 0.4);
      return { type: 'specific', title: t + ' à ' + raceName, km: tot, pace: P && mix(tot, n * km, P.race, (n - 1) * 0.4),
        desc: wuTxt + t + ' à ' + raceName + raceP + (n > 1 ? ', récupération 2 à 3 min en trottinant.' : '.') + cdTxt };
    }
    function fartlek(strides) {
      return strides
        ? { type: 'easy', title: 'Footing + lignes droites', km: null, pace: em, desc: 'Footing facile, puis 6 × 20 s en accélération progressive (récupération 40 s en marchant).' + easyTxt }
        : { type: 'fartlek', title: 'Fartlek 8 × 1 min', km: null, pace: em && em * 0.97, desc: 'Footing facile avec, au milieu, 8 × (1 min vite / 1 min très lent). Vite = environ allure 5 km' + pc('p5') + ', sans sprinter.' };
    }
    function tune() {
      const [n, km] = D.km > 20 ? [2, 3] : D.km > 5 ? [3, 1] : [4, 0.4];
      const t = n + ' × ' + (km < 1 ? km * 1000 + ' m' : fmtKm(km));
      const tot = rh(wu + cd + n * km + (n - 1) * 0.3);
      return { type: 'specific', title: t + ' à ' + raceName, km: tot, pace: P && mix(tot, n * km, P.race, (n - 1) * 0.3),
        desc: wuTxt + t + ' à ' + raceName + raceP + ', récupération 2 min. On garde le rythme sans se fatiguer.' + cdTxt };
    }

    const longPos = g.longDay == null || g.longDay === '' ? 6 : ((g.longDay - weekday(g.raceDate) + 6) % 7 + 7) % 7;
    const weeks = [];
    let hard = S, Lhard = L0, buildIdx = 0;

    for (let k = 0; k < N; k++) {
      const end = addDays(g.raceDate, -7 * (N - 1 - k)), start = addDays(end, -6);
      const isRace = k === N - 1, phase = phaseOf(k);
      const sessions = [];
      const add = (pos, s) => sessions.push(Object.assign({ id: 'w' + (k + 1) + 'd' + pos, date: addDays(start, pos) }, s));

      if (isRace) {
        add(1, { type: 'easy', title: 'Footing facile', km: clamp(r1(hard * 0.15), 4, 10), pace: em, desc: 'Footing très facile. Cette semaine, on arrive frais : dors bien et mange normalement.' + easyTxt });
        add(3, { type: 'specific', title: 'Rappel d\'allure', km: clamp(r1(hard * 0.12), 4, 8), pace: em && em * 0.98, desc: 'Footing facile avec 4 × (1 min à ' + raceName + raceP + ' / 1 min lent) au milieu. Juste pour garder les jambes vives.' });
        if (d >= 4) add(5, { type: 'easy', title: 'Déblocage', km: 3, pace: em, desc: '15 à 20 min très faciles + 3 lignes droites de 15 s. Facultatif : le repos complet est aussi correct.' });
        add(6, { type: 'race', title: D.label + (g.name ? ' – ' + g.name : ''), km: D.km,
          desc: 'Jour de course ! ' + (g.targetSec > 0 ? 'Objectif : ' + fmtDur(g.targetSec) + ', soit ' + fmtPace(g.targetSec / D.exact) + '. ' : '') +
            'Pars prudemment : la première moitié doit sembler facile. Après la course, entre ton temps et tes stats Strava ici.' });
      } else {
        // volume et sortie longue de la semaine
        let vol, L, recovery = false, big = true;
        if (phase === 'taper') {
          const left = N - 1 - k;                                   // semaines avant celle de la course
          vol = hard * (left >= 2 ? 0.75 : D.km > 40 ? 0.55 : 0.65);
          L = Lhard * (left >= 2 ? 0.65 : D.km > 40 ? 0.45 : 0.6);
        } else {
          recovery = phase !== 'peak' && k % 4 === 3 && k < M - 1 && M >= 6;
          const v = Math.min(S + (Pk - S) * frac(k), hard * 1.1 + 1);
          const l = Math.min(L0 + (Lp - L0) * frac(k), Lhard + 2);
          if (recovery) { vol = hard * 0.8; L = Lhard * 0.8; }
          else {
            hard = Math.max(v, S); vol = hard;
            if (phase === 'peak' && (M - 1 - k) % 2 === 1) { L = Lhard * 0.8; big = false; }
            else { Lhard = Math.max(l, L0); L = Lhard; }
          }
        }
        vol *= volF; L = Math.min(L * (1 + (volF - 1) / 2), Lp + 2);            // ajustement selon les séances réalisées
        L = r1(L); vol = Math.max(vol, L / 0.55);
        capKm = Math.max(5, vol * 0.34);

        // séances de qualité
        const q = [];
        if (phase === 'taper') q.push(tune());
        else if (phase === 'base') { if (lv >= 1) q.push(fartlek(k % 2 === 0)); }
        else if (phase === 'build') {
          if (recovery || (lv === 0 && buildIdx < 2)) q.push(fartlek(false));
          else {
            const tempoFirst = (buildIdx % 2 === 0) === (D.km > 20);
            q.push(tempoFirst ? tempo() : intervals());
            if (lv === 2 && d >= 5) q.push(tempoFirst ? intervals() : tempo());
          }
          buildIdx++;
        } else {
          q.push(specific());
          if (lv === 2 && d >= 5) q.push(intervals());
        }

        // sortie longue
        let longPace = em;
        let longDesc = 'Sortie longue à allure facile, sans regarder la montre.' + easyTxt + (L >= 14 ? ' Apporte de l\'eau et de quoi manger (gel ou collation) après 60 à 75 min.' : '');
        if (phase === 'peak' && big && lv >= 1 && D.km > 20) {
          const fin = D.km > 40 ? r1(L / 3) : clamp(r1(L / 4), 3, 6);
          longDesc += ' Termine les ' + fin + ' derniers km à ' + raceName + raceP + '.';
          longPace = mix(L, fin, P ? P.race : 0, 0);
        }
        if (lv === 0 && k < 3) longDesc += ' Alterne course et marche au besoin.';

        // répartition sur la semaine
        const offs = OFFS[d], slots = offs.map(o => ({ off: o, pos: ((longPos - o) % 7 + 7) % 7, s: null }));
        slots.find(s => s.off === 0).s = { type: 'long', title: 'Sortie longue', km: L, pace: longPace, desc: longDesc };
        if (q[0]) slots.find(s => s.off === 5).s = q[0];
        if (q[1]) slots.find(s => s.off === 3).s = q[1];
        const fixed = slots.reduce((a, s) => a + (s.s && s.s.km ? s.s.km : 0), 0);
        const free = slots.filter(s => !s.s || s.s.km == null);
        const wsum = free.reduce((a, s) => a + (s.off === 1 ? 0.8 : 1), 0);
        const emax = Math.max(4, r1(L * 0.75)), emin = clamp(r1(L * 0.35), 3, 8);
        for (const s of free) {
          const km = clamp(r1((vol - fixed) * (s.off === 1 ? 0.8 : 1) / wsum), s.off === 1 ? 3 : emin, emax);
          if (s.s) s.s.km = km;
          else s.s = { type: 'easy', title: 'Footing facile', km, pace: em, desc: 'Footing en aisance respiratoire : tu dois pouvoir parler.' + easyTxt + (lv === 0 && k < 3 ? ' Alterne course et marche au besoin.' : '') };
        }
        slots.forEach(s => add(s.pos, s.s));
      }

      const kept = sessions.filter(s => s.date >= g.startDate).sort((a, b) => a.date < b.date ? -1 : 1);
      weeks.push({ n: k + 1, start: start < g.startDate ? g.startDate : start, end, phase: isRace ? 'race' : phase,
        km: Math.round(kept.reduce((a, s) => a + s.km, 0) * 10) / 10, sessions: kept });
    }

    if (N < MINW[g.dist]) warnings.push('Délai court pour un ' + D.label.toLowerCase() + ' : on conseille au moins ' + MINW[g.dist] + ' semaines. Le plan est comprimé ; reste prudent.');
    if (M > 0 && Lhard < Lp * 0.8) warnings.push('Le temps disponible ne permet pas d\'atteindre la sortie longue idéale (' + Lp + ' km). Le plan monte jusqu\'à ' + r1(Lhard) + ' km.');
    if (P && P.predicted && g.targetSec > 0 && g.targetSec < P.predicted * 0.93)
      warnings.push('Objectif ambitieux : ta forme actuelle équivaut à environ ' + fmtDur(P.predicted) + ' sur la distance. Les allures d\'entraînement sont basées sur ta forme actuelle.');

    return { kind: 'plan', goal: Object.assign({}, g, { level: lv, days: d }), paces: P, weeks, warnings };
  }

  // ---------- données ----------
  function plans() { return data.records.filter(r => r.kind === 'plan' && !r.deleted).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
  function activePlan() { return plans().find(p => !p.archived) || null; }
  function createPlan(goal) {
    const p = generatePlan(goal);
    plans().filter(x => !x.archived).forEach(x => put(Object.assign({}, x, { archived: true })));
    p.id = uid(); p.createdAt = Date.now();
    return put(p);
  }
  function deletePlan(id) { put({ id, deleted: true }); }
  const logId = (planId, sessId) => planId + '/' + sessId;
  function getLog(planId, sessId) { return data.records.find(r => r.id === logId(planId, sessId) && r.kind === 'log' && !r.deleted) || null; }
  function saveLog(planId, sessId, fields) {
    const old = getLog(planId, sessId) || {};
    return put(Object.assign({}, old, fields, { id: logId(planId, sessId), kind: 'log', planId, sessId }));
  }
  function setDone(planId, sessId, done) { const old = getLog(planId, sessId); return saveLog(planId, sessId, { done: !!done, doneAt: done ? ((old && old.doneAt) || today()) : null }); }
  const hasStats = l => !!(l && (l.distance > 0 || l.duration > 0 || l.hr > 0 || l.elev > 0 || l.feel > 0 || l.note || l.url));
  function clearStats(planId, sessId) { return saveLog(planId, sessId, { distance: 0, duration: 0, hr: 0, elev: 0, feel: 0, note: '', url: '' }); }

  /* Séances du plan avec leur suivi : [{week, s, log, done, km (réel si entré, sinon prévu)}] */
  function entries(plan) {
    const out = [];
    for (const w of plan.weeks) for (const s of w.sessions) {
      const log = getLog(plan.id, s.id), done = !!(log && log.done);
      out.push({ week: w, s, log, done, km: done ? (log.distance > 0 ? log.distance : s.km) : 0 });
    }
    return out;
  }
  function summary(plan) {
    const es = entries(plan), t = today();
    const done = es.filter(e => e.done);
    const cur = plan.weeks.find(w => t >= w.start && t <= w.end) || null;
    return {
      total: es.length, done: done.length, due: es.filter(e => e.s.date <= t).length,
      km: done.reduce((a, e) => a + e.km, 0), plannedKm: es.reduce((a, e) => a + e.s.km, 0),
      longest: done.reduce((a, e) => Math.max(a, e.km), 0),
      week: cur, weekDone: cur ? es.filter(e => e.week === cur && e.done).reduce((a, e) => a + e.km, 0) : 0,
      daysLeft: diffDays(plan.goal.raceDate, t),
      next: es.find(e => !e.done && e.s.date >= t) || null,
      race: es.find(e => e.s.type === 'race') || null
    };
  }

  // ---------- ajustement automatique du plan ----------
  const median = a => { const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const pct = f => fmtNum(Math.abs(f - 1) * 100) + ' %';

  /* Compare les séances réalisées depuis le dernier ajustement à ce que le plan attendait.
     Retourne null (rien à changer) ou { pace, vol, learnedEasy, reasons }.
     `missed` : tenir compte aussi des séances manquées (vérifié à l'ouverture, pas pendant qu'on entre ses séances). */
  function evaluate(plan, missed) {
    const g = plan.goal, t = today(), adj = g.adj || {}, since = adj.at || '';
    if (diffDays(g.raceDate, t) < 10) return null;                       // on ne touche plus à l'affûtage
    let ref; try { ref = generatePlan(g); } catch (e) { return null; }
    const exp = new Map(); ref.weeks.forEach(w => w.sessions.forEach(s => exp.set(s.id, s)));
    const es = entries(plan).filter(e => e.s.type !== 'race' && e.s.date > since);
    const recent = es.filter(e => e.done).slice(-6);
    const timed = recent.filter(e => e.log.distance > 0 && e.log.duration > 0);
    const feels = recent.filter(e => e.log.feel > 0).map(e => e.log.feel);
    const feel = feels.length ? feels.reduce((a, b) => a + b, 0) / feels.length : 3;
    const hard = feels.length >= 3 && feel <= 2;
    let pace = adj.pace > 0 ? adj.pace : 1, vol = adj.vol > 0 ? adj.vol : 1, learnedEasy = g.learnedEasy || 0;
    const reasons = [];

    // allures
    if (!ref.paces) {
      const easy = timed.filter(e => e.s.type === 'easy' || e.s.type === 'long').map(e => e.log.duration / e.log.distance).filter(p => p > 150 && p < 900);
      if (easy.length >= 3) { learnedEasy = Math.round(median(easy)); reasons.push('Allures calculées à partir de tes sorties faciles (' + fmtPace(learnedEasy) + ').'); }
    } else {
      const ratios = timed.map(e => { const x = exp.get(e.s.id); return x && x.pace > 0 ? (e.log.duration / e.log.distance) / x.pace : 0; }).filter(r => r > 0.6 && r < 1.6);
      if (hard) { pace *= 1.02; reasons.push('Tes dernières séances étaient très dures : allures ralenties de 2 %.'); }
      else if (ratios.length >= 3) {
        const med = median(ratios);
        if (med <= 0.97 && feel >= 3) { const st = clamp((1 - med) / 2, 0.01, 0.03); pace *= 1 - st; reasons.push('Tu cours plus vite que prévu en te sentant bien : allures accélérées de ' + pct(1 - st) + '.'); }
        else if (med >= 1.04 && feel <= 3.5) { const st = clamp((med - 1) / 2, 0.01, 0.03); pace *= 1 + st; reasons.push('Tes séances sont plus lentes que prévu : allures ralenties de ' + pct(1 + st) + '.'); }
      }
    }

    // volume
    const lim = addDays(t, -2), from = addDays(t, -21);                 // 2 jours de grâce pour entrer ses séances
    const due = es.filter(e => e.s.date <= lim && e.s.date >= from), doneDue = due.filter(e => e.done);
    const withKm = recent.filter(e => e.log.distance > 0);
    const kmRatio = withKm.length >= 3 ? withKm.reduce((a, e) => a + e.log.distance, 0) / withKm.reduce((a, e) => a + e.s.km, 0) : 1;
    const completion = due.length ? doneDue.length / due.length : 1;
    if (hard || (missed && due.length >= 4 && completion < 0.6)) {
      vol *= 0.92; reasons.push((hard ? 'Pour récupérer' : 'Plusieurs séances manquées') + ' : volume des prochaines semaines réduit de 8 %.');
    } else if (recent.length >= 3 && completion >= 0.85 && feel >= 3) {
      let up = 0;
      if (kmRatio >= 1.08) up = clamp((kmRatio - 1) / 2, 0.03, 0.08);
      else if (feels.length >= 3 && feel >= 4.5) up = 0.04;
      if (up) { vol *= 1 + up; reasons.push((kmRatio >= 1.08 ? 'Tu cours plus de km que prévu' : 'Tes séances passent très bien') + ' : volume des prochaines semaines augmenté de ' + pct(1 + up) + '.'); }
    }

    pace = clamp(pace, 0.85, 1.12); vol = clamp(vol, 0.8, 1.2);
    const same = Math.abs(pace - (adj.pace || 1)) < 1e-4 && Math.abs(vol - (adj.vol || 1)) < 1e-4 && learnedEasy === (g.learnedEasy || 0);
    return same || !reasons.length ? null : { pace, vol, learnedEasy, reasons };
  }

  /* Regénère le plan avec ces réglages et remplace seulement les séances à venir non cochées. */
  function rebuild(plan, goal, entry) {
    const fresh = generatePlan(goal), t = today();
    const weeks = plan.weeks.map((w, i) => {
      const nw = fresh.weeks[i] || { sessions: [] };
      const sessions = w.sessions.map(s => {
        const l = getLog(plan.id, s.id);
        return s.date > t && !(l && l.done) ? (nw.sessions.find(x => x.id === s.id) || s) : s;
      });
      return Object.assign({}, w, { sessions, km: Math.round(sessions.reduce((a, s) => a + s.km, 0) * 10) / 10 });
    });
    return put(Object.assign({}, plan, { goal, paces: fresh.paces, warnings: fresh.warnings, weeks, history: (plan.history || []).concat([entry]).slice(-20) }));
  }

  function autoAdjust(missed) {
    const plan = activePlan();
    if (!plan || plan.goal.auto === false) return null;
    const ev = evaluate(plan, missed); if (!ev) return null;
    const old = plan.goal.adj || {};
    const goal = Object.assign({}, plan.goal, { adj: { pace: ev.pace, vol: ev.vol, at: today() }, learnedEasy: ev.learnedEasy });
    rebuild(plan, goal, { at: today(), text: ev.reasons.join(' '), from: { pace: old.pace || 1, vol: old.vol || 1, learnedEasy: plan.goal.learnedEasy || 0 } });
    return ev.reasons.join(' ');
  }
  function undoAdjust() {
    const plan = activePlan(), h = plan && (plan.history || []).slice(-1)[0];
    if (!h || !h.from) return false;
    const goal = Object.assign({}, plan.goal, { adj: { pace: h.from.pace, vol: h.from.vol, at: today() }, learnedEasy: h.from.learnedEasy || 0 });
    rebuild(plan, goal, { at: today(), text: 'Dernier ajustement annulé.' });
    return true;
  }
  function setAuto(on) { const plan = activePlan(); if (plan) put(Object.assign({}, plan, { goal: Object.assign({}, plan.goal, { auto: !!on }) })); }

  function toCSV(plan) {
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['date', 'semaine', 'seance', 'type', 'km_prevus', 'completee', 'distance_km', 'temps_s', 'allure', 'fc_moy', 'denivele_m', 'ressenti', 'lien', 'note'].join(',')];
    for (const e of entries(plan)) {
      const l = e.log || {};
      rows.push([e.s.date, e.week.n, q(e.s.title), q(TYPES[e.s.type] || e.s.type), e.s.km, e.done ? 'oui' : 'non', l.distance || '', l.duration || '',
        l.distance > 0 && l.duration > 0 ? q(fmtPace(l.duration / l.distance)) : '', l.hr || '', l.elev || '', l.feel || '', q(l.url || ''), q(l.note || '')].join(','));
    }
    return rows.join('\r\n');
  }

  function init() {
    loadCache();
    if (connected()) sync();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', sync);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && connected()) sync(); });
    }
  }

  return { init, connect, disconnect, connected, login, repo, sync, onChange: f => listeners.push(f), status: () => status,
    DIST, LEVELS, DAYS, PHASES, TYPES, DEF_WEEKLY, DEFAULT_REPO,
    generatePlan, computePaces, plans, activePlan, createPlan, deletePlan, getLog, saveLog, setDone, hasStats, clearStats, entries, summary, toCSV, evaluate, autoAdjust, undoAdjust, setAuto,
    esc, uid, today, toDate, addDays, diffDays, weekday, fmtDate, fmtDay, fmtShort, fmtNum, fmtKm, fmtDur, fmtClock, fmtPace, num, hms, splitHms,
    _merge: merge, _reset: () => { data = blank(); } };
})();
if (typeof module !== 'undefined') module.exports = JC;
