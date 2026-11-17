/* FAPO 007 – cashflow slev: výpočetní jádro (bez závislosti na DOM) */
(function (root) {
  'use strict';

  var WINTER = ['BUNDY','KALHOTY','OVERALY','KABÁTY','VESTY','PLÁŠTĚNKY','MIKINY','SVETRY','ROLÁKY','TERMOPRÁDLO',
    'ČEPICE','RUKAVICE','NÁKRČNÍKY','PONOŽKY','ČELENKY','KUKLY','ŠÁLY','KLOBOUKY','HELMY','LYŽAŘSKÉ','BĚŽKY - LYŽE',
    'BĚŽKY - HŮLKY','BĚŽKY - BOTY','SJEZD - LYŽE'];
  var SUMMER = ['TRIČKA','LEGÍNY','PODPRSENKY','ŠATY','SUKNĚ','PLAVKY','KOŠILE','TÍLKA','KRAŤASY','KŠILTOVKY'];

  function num(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    var n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
  }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function trimKeys(row) {
    var o = {};
    for (var k in row) { if (Object.prototype.hasOwnProperty.call(row, k)) o[k.trim()] = row[k]; }
    return o;
  }
  function pad7(k) { k = str(k); return /^\d+$/.test(k) && k.length < 7 ? ('0000000' + k).slice(-7) : k; }

  /* ---------- datumy (UTC, bez časových pásem) ---------- */
  function parseDate(s) { var p = String(s).slice(0, 10).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function fmtDate(t) { var d = new Date(t); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  var DAY = 86400000;
  function dowMon(t) { return (new Date(t).getUTCDay() + 6) % 7; }   // 0 = pondělí

  /* ---------- sestavení položek z ceníku a skladu ---------- */
  function buildItems(cenikRows, skladRows) {
    var cen = {};
    cenikRows.forEach(function (r0) {
      var r = trimKeys(r0); var k = pad7(r['Kód zboží']); if (!k) return;
      cen[k] = { d1: num(r['D1 s DPH']), pc: num(r['PC s DPH']), nc: num(r['NC']), dod: str(r['Dodavatel']), znacka: str(r['Značka / výrobce']) };
    });
    var map = {}, noCenik = 0;
    skladRows.forEach(function (r0) {
      var r = trimKeys(r0); var k = pad7(r['Kód zboží']); var st = num(r['Stav']);
      if (!k || st <= 0) return;
      var it = map[k];
      if (!it) {
        var c = cen[k];
        if (!c) noCenik++;
        c = c || { d1: 0, pc: 0, nc: 0, dod: '', znacka: '' };
        var skPc = num(r['PC s DPH']);
        it = map[k] = {
          kod: k, nazev: str(r['Název']), znacka: str(r['Značka / výrobce']) || c.znacka, tema: str(r['Téma']),
          skup: str(r['Skup.']), pods: str(r['Pods.']), sezona: str(r['Název sezóny']),
          dod: str(r['Dodavatel']) || c.dod, ks: 0, vel: [],
          outlet: c.d1 > 0 ? c.d1 : (skPc > 0 ? skPc : c.pc), moc: c.pc, nc: c.nc,
          outletZdroj: c.d1 > 0 ? 'D1' : (skPc > 0 ? 'sklad' : 'MOC')
        };
        it.komise = /komise/i.test(it.dod);
        it.typ = it.komise ? 'Komise' : 'Vlastní';
      }
      it.ks += st;
      var v = str(r['Velikost']); if (v) it.vel.push(v);
    });
    var list = Object.keys(map).map(function (k) { var it = map[k]; it.vel = it.vel.join(', '); return it; });
    list.sort(function (a, b) { return a.kod < b.kod ? -1 : 1; });
    return { items: list, noCenik: noCenik };
  }

  /* ---------- kalibrace prodejnosti z exportu prodejů (volitelné) ---------- */
  function calibrate(items, salesRows, pokladna) {
    var sold = {}, dmin = Infinity, dmax = -Infinity, totalSold = 0;
    salesRows.forEach(function (r0) {
      var r = trimKeys(r0);
      if (pokladna && (str(r['POKLADNA']) === '' || num(r['POKLADNA']) !== num(pokladna))) return;
      var q = num(r['MNOZSTVI']);
      var z = str(r['ZNACKA']) || '?';
      sold[z] = (sold[z] || 0) + q; totalSold += q;
      var d = r['DATUM'];
      var t = d instanceof Date ? Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) : parseDate(d);
      if (!isNaN(t)) { if (t < dmin) dmin = t; if (t > dmax) dmax = t; }
    });
    var weeks = isFinite(dmin) ? Math.max(1, ((dmax - dmin) / DAY + 1) / 7) : 6;
    var stock = {}, totStock = 0;
    items.forEach(function (it) { stock[it.znacka] = (stock[it.znacka] || 0) + it.ks; totStock += it.ks; });
    var stG = totalSold / Math.max(1, totalSold + totStock);
    var K = 5, out = {};
    Object.keys(stock).forEach(function (z) {
      var s = Math.max(0, sold[z] || 0);
      var st = (s + K * stG) / (s + stock[z] + K);
      out[z] = 1 - Math.pow(1 - Math.min(.99, st), 1 / weeks);
    });
    return { byBrand: out, weeks: weeks, from: dmin, to: dmax, totalSold: totalSold, globalWeekly: 1 - Math.pow(1 - Math.min(.99, stG), 1 / weeks) };
  }

  /* ---------- výchozí nastavení ---------- */
  function defaults() {
    return {
      end: '2027-01-31',
      elasticity: 2.5, spread: 1.0,
      baseDisc: 0.09,               // dnešní průměrná ruční sleva na pokladně
      baseHazardWeek: 0.025,        // týdenní podíl skladu, který se prodá bez akce
      brandHazard: 'ON=10',         // výjimky: "Značka=% týdně, ..."
      cap: 25, floorH: 0.008,
      dow: [0.46, 0.53, 0.43, 0.68, 0.77, 2.23, 1.9],
      events: [
        { od: '2026-11-17', do: '2026-11-17', mult: 1, asDow: 6, label: 'státní svátek (jako neděle)' },
        { od: '2026-11-27', do: '2026-11-29', mult: 1.4, label: 'Black Friday víkend' },
        { od: '2026-12-12', do: '2026-12-23', mult: 1.4, label: 'předvánoční týdny' },
        { od: '2026-12-24', do: '2026-12-24', mult: 0.4, label: 'Štědrý den (ověřit)' },
        { od: '2026-12-25', do: '2026-12-25', mult: 0, label: 'zavřeno (ověřit)' },
        { od: '2026-12-26', do: '2026-12-30', mult: 1.3, label: 'mezi svátky' },
        { od: '2026-12-31', do: '2026-12-31', mult: 0.5, label: 'Silvestr' },
        { od: '2027-01-01', do: '2027-01-01', mult: 0, label: 'zavřeno (ověřit)' }
      ],
      seasWinter: [0.9, 1.25, 1.4],   // listopad, prosinec, leden
      seasSummer: [0.7, 0.7, 0.7],
      fixedMonthly: 0,                // měsíční fixní náklady pop-upu (nájem, lidé) bez DPH
      salvagePct: 0,                  // % z NC, za které se odprodá zbytek VLASTNÍHO zboží po konci (en bloc)
      deductKomise: true              // v cashflow odečíst úhradu dodavatelům za prodanou komisi (NC)
    };
  }

  function parseBrandHazard(s) {
    var o = {};
    String(s || '').split(/[,;]+/).forEach(function (p) {
      var m = p.split('='); if (m.length === 2) { var v = num(m[1]); if (m[0].trim() && v > 0) o[m[0].trim().toLowerCase()] = v / 100; }
    });
    return o;
  }

  /* ---------- kampaně ---------- */
  function emptyCampaign() {
    return { id: 'c' + Math.random().toString(36).slice(2, 8), name: '', od: '', do: '', disc: 20,
      znacky: [], znackyEx: [], temata: [], skupiny: [], podskupiny: [], sezony: [], typy: [] };
  }
  function matches(c, it) {
    if (c.znackyEx && c.znackyEx.length && c.znackyEx.indexOf(it.znacka) >= 0) return false;
    if (c.znacky.length && c.znacky.indexOf(it.znacka) < 0) return false;
    if (c.temata.length && c.temata.indexOf(it.tema) < 0) return false;
    if (c.skupiny.length && c.skupiny.indexOf(it.skup) < 0) return false;
    if (c.podskupiny.length && c.podskupiny.indexOf(it.pods) < 0) return false;
    if (c.sezony.length && c.sezony.indexOf(it.sezona) < 0) return false;
    if (c.typy && c.typy.length && c.typy.indexOf(it.typ || (it.komise ? 'Komise' : 'Vlastní')) < 0) return false;
    return true;
  }

  function seasonClass(it) {
    if (/^SS/i.test(it.sezona) || SUMMER.indexOf(it.pods) >= 0) return 'summer';
    if (it.znacka === 'ON' || it.skup === 'BOTY' || it.skup === 'OSTATNÍ') return 'neutral';
    if (WINTER.indexOf(it.pods) >= 0) return 'winter';
    return 'neutral';
  }

  /* ---------- simulace ---------- */
  // opts: { elasticity, calib }
  function simulate(items, campaigns, S, startStr, opts) {
    opts = opts || {};
    var e = opts.elasticity != null ? opts.elasticity : S.elasticity;
    var vat = 1.21;
    var t0 = parseDate(startStr), t1 = parseDate(S.end);
    var nDays = Math.max(0, Math.round((t1 - t0) / DAY) + 1);
    var bh = parseBrandHazard(S.brandHazard);
    var n = items.length;
    var rem = new Float64Array(n), price = new Float64Array(n), nc = new Float64Array(n), hw = new Float64Array(n);
    var cls = new Array(n);
    for (var i = 0; i < n; i++) {
      var it = items[i];
      rem[i] = it.ks; price[i] = it.outlet; nc[i] = it.nc; cls[i] = seasonClass(it);
      var h;
      if (opts.calib && opts.calib.byBrand[it.znacka] != null) h = opts.calib.byBrand[it.znacka];
      else h = S.baseHazardWeek;
      var ov = bh[String(it.znacka).toLowerCase()];
      if (ov != null && !(opts.calib && opts.calib.byBrand[it.znacka] != null)) h = ov;
      hw[i] = Math.max(S.floorH, h);
    }
    // aktivní kampaně
    var act = campaigns.filter(function (c) { return c.od && c.do && c.disc > 0; }).map(function (c) {
      return { c: c, from: parseDate(c.od), to: parseDate(c.do), d: c.disc / 100, idx: items.map(function (it, k) { return matches(c, it) ? k : -1; }).filter(function (k) { return k >= 0; }) };
    });
    var dowSum = S.dow.reduce(function (a, b) { return a + b; }, 0) / 7;
    var evs = S.events.map(function (ev) { return { a: parseDate(ev.od), b: parseDate(ev.do), m: ev.mult, as: (ev.asDow === 0 || ev.asDow) ? ev.asDow : null }; });

    var days = [], byC = {}, cumRev = 0, cumCost = 0;
    act.forEach(function (a) { byC[a.c.id] = { ks: 0, rev: 0, cost: 0 }; });
    byC['_none'] = { ks: 0, rev: 0, cost: 0 };
    var discArr = new Float64Array(n), cidArr = new Array(n);
    var soldPer = new Float64Array(n);
    var isK = items.map(function (it) { return !!it.komise; });
    var TY = { own: { rev: 0, cost: 0, ks: 0, left: 0, leftNC: 0 }, kom: { rev: 0, cost: 0, ks: 0, left: 0, leftNC: 0 } };
    var fixedPerDay = S.fixedMonthly * 12 / 365;

    for (var d = 0; d < nDays; d++) {
      var t = t0 + d * DAY;
      discArr.fill(0); for (i = 0; i < n; i++) cidArr[i] = '_none';
      act.forEach(function (a) {
        if (t >= a.from && t <= a.to) {
          for (var q = 0; q < a.idx.length; q++) { var k = a.idx[q]; if (a.d > discArr[k]) { discArr[k] = a.d; cidArr[k] = a.c.id; } }
        }
      });
      var tf = S.dow[dowMon(t)] / dowSum;
      for (var q = 0; q < evs.length; q++) if (t >= evs[q].a && t <= evs[q].b) {
        tf = evs[q].as != null ? S.dow[evs[q].as] / dowSum * evs[q].m : tf * evs[q].m;
      }
      var mo = new Date(t).getUTCMonth() + 1; var mi = mo === 11 ? 0 : (mo === 12 ? 1 : 2);
      var rev = 0, cost = 0, ks = 0, remNC = 0, remOut = 0, kRev = 0, kCost = 0;
      for (i = 0; i < n; i++) {
        if (rem[i] <= 1e-9) continue;
        var eff = Math.max(discArr[i], S.baseDisc);
        var up = Math.min(Math.pow((1 - eff) / (1 - S.baseDisc), -e), S.cap);
        var sf = cls[i] === 'winter' ? S.seasWinter[mi] : (cls[i] === 'summer' ? S.seasSummer[mi] : 1);
        var hd = Math.min(.6, hw[i] / 7 * tf * sf * up);
        var sold = rem[i] * hd; rem[i] -= sold; soldPer[i] += sold;
        var r = sold * price[i] * (1 - eff), c = sold * nc[i] * vat;
        rev += r; cost += c; ks += sold;
        var ty = isK[i] ? TY.kom : TY.own; ty.rev += r; ty.cost += c; ty.ks += sold;
        if (isK[i]) { kRev += r; kCost += c; }
        var cc = byC[cidArr[i]]; cc.ks += sold; cc.rev += r; cc.cost += c;
      }
      for (i = 0; i < n; i++) { remNC += rem[i] * nc[i]; remOut += rem[i] * price[i]; }
      cumRev += rev; cumCost += cost;
      var remKs = 0; for (i = 0; i < n; i++) remKs += rem[i];
      days.push({ t: t, rev: rev, komNC: kCost / vat, cfIn: rev / vat - (S.deductKomise ? kCost / vat : 0), revNoVat: rev / vat, cost: cost, ks: ks, remKs: remKs, remNC: remNC, remOut: remOut, fixed: fixedPerDay, cumRev: cumRev });
    }
    var leftKs = 0, leftNC = 0, leftOut = 0;
    for (i = 0; i < n; i++) { leftKs += rem[i]; leftNC += rem[i] * nc[i]; leftOut += rem[i] * price[i]; }
    for (i = 0; i < n; i++) { var tt = isK[i] ? TY.kom : TY.own; tt.left += rem[i]; tt.leftNC += rem[i] * nc[i]; }
    var totRev = cumRev, totCost = cumCost;
    var salvage = TY.own.leftNC * (S.salvagePct / 100);   // NC bez DPH, jen vlastní zboží (komise se vrací)
    var cashIn = days.reduce(function (a, d) { return a + d.cfIn; }, 0);
    return {
      days: days, byCampaign: byC, campaigns: act.map(function (a) { return a.c; }),
      matched: act.map(function (a) { var ks = 0, v = 0; a.idx.forEach(function (k) { ks += items[k].ks; v += items[k].ks * items[k].outlet; }); return { id: a.c.id, models: a.idx.length, ks: ks, val: v }; }),
      byTyp: TY, totals: { cash: cashIn - fixedPerDay * nDays + salvage, komPay: TY.kom.cost / vat, rev: totRev, revNoVat: totRev / vat, cost: totCost, gross: totRev / vat - totCost / vat, soldKs: items.reduce(function (a, it) { return a + it.ks; }, 0) - leftKs, leftKs: leftKs, leftNC: leftNC, leftOut: leftOut, salvage: salvage, fixed: fixedPerDay * nDays },
      rem: rem, soldPer: soldPer
    };
  }

  var api = { num: num, buildItems: buildItems, calibrate: calibrate, defaults: defaults, emptyCampaign: emptyCampaign,
    matches: matches, simulate: simulate, parseDate: parseDate, fmtDate: fmtDate, seasonClass: seasonClass, DAY: DAY, dowMon: dowMon, pad7: pad7 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FapoModel = api;
})(typeof self !== 'undefined' ? self : this);
