/* gpx-analyze.js - client-side port of gpx_grade.py.
 * Pure functions + HTML/SVG renderers. Runs in the browser (and Node for
 * testing). Mirrors the Python logic so results match the desktop app. */
(function (root) {
  "use strict";

  // Fixed analysis parameters (same values as the desktop app).
  var FIXED = { min_section: 152.4, max_gap: 100.0, merge_gap: 804.672, step: 25.0, smooth: 125.0 };

  // ---- parsing --------------------------------------------------------- //
  function parseGPX(text) {
    var name = null;
    var m = text.match(/<trk>[\s\S]*?<name>([^<]+)<\/name>/);
    if (!m) m = text.match(/<name>([^<]+)<\/name>/);
    if (m) name = m[1].trim();
    var pts = [];
    var re = /<trkpt\b[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
    var mm;
    while ((mm = re.exec(text))) {
      var ele = mm[3].match(/<ele>([^<]+)<\/ele>/);
      if (!ele) continue;
      pts.push({ lat: parseFloat(mm[1]), lon: parseFloat(mm[2]), ele: parseFloat(ele[1]) });
    }
    return { pts: pts, name: name };
  }

  // ---- geometry / math ------------------------------------------------- //
  function haversine(a, b) {
    var R = 6371000.0, rad = Math.PI / 180;
    var lat1 = a.lat * rad, lat2 = b.lat * rad;
    var dlat = (b.lat - a.lat) * rad, dlon = (b.lon - a.lon) * rad;
    var h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function cumulative(pts) {
    var cum = [0.0];
    for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    return cum;
  }

  function resample(cum, values, step) {
    var total = cum[cum.length - 1], xs = [], x = 0.0;
    while (x < total) { xs.push(x); x += step; }
    if (xs.length === 0) xs = [0.0];
    var out = [], j = 0;
    for (var k = 0; k < xs.length; k++) {
      var xv = xs[k];
      while (j < cum.length - 2 && cum[j + 1] < xv) j++;
      var x0 = cum[j], x1 = cum[j + 1], v0 = values[j], v1 = values[j + 1];
      var frac = x1 === x0 ? 0 : (xv - x0) / (x1 - x0);
      out.push(v0 + frac * (v1 - v0));
    }
    return { xs: xs, out: out };
  }

  function smooth(values, window) {
    if (window <= 1) return values.slice();
    var half = Math.floor(window / 2), out = [], n = values.length;
    for (var i = 0; i < n; i++) {
      var lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1), s = 0;
      for (var j = lo; j < hi; j++) s += values[j];
      out.push(s / (hi - lo));
    }
    return out;
  }

  function elevAt(xs, values, x) {
    if (x <= xs[0]) return values[0];
    if (x >= xs[xs.length - 1]) return values[values.length - 1];
    var lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    var x0 = xs[lo], x1 = xs[hi];
    if (x1 === x0) return values[lo];
    var t = (x - x0) / (x1 - x0);
    return values[lo] + t * (values[hi] - values[lo]);
  }

  function findSections(xs, grade, threshold, uphill, minLen, maxGap, step) {
    var res = [], n = grade.length, i = 0;
    while (i < n) {
      var cond = uphill ? grade[i] >= threshold : grade[i] <= -threshold;
      if (!cond) { i++; continue; }
      var j = i, gap = 0, lastGood = i;
      while (j < n) {
        var c = uphill ? grade[j] >= threshold : grade[j] <= -threshold;
        if (c) { lastGood = j; gap = 0; } else { gap += step; if (gap > maxGap) break; }
        j++;
      }
      var startX = xs[i], endIdx = Math.min(lastGood + 1, n - 1), endX = xs[endIdx];
      var length = endX - startX, s = 0;
      for (var k = i; k <= lastGood; k++) s += grade[k];
      var de = length * (s / Math.max(1, lastGood + 1 - i)) / 100;
      if (length >= minLen) res.push([startX, endX, length, de, length ? 100 * de / length : 0]);
      i = j;
    }
    return res;
  }

  function mergeSections(secs, xs, ele, maxBetween) {
    if (!secs.length) return secs.slice();
    var out = [secs[0].slice()];
    for (var i = 1; i < secs.length; i++) {
      var s = secs[i], prev = out[out.length - 1];
      if (s[0] - prev[1] < maxBetween) {
        var start = prev[0], end = s[1], length = end - start;
        var de = elevAt(xs, ele, end) - elevAt(xs, ele, start);
        out[out.length - 1] = [start, end, length, de, length ? 100 * de / length : 0];
      } else out.push(s.slice());
    }
    return out;
  }

  function axisTicks(xmaxM, units, maxTicks) {
    maxTicks = maxTicks || 13;
    var toDisp = units === "mi" ? 0.000621371 : 0.001, span = xmaxM * toDisp;
    var steps = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100], step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) { if (span / steps[i] <= maxTicks) { step = steps[i]; break; } }
    var ticks = [], k = 0;
    while (step * k <= span + 1e-9) { ticks.push((step * k) / toDisp); k++; }
    return { ticks: ticks, step: step };
  }

  // ---- units / formatting --------------------------------------------- //
  function comma(x) { return Math.round(x).toLocaleString("en-US"); }
  function signed(x) { return (x < 0 ? "-" : "+") + Math.abs(Math.round(x)).toLocaleString("en-US"); }

  function unitFuncs(units) {
    if (units === "mi") {
      return {
        distLbl: function (m) { return (m * 0.000621371).toFixed(2) + " mi"; },
        dshort: function (m) { return (m * 0.000621371).toFixed(2); },
        elev: function (m) { return m * 3.28084; },
        eunit: "ft", ulabel: "mi"
      };
    }
    return {
      distLbl: function (m) { return (m / 1000).toFixed(2) + " km"; },
      dshort: function (m) { return (m / 1000).toFixed(2); },
      elev: function (m) { return m; },
      eunit: "m", ulabel: "km"
    };
  }

  function fmtLen(m, units) {
    return units === "mi" ? comma(m * 3.28084) + " ft" : comma(m) + " m";
  }
  function fmtLenPair(m, units) {
    return units === "mi"
      ? (m * 0.000621371).toFixed(2) + " mi (" + comma(m * 3.28084) + " ft)"
      : (m / 1000).toFixed(2) + " km (" + comma(m) + " m)";
  }

  function gradeColor(g) {
    var a = Math.abs(g);
    if (g < 0) { if (a < 4) return "#5aa9e6"; if (a < 8) return "#3d7fc4"; return "#274b8f"; }
    if (a < 3) return "#2e8b57";
    if (a < 6) return "#8fbf3f";
    if (a < 9) return "#e0a021";
    if (a < 12) return "#e8641c";
    return "#d21f2b";
  }

  // ---- compute --------------------------------------------------------- //
  function buildOpts(o) {
    o = o || {};
    return {
      units: o.units === "km" ? "km" : "mi",
      uphill_threshold: o.uphill_threshold != null ? +o.uphill_threshold : 8.0,
      downhill_threshold: o.downhill_threshold != null ? +o.downhill_threshold : 5.0,
      min_section: FIXED.min_section, max_gap: FIXED.max_gap,
      merge_gap: FIXED.merge_gap, step: FIXED.step, smooth: FIXED.smooth
    };
  }

  function compute(text, opts) {
    opts = buildOpts(opts);
    var parsed = parseGPX(text), pts = parsed.pts;
    if (pts.length < 2) throw new Error("Need at least 2 track points with elevation.");
    var cum = cumulative(pts), total = cum[cum.length - 1];
    var gain = 0, loss = 0;
    for (var i = 1; i < pts.length; i++) {
      var de = pts[i].ele - pts[i - 1].ele;
      if (de > 0) gain += de; else loss += -de;
    }
    var start = pts[0].ele, end = pts[pts.length - 1].ele, net = end - start;
    var rs = resample(cum, pts.map(function (p) { return p.ele; }), opts.step);
    var xs_e = rs.xs, eles = rs.out;
    var window = Math.max(1, Math.round(opts.smooth / opts.step));
    if (window % 2 === 0) window++;
    var sm = smooth(eles, window), grade = [];
    for (var g = 0; g < sm.length - 1; g++) grade.push((sm[g + 1] - sm[g]) / opts.step * 100);
    var xs = xs_e.slice(0, grade.length);
    var steepUp = null, steepDown = null;
    if (grade.length > 2) {
      var imax = 1, imin = 1;
      for (var k = 1; k < grade.length - 1; k++) {
        if (grade[k] > grade[imax]) imax = k;
        if (grade[k] < grade[imin]) imin = k;
      }
      steepUp = [grade[imax], xs[imax]];
      steepDown = [grade[imin], xs[imin]];
    }
    var up = findSections(xs, grade, opts.uphill_threshold, true, opts.min_section, opts.max_gap, opts.step);
    var down = findSections(xs, grade, opts.downhill_threshold, false, opts.min_section, opts.max_gap, opts.step);
    up = mergeSections(up, xs_e, sm, opts.merge_gap);
    down = mergeSections(down, xs_e, sm, opts.merge_gap);
    return {
      name: parsed.name, n_points: pts.length, total_dist_m: total,
      start_ele_m: start, end_ele_m: end, net_m: net, gain_m: gain, loss_m: loss,
      avg_grade: total ? 100 * net / total : 0, avg_uphill_grade: total ? 100 * gain / total : 0,
      steep_up: steepUp, steep_down: steepDown, xs_e: xs_e, profile_ele_m: sm,
      grade: grade, up_sections: up, down_sections: down, opts: opts
    };
  }

  // ---- rendering ------------------------------------------------------- //
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function svgProfile(d) {
    var o = d.opts, u = unitFuncs(o.units), UP = "#d21f2b", DOWN = "#2f6feb";
    var W = 900, H = 300, ml = 54, mr = 20, mt = 30, mb = 54;
    var pw = W - ml - mr, ph = H - mt - mb;
    var xs = d.xs_e, sm = d.profile_ele_m, grade = d.grade;
    if (xs.length < 2 || !grade.length) return '<svg viewBox="0 0 ' + W + ' ' + H + '"></svg>';
    var xmax = xs[xs.length - 1], emin = Math.min.apply(null, sm), emax = Math.max.apply(null, sm);
    if (emax - emin < 1) emax = emin + 1;
    var pad = (emax - emin) * 0.08; emin -= pad; emax += pad;
    function px(x) { return ml + pw * (x / xmax); }
    function py(e) { return mt + ph * (1 - (e - emin) / (emax - emin)); }
    var p = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet" style="font-family:Segoe UI,Arial,sans-serif">'];
    var base = py(emin);
    for (var i = 0; i < grade.length; i++) {
      var x0 = px(xs[i]).toFixed(1), x1 = px(xs[i + 1]).toFixed(1);
      var y0 = py(sm[i]).toFixed(1), y1 = py(sm[i + 1]).toFixed(1);
      p.push('<polygon points="' + x0 + ',' + base.toFixed(1) + ' ' + x0 + ',' + y0 + ' ' + x1 + ',' + y1 + ' ' + x1 + ',' + base.toFixed(1) + '" fill="' + gradeColor(grade[i]) + '"/>');
    }
    for (var k = 0; k < 5; k++) {
      var e = emin + (emax - emin) * k / 4, y = py(e);
      p.push('<line x1="' + ml + '" y1="' + y.toFixed(1) + '" x2="' + (ml + pw) + '" y2="' + y.toFixed(1) + '" stroke="#e3e9ef"/>');
      p.push('<text x="' + (ml - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="#6b7785">' + u.elev(e).toFixed(0) + '</text>');
    }
    p.push('<text x="' + (ml - 40) + '" y="' + (mt - 14) + '" font-size="10" fill="#6b7785">' + u.eunit + '</text>');
    var line = [];
    for (var j = 0; j < sm.length; j++) line.push(px(xs[j]).toFixed(1) + ',' + py(sm[j]).toFixed(1));
    p.push('<polyline points="' + line.join(" ") + '" fill="none" stroke="#22303c" stroke-width="1.4"/>');
    var t = axisTicks(xmax, o.units).ticks;
    for (var ti = 0; ti < t.length; ti++) {
      var xp = px(t[ti]).toFixed(1);
      p.push('<line x1="' + xp + '" y1="' + (mt + ph) + '" x2="' + xp + '" y2="' + (mt + ph + 4) + '" stroke="#6b7785"/>');
      p.push('<text x="' + xp + '" y="' + (mt + ph + 16) + '" text-anchor="middle" font-size="10" fill="#6b7785">' + u.dshort(t[ti]) + '</text>');
    }
    p.push('<text x="' + (ml + pw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="#6b7785">distance (' + u.ulabel + ')</text>');
    var ends = d.up_sections.map(function (s) { return [s[1], UP]; })
      .concat(d.down_sections.map(function (s) { return [s[1], DOWN]; }));
    ends.forEach(function (m) {
      var xp = px(m[0]).toFixed(1);
      p.push('<line x1="' + xp + '" y1="' + mt + '" x2="' + xp + '" y2="' + (mt + ph) + '" stroke="' + m[1] + '" stroke-dasharray="3,3"/>');
      p.push('<text x="' + xp + '" y="' + (mt - 5) + '" text-anchor="middle" font-size="10" font-weight="bold" fill="' + m[1] + '">' + u.dshort(m[0]) + '</text>');
    });
    p.push("</svg>");
    return p.join("");
  }

  function card(value, label, color) {
    return '<div class="card"><div class="cval" style="color:' + (color || "#1f2933") + '">' +
      esc(value) + '</div><div class="clabel">' + esc(label) + '</div></div>';
  }

  function table(title, secs, d) {
    var o = d.opts, u = unitFuncs(o.units), rows = [];
    if (!secs.length) rows.push('<tr><td colspan="4" class="muted">(none)</td></tr>');
    secs.forEach(function (s) {
      rows.push("<tr><td>" + u.dshort(s[0]) + " – " + u.dshort(s[1]) + "</td>" +
        "<td class='r'>" + esc(fmtLenPair(s[2], o.units)) + "</td>" +
        "<td class='r'>" + signed(u.elev(s[3])) + "</td>" +
        "<td class='r'>" + s[4].toFixed(1) + "%</td></tr>");
    });
    return '<h2>' + esc(title) + '</h2><table><thead><tr><th>Range (' + u.ulabel +
      ')</th><th class="r">Length</th><th class="r">Elev chg (' + u.eunit +
      ')</th><th class="r">Avg grade</th></tr></thead><tbody>' + rows.join("") + '</tbody></table>';
  }

  function renderReport(d) {
    var o = d.opts, u = unitFuncs(o.units);
    var netColor = d.net_m < 0 ? "#d21f2b" : "#2e8b57";
    var cards = [
      card(u.distLbl(d.total_dist_m), "Total distance"),
      card(signed(u.elev(d.net_m)) + " " + u.eunit, "Net elevation", netColor),
      card(comma(u.elev(d.gain_m)) + " " + u.eunit, "Total climbing"),
      card((d.avg_grade >= 0 ? "+" : "") + d.avg_grade.toFixed(1) + "%", "Average grade")
    ];
    if (d.steep_up) {
      cards.push(
        card(d.steep_up[0].toFixed(1) + "%", "Steepest uphill @ " + u.dshort(d.steep_up[1]) + " " + u.ulabel, gradeColor(d.steep_up[0])),
        card(d.steep_down[0].toFixed(1) + "%", "Steepest downhill @ " + u.dshort(d.steep_down[1]) + " " + u.ulabel, gradeColor(d.steep_down[0])),
        card(comma(u.elev(d.loss_m)) + " " + u.eunit, "Total descent"),
        card(d.avg_uphill_grade.toFixed(1) + "%", "Avg uphill grade")
      );
    }
    var thr = fmtLen(o.min_section, o.units);
    var sub = d.n_points.toLocaleString("en-US") + " GPS points · units: " + u.ulabel + "/" + u.eunit;
    return '<h1>' + esc(d.name || "GPX Grade Analysis") + '</h1><p class="sub">' + sub + '</p>' +
      '<div class="cards">' + cards.join("") + '</div>' +
      '<h2>Elevation profile</h2><div class="panel">' + svgProfile(d) + '</div>' +
      table("Major steep uphill sections  (≥ " + o.uphill_threshold + "%, ≥ " + thr + ")", d.up_sections, d) +
      table("Major steep downhill sections  (≤ -" + o.downhill_threshold + "%, ≥ " + thr + ")", d.down_sections, d);
  }

  var api = { compute: compute, renderReport: renderReport, buildOpts: buildOpts };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GPX = api;
})(typeof window !== "undefined" ? window : this);
