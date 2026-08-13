// Genre dashboard — reads data/spotify-genres.json and draws it with D3.
// Same house style as home.js: strict IIFE, promise chains, panels start
// hidden and un-hide on success, failures are silent no-ops.
(function () {
  "use strict";

  if (!document.getElementById("music-body")) return;

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Categorical slots, in fixed order. Never cycled — past slot 6 a series
  // folds into OTHER rather than getting a generated hue. See css/music.css.
  var CAT = ["#b4490f", "#3f4f8f", "#6b8f21", "#a02d5e", "#a97400", "#0b7d9e"];
  var SEQ = ["#d69f79", "#c58353", "#b3652c", "#a14c11", "#88370b"];
  var OTHER = "#99917f";
  var DEEMPH = "#cfc7b6";
  var PAPER2 = "#fffdf8";

  var tooltip = document.getElementById("viz-tooltip");

  // ---------- helpers ----------

  function pct(n, dp) {
    if (n === null || n === undefined) return "—";
    return (n * 100).toFixed(dp === undefined ? 1 : dp) + "%";
  }

  function num(n, dp) {
    if (n === null || n === undefined) return "—";
    return n.toFixed(dp === undefined ? 0 : dp);
  }

  // Matches home.js's counter feel exactly (1300ms, ease-out cubic) without
  // depending on its [data-count] path, which fires before this fetch lands.
  function countUp(el, target, dp) {
    if (!el) return;
    var fixed = dp || 0;
    if (reducedMotion) {
      el.textContent = target.toFixed(fixed);
      return;
    }
    var duration = 1300;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (eased * target).toFixed(fixed);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function showTip(html, evt) {
    if (!tooltip) return;
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    moveTip(evt);
  }

  function moveTip(evt) {
    if (!tooltip || tooltip.hidden) return;
    var pad = 14;
    var w = tooltip.offsetWidth;
    var h = tooltip.offsetHeight;
    var x = evt.clientX + pad;
    var y = evt.clientY + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = evt.clientY - h - pad;
    tooltip.style.left = Math.max(8, x) + "px";
    tooltip.style.top = Math.max(8, y) + "px";
  }

  function hideTip() {
    if (tooltip) tooltip.hidden = true;
  }

  function bindTip(sel, htmlFn) {
    sel
      .on("mouseenter", function (evt, d) { showTip(htmlFn(d), evt); })
      .on("mousemove", moveTip)
      .on("mouseleave", hideTip);
  }

  function clear(id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = "";
    return el;
  }

  function widthOf(id) {
    var el = document.getElementById(id);
    return el ? Math.max(280, el.clientWidth) : 0;
  }

  // Families ranked by overall share, so slot assignment is stable and
  // meaningful rather than alphabetical.
  function rankFamilies(data) {
    var dist = (data.combined && data.combined.familyDistribution) || [];
    return dist
      .filter(function (d) { return d.family !== "Unclassified"; })
      .slice()
      .sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); })
      .map(function (d) { return d.family; });
  }

  // ---------- 0. headline + KPI row ----------

  function renderHeadline(data) {
    var c = data.combined;
    var m = c.metrics.genre;

    countUp(document.getElementById("fig-effective"), m.effectiveGenres || 0, 0);
    var inline = document.getElementById("fig-effective-inline");
    if (inline) inline.textContent = num(m.effectiveGenres);
    var totalEl = document.getElementById("fig-total");
    if (totalEl) totalEl.textContent = String(c.genresTotal);

    countUp(document.getElementById("kpi-genres"), c.genresTotal || 0, 0);
    countUp(document.getElementById("kpi-families"), countFamilies(c), 0);
    countUp(document.getElementById("kpi-artists"), c.artists || 0, 0);

    var top3 = document.getElementById("kpi-top3");
    if (top3) top3.textContent = pct(m.top3Share, 0);
  }

  function countFamilies(block) {
    return (block.familyDistribution || []).filter(function (d) {
      return d.family !== "Unclassified" && d.family !== "Other" && d.weight > 0;
    }).length;
  }

  // ---------- genre detail panel ----------
  //
  // One panel, opened from the constellation, the treemap or the table. Fixed
  // position so it doesn't matter where on the page the click came from.

  var genreLookup = {};   // genre -> row from combined.genres
  var neighbourLookup = {}; // genre -> [{id, weight}] from the co-occurrence graph
  var panelData = null;

  function buildGenreLookups(data) {
    (data.combined.genres || []).forEach(function (g) { genreLookup[g.name] = g; });
    (data.graph.links || []).forEach(function (l) {
      (neighbourLookup[l.source] = neighbourLookup[l.source] || []).push({ id: l.target, weight: l.weight });
      (neighbourLookup[l.target] = neighbourLookup[l.target] || []).push({ id: l.source, weight: l.weight });
    });
    Object.keys(neighbourLookup).forEach(function (k) {
      neighbourLookup[k].sort(function (a, b) { return b.weight - a.weight; });
    });
    panelData = data;
  }

  function openGenre(name) {
    var panel = document.getElementById("genre-panel");
    if (!panel || !panelData) return;
    var row = genreLookup[name];
    var examples = (panelData.genreExamples || {})[name] || [];

    document.getElementById("gp-name").textContent = name;
    document.getElementById("gp-family").textContent =
      (row && row.family) || (panelData.graph.nodes.filter(function (n) { return n.id === name; })[0] || {}).family || "—";
    document.getElementById("gp-share").textContent = row ? pct(row.share, 2) : "—";
    document.getElementById("gp-tracks").textContent = row ? String(row.tracks) : "—";

    var list = clear("gp-artists-list");
    if (examples.length) {
      examples.forEach(function (n) {
        var c = document.createElement("span");
        c.className = "chip";
        c.textContent = n;
        list.appendChild(c);
      });
    } else {
      var none = document.createElement("span");
      none.className = "chip";
      none.textContent = "no examples recorded";
      list.appendChild(none);
    }

    // Neighbouring genres are clickable, so the panel doubles as a way to walk
    // the graph without hunting for the dot.
    var nbrWrap = document.getElementById("gp-neighbours");
    var nbrList = clear("gp-neighbour-list");
    var nbrs = (neighbourLookup[name] || []).slice(0, 6);
    if (nbrs.length && nbrList) {
      nbrs.forEach(function (n) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = n.id;
        b.addEventListener("click", function () { openGenre(n.id); });
        nbrList.appendChild(b);
      });
      nbrWrap.hidden = false;
    } else if (nbrWrap) {
      nbrWrap.hidden = true;
    }

    panel.hidden = false;
    highlightTableRow(name);
  }

  function closeGenre() {
    var panel = document.getElementById("genre-panel");
    if (panel) panel.hidden = true;
    highlightTableRow(null);
  }

  function highlightTableRow(name) {
    var table = document.getElementById("genre-table");
    if (!table) return;
    table.querySelectorAll("tbody tr").forEach(function (tr) {
      tr.classList.toggle("is-selected", !!name && tr.getAttribute("data-genre") === name);
    });
  }

  (function wirePanelChrome() {
    var close = document.getElementById("gp-close");
    if (close) close.addEventListener("click", closeGenre);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeGenre();
    });
  })();

  // ---------- 1. constellation ----------

  var constellationState = { selected: null, data: null };

  function renderConstellation(data) {
    var holder = "constellation-holder";
    var width = widthOf(holder);
    if (!width) return;
    var el = document.getElementById("constellation-holder");
    var height = el.clientHeight || 560;

    // Seed from the previous layout if there is one, so a resize settles gently
    // instead of exploding and re-converging from random positions.
    var prev = constellationState.positions || {};
    var nodes = data.graph.nodes.map(function (n) {
      var c = Object.assign({}, n);
      var p = prev[n.id];
      if (p) { c.x = p.x * width; c.y = p.y * height; }
      return c;
    });
    var links = data.graph.links.map(function (l) { return Object.assign({}, l); });
    if (!nodes.length) return;

    var svg = d3.select("#constellation-svg")
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("width", width)
      .attr("height", height);
    svg.selectAll("*").remove();

    var maxW = d3.max(nodes, function (d) { return d.weight; }) || 1;
    var rScale = d3.scaleSqrt().domain([0, maxW]).range([2.5, 26]);
    // Colour encodes MAGNITUDE, not family. A 15-hue categorical scale fails
    // colourblind separation badly in an all-pairs form like this one, so
    // family is carried by spatial clustering and the hull labels instead.
    var seqScale = d3.scaleQuantile().domain(nodes.map(function (d) { return d.weight; })).range(SEQ);

    var families = rankFamilies(data);
    var famIndex = {};
    families.forEach(function (f, i) { famIndex[f] = i; });

    // Per-family anchors on a grid. A ring would strand every cluster on the
    // perimeter with neighbours touching and the middle empty; a grid gives
    // ~16 families room to actually separate.
    var famPresent = families.filter(function (f) {
      return nodes.some(function (n) { return n.family === f; });
    });
    var cols = Math.ceil(Math.sqrt(famPresent.length));
    var rows = Math.ceil(famPresent.length / cols);
    var padX = width * 0.1;
    var padY = height * 0.11;
    var cellW = (width - padX * 2) / cols;
    var cellH = (height - padY * 2) / rows;
    var anchors = {};
    famPresent.forEach(function (f, i) {
      anchors[f] = {
        x: padX + cellW * ((i % cols) + 0.5),
        y: padY + cellH * (Math.floor(i / cols) + 0.5),
      };
    });

    var hullLayer = svg.append("g");
    var linkLayer = svg.append("g").attr("stroke-opacity", 0.5);
    var nodeLayer = svg.append("g");
    var labelLayer = svg.append("g");

    var maxEdge = d3.max(links, function (d) { return d.weight; }) || 1;
    var edgeScale = d3.scaleLinear().domain([0, maxEdge]).range([0.4, 2.2]);

    var link = linkLayer.selectAll("line").data(links).join("line")
      .attr("class", "link-line")
      .attr("stroke-width", function (d) { return edgeScale(d.weight); });

    var node = nodeLayer.selectAll("circle").data(nodes).join("circle")
      .attr("class", "node-circle")
      .attr("r", function (d) { return rScale(d.weight); })
      .attr("fill", function (d) { return seqScale(d.weight); })
      .style("cursor", "pointer");

    node.on("click", function (evt, d) { openGenre(d.id); });

    bindTip(node, function (d) {
      return "<strong>" + d.id + "</strong>" +
        "<span class='tt-meta'>" + d.family + " · " + d.artists + " artist" +
        (d.artists === 1 ? "" : "s") + " · " + d.degree + " link" +
        (d.degree === 1 ? "" : "s") + "<br>click to see the artists</span>";
    });

    // The family anchor has to outweigh the link force, or cross-family links
    // drag every cluster into one blob and the picture says nothing.
    // Real data has far denser cross-family linking than the sample did, and at
    // link strength 0.08 it dragged Electronic/Ambient/Pop/Latin into a single
    // mass. The anchor has to dominate decisively or the clusters aren't
    // separable and the labels have nowhere to go.
    var sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(function (d) { return d.id; }).distance(22).strength(0.03))
      .force("charge", d3.forceManyBody().strength(-30))
      .force("collide", d3.forceCollide().radius(function (d) { return rScale(d.weight) + 2.5; }).strength(0.95))
      .force("x", d3.forceX(function (d) { var a = anchors[d.family]; return a ? a.x : width / 2; }).strength(0.75))
      .force("y", d3.forceY(function (d) { var a = anchors[d.family]; return a ? a.y : height / 2; }).strength(0.75));

    function draw() {
      nodes.forEach(function (d) {
        var r = rScale(d.weight);
        d.x = Math.max(r + 2, Math.min(width - r - 2, d.x));
        d.y = Math.max(r + 2, Math.min(height - r - 2, d.y));
      });
      link
        .attr("x1", function (d) { return d.source.x; })
        .attr("y1", function (d) { return d.source.y; })
        .attr("x2", function (d) { return d.target.x; })
        .attr("y2", function (d) { return d.target.y; });
      node.attr("cx", function (d) { return d.x; }).attr("cy", function (d) { return d.y; });
    }

    function rememberPositions() {
      var out = {};
      nodes.forEach(function (d) { out[d.id] = { x: d.x / width, y: d.y / height }; });
      constellationState.positions = out;
    }

    function drawHulls() {
      rememberPositions();
      var byFam = d3.group(nodes, function (d) { return d.family; });
      var hulls = [];
      // On a narrow screen the small clusters are a few dots wide and their
      // labels collide into noise — only label the ones with real substance.
      var minCluster = width < 700 ? 5 : 3;
      byFam.forEach(function (ns, fam) {
        if (fam === "Unclassified" || ns.length < minCluster) return;
        var pts = ns.map(function (d) { return [d.x, d.y]; });
        var h = d3.polygonHull(pts);
        if (!h) return;
        // Label above the cluster's own bounding box, not at its centroid —
        // a centroid sits under the dots and collides with the neighbours.
        // Keep the label inside the frame — "Ambient / Experimental" is wide
        // enough to run off the edge otherwise.
        var half = fam.length * 4.2 + 6;
        var cx = Math.max(half, Math.min(width - half, d3.mean(pts, function (p) { return p[0]; })));
        // Sit just above the family's own dots. Pushing clear of every
        // neighbouring cluster instead stacks all the labels in one column,
        // detached from what they name — worse than a little overlap.
        var top = d3.min(ns, function (d) { return d.y - rScale(d.weight); });
        hulls.push({ family: fam, hull: h, cx: cx, cy: Math.max(12, top - 9) });
      });

      // Safety net: nudge apart any labels that still land near each other.
      hulls.sort(function (a, b) { return a.cy - b.cy || a.cx - b.cx; });
      for (var hi = 1; hi < hulls.length; hi++) {
        for (var hj = 0; hj < hi; hj++) {
          if (Math.abs(hulls[hi].cy - hulls[hj].cy) < 14 &&
              Math.abs(hulls[hi].cx - hulls[hj].cx) < 110) {
            hulls[hi].cy = hulls[hj].cy + 14;
          }
        }
      }

      hullLayer.selectAll("path").data(hulls, function (d) { return d.family; }).join("path")
        .attr("class", "hull")
        .attr("d", function (d) { return "M" + d.hull.join("L") + "Z"; })
        .attr("fill", OTHER)
        .attr("stroke", OTHER);

      labelLayer.selectAll("text").data(hulls, function (d) { return d.family; }).join("text")
        .attr("class", "cluster-label")
        .attr("text-anchor", "middle")
        .attr("x", function (d) { return d.cx; })
        .attr("y", function (d) { return d.cy; })
        .text(function (d) { return d.family; });
    }

    if (reducedMotion) {
      // Settle synchronously — no animation, same final layout.
      sim.stop();
      for (var i = 0; i < 300; i++) sim.tick();
      draw();
      drawHulls();
    } else {
      // Draw hulls off the simulation's own alpha rather than a guessed timeout,
      // so labels appear as soon as the layout is stable — and reappear promptly
      // after a resize instead of vanishing for a couple of seconds.
      var hullsDrawn = false;
      sim.on("tick", function () {
        draw();
        if (!hullsDrawn && sim.alpha() < 0.08) {
          hullsDrawn = true;
          drawHulls();
        }
      }).on("end", drawHulls);
    }

    constellationState.data = { node: node, link: link, nodes: nodes, seqScale: seqScale };
    buildConstellationLegend(data, families);

    var cap = document.getElementById("constellation-caption");
    if (cap) {
      cap.textContent =
        data.graph.nodes.length + " genres, " + data.graph.links.length +
        " shared-artist links. Each cluster is pinned to its family and the genres " +
        "inside settle by how often they share artists. Genres linked to nothing else " +
        "are left out, as are pairs seen on fewer than " +
        data.graph.pruning.minEdgeArtists + " artists — that keeps " +
        pct(data.graph.pruning.keptShareOfWeight, 0) + " of the total link weight.";
    }
  }

  function buildConstellationLegend(data, families) {
    var wrap = clear("constellation-legend");
    var resetBtn = document.getElementById("constellation-reset");
    if (!wrap) return;

    families.forEach(function (fam) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "legend-item";
      b.setAttribute("aria-pressed", "false");
      var sw = document.createElement("span");
      sw.className = "legend-swatch";
      sw.style.background = DEEMPH;
      var label = document.createElement("span");
      label.textContent = fam;
      b.appendChild(sw);
      b.appendChild(label);
      b.addEventListener("click", function () {
        selectFamily(constellationState.selected === fam ? null : fam);
      });
      wrap.appendChild(b);
    });

    if (resetBtn) {
      resetBtn.addEventListener("click", function () { selectFamily(null); });
    }
  }

  // Emphasis, not a 15-hue categorical scale: the chosen family goes rust and
  // everything else drops to the de-emphasis grey. Never more than two colours.
  function selectFamily(fam) {
    constellationState.selected = fam;
    var st = constellationState.data;
    if (!st) return;

    st.node.attr("fill", function (d) {
      if (!fam) return st.seqScale(d.weight);
      return d.family === fam ? CAT[0] : DEEMPH;
    }).attr("opacity", function (d) {
      if (!fam) return 1;
      return d.family === fam ? 1 : 0.45;
    });

    st.link.attr("stroke-opacity", fam ? 0.18 : 0.5);

    var wrap = document.getElementById("constellation-legend");
    if (wrap) {
      Array.prototype.forEach.call(wrap.children, function (b) {
        var on = b.textContent === fam;
        b.setAttribute("aria-pressed", on ? "true" : "false");
        b.querySelector(".legend-swatch").style.background = on ? CAT[0] : DEEMPH;
      });
    }
    var resetBtn = document.getElementById("constellation-reset");
    if (resetBtn) resetBtn.hidden = !fam;
  }

  // ---------- 2. family distribution ----------

  function renderFamilies(data) {
    var width = widthOf("families-holder");
    if (!width) return;

    var rows = (data.combined.familyDistribution || [])
      .filter(function (d) { return d.weight > 0; })
      .slice()
      .sort(function (a, b) { return b.weight - a.weight; });

    var rowH = 30;
    var margin = { top: 8, right: 56, bottom: 26, left: 148 };
    var innerW = Math.max(120, width - margin.left - margin.right);
    var height = rows.length * rowH + margin.top + margin.bottom;

    var svg = d3.select("#families-svg")
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("width", width).attr("height", height);
    svg.selectAll("*").remove();
    var g = svg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    var x = d3.scaleLinear().domain([0, d3.max(rows, function (d) { return d.share; })]).nice().range([0, innerW]);
    var y = d3.scaleBand().domain(rows.map(function (d) { return d.family; })).range([0, rows.length * rowH]).padding(0.28);
    var seq = d3.scaleQuantile().domain(rows.map(function (d) { return d.share; })).range(SEQ);

    // Recessive gridlines behind the marks.
    g.selectAll("line.grid-line").data(x.ticks(5)).join("line")
      .attr("class", "grid-line")
      .attr("x1", function (d) { return x(d); }).attr("x2", function (d) { return x(d); })
      .attr("y1", 0).attr("y2", rows.length * rowH);

    var bars = g.selectAll("rect").data(rows).join("rect")
      .attr("class", "bar")
      .attr("x", 0).attr("y", function (d) { return y(d.family); })
      .attr("height", y.bandwidth())
      .attr("rx", 4)
      .attr("fill", function (d) {
        // The two honesty buckets are grey by design — they are not a genre.
        if (d.family === "Unclassified" || d.family === "Other") return OTHER;
        return seq(d.share);
      })
      .attr("width", function (d) { return Math.max(2, x(d.share)); });

    bindTip(bars, function (d) {
      return "<strong>" + d.family + "</strong><span class='tt-meta'>" +
        pct(d.share, 1) + " of listening</span>";
    });

    g.selectAll("text.tick-label").data(rows).join("text")
      .attr("class", "tick-label tick-label--strong")
      .attr("x", -10).attr("y", function (d) { return y(d.family) + y.bandwidth() / 2; })
      .attr("dy", "0.35em").attr("text-anchor", "end")
      .text(function (d) { return d.family; });

    // Direct value labels — every bar, since there are few enough to stay clean.
    g.selectAll("text.value-label").data(rows).join("text")
      .attr("class", "value-label")
      .attr("x", function (d) { return x(d.share) + 8; })
      .attr("y", function (d) { return y(d.family) + y.bandwidth() / 2; })
      .attr("dy", "0.35em")
      .text(function (d) { return pct(d.share, 1); });

    g.append("line").attr("class", "axis-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", rows.length * rowH).attr("y2", rows.length * rowH);

    g.selectAll("text.xtick").data(x.ticks(5)).join("text")
      .attr("class", "tick-label xtick")
      .attr("x", function (d) { return x(d); })
      .attr("y", rows.length * rowH + 16)
      .attr("text-anchor", "middle")
      .text(function (d) { return pct(d, 0); });
  }

  // ---------- 3. source comparison ----------

  var SOURCE_SERIES = [
    { key: "saved", label: "Saved library" },
    { key: "playlistsOwned", label: "My playlists" },
    { key: "recent", label: "Recently played" },
  ];

  function renderSources(data) {
    var width = widthOf("sources-holder");
    if (!width) return;

    var series = SOURCE_SERIES.filter(function (s) {
      var b = data.sources[s.key];
      return b && b.ok && b.mass > 0;
    });
    if (!series.length) return;

    var famOrder = rankFamilies(data).filter(function (f) { return f !== "Other"; });

    var rows = famOrder.map(function (fam) {
      var vals = series.map(function (s) {
        var dist = data.sources[s.key].familyDistribution || [];
        var hit = dist.filter(function (d) { return d.family === fam; })[0];
        return { key: s.key, label: s.label, share: hit ? hit.share || 0 : 0 };
      });
      return { family: fam, vals: vals };
    });

    var groupH = 22 + series.length * 13;
    var margin = { top: 8, right: 52, bottom: 26, left: 148 };
    var innerW = Math.max(120, width - margin.left - margin.right);
    var height = rows.length * groupH + margin.top + margin.bottom;

    var svg = d3.select("#sources-svg")
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("width", width).attr("height", height);
    svg.selectAll("*").remove();
    var g = svg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    var maxShare = d3.max(rows, function (r) { return d3.max(r.vals, function (v) { return v.share; }); });
    var x = d3.scaleLinear().domain([0, maxShare]).nice().range([0, innerW]);
    var y = d3.scaleBand().domain(rows.map(function (d) { return d.family; })).range([0, rows.length * groupH]).padding(0.22);
    var ySub = d3.scaleBand().domain(series.map(function (s) { return s.key; })).range([0, y.bandwidth()]).padding(0.16);

    g.selectAll("line.grid-line").data(x.ticks(5)).join("line")
      .attr("class", "grid-line")
      .attr("x1", function (d) { return x(d); }).attr("x2", function (d) { return x(d); })
      .attr("y1", 0).attr("y2", rows.length * groupH);

    var groups = g.selectAll("g.row").data(rows).join("g")
      .attr("class", "row")
      .attr("transform", function (d) { return "translate(0," + y(d.family) + ")"; });

    var bars = groups.selectAll("rect").data(function (d) {
      return d.vals.map(function (v) { return Object.assign({ family: d.family }, v); });
    }).join("rect")
      .attr("class", "bar")
      .attr("x", 0)
      .attr("y", function (d) { return ySub(d.key); })
      .attr("height", ySub.bandwidth())
      .attr("rx", 3)
      .attr("fill", function (d) {
        var i = series.map(function (s) { return s.key; }).indexOf(d.key);
        return CAT[i];
      })
      .attr("width", function (d) { return Math.max(1, x(d.share)); });

    bindTip(bars, function (d) {
      return "<strong>" + d.family + "</strong><span class='tt-meta'>" +
        d.label + " · " + pct(d.share, 1) + "</span>";
    });

    groups.append("text")
      .attr("class", "tick-label tick-label--strong")
      .attr("x", -10).attr("y", y.bandwidth() / 2).attr("dy", "0.35em")
      .attr("text-anchor", "end")
      .text(function (d) { return d.family; });

    g.append("line").attr("class", "axis-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", rows.length * groupH).attr("y2", rows.length * groupH);

    g.selectAll("text.xtick").data(x.ticks(5)).join("text")
      .attr("class", "tick-label xtick")
      .attr("x", function (d) { return x(d); })
      .attr("y", rows.length * groupH + 16)
      .attr("text-anchor", "middle")
      .text(function (d) { return pct(d, 0); });

    // Legend — always present for >= 2 series, so identity is never colour-alone.
    var legend = clear("sources-legend");
    if (legend) {
      series.forEach(function (s, i) {
        var item = document.createElement("span");
        item.className = "legend-item";
        var sw = document.createElement("span");
        sw.className = "legend-swatch";
        sw.style.background = CAT[i];
        var t = document.createElement("span");
        var b = data.sources[s.key];
        t.textContent = s.label + " (" + b.items + " " + b.unit + (b.items === 1 ? "" : "s") + ")";
        item.appendChild(sw);
        item.appendChild(t);
        legend.appendChild(item);
      });
    }

    var cap = document.getElementById("sources-caption");
    if (cap) {
      var sv = data.sources.saved.metrics.genre.effectiveGenres;
      var rc = data.sources.recent.metrics.genre.effectiveGenres;
      var sx = data.sources.saved.extra || {};
      // A --limit build must not present its own cap as the size of the library.
      var samplingNote = sx.sampled && sx.libraryTotal
        ? " The saved library here is a " + data.sources.saved.items + "-track sample of " +
          sx.libraryTotal + ", so read that column as indicative."
        : "";
      cap.textContent =
        "Effective genres: " + num(sv) + " across the saved library versus " + num(rc) +
        " across recent plays. Recent plays are the last 50 tracks only, so that " +
        "number is naturally the twitchiest of the three." + samplingNote;
    }
  }

  // ---------- 4. treemap ----------

  function renderTreemap(data) {
    var width = widthOf("treemap-holder");
    if (!width) return;
    var height = Math.round(Math.min(620, Math.max(380, width * 0.62)));

    var genres = (data.combined.genres || []).filter(function (d) {
      return d.weight > 0 && d.family !== "Unclassified";
    });
    if (!genres.length) return;

    var byFam = d3.group(genres, function (d) { return d.family; });
    var root = d3.hierarchy({
      name: "root",
      children: Array.from(byFam, function (entry) {
        return { name: entry[0], children: entry[1] };
      }),
    }).sum(function (d) { return d.weight || 0; })
      .sort(function (a, b) { return b.value - a.value; });

    // paddingOuter() is shorthand for all four outer paddings, so it must come
    // BEFORE paddingTop or it silently resets the header gutter to 2px and the
    // family headings land on top of the first cell's label.
    d3.treemap()
      .size([width, height])
      .paddingInner(2)
      .paddingOuter(2)
      .paddingTop(19)
      .round(true)(root);

    var svg = d3.select("#treemap-svg")
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("width", width).attr("height", height);
    svg.selectAll("*").remove();

    var leaves = root.leaves();
    var seq = d3.scaleQuantile().domain(leaves.map(function (d) { return d.value; })).range(SEQ);

    var cell = svg.selectAll("g.treemap-cell").data(leaves).join("g")
      .attr("class", "treemap-cell")
      .attr("transform", function (d) { return "translate(" + d.x0 + "," + d.y0 + ")"; });

    cell.append("rect")
      .attr("width", function (d) { return Math.max(0, d.x1 - d.x0); })
      .attr("height", function (d) { return Math.max(0, d.y1 - d.y0); })
      .attr("rx", 2)
      .attr("fill", function (d) { return seq(d.value); });

    cell.on("click", function (evt, d) { openGenre(d.data.name); });

    bindTip(cell, function (d) {
      return "<strong>" + d.data.name + "</strong><span class='tt-meta'>" +
        d.parent.data.name + " · " + pct(d.data.share, 2) + " · " +
        d.data.tracks + " track" + (d.data.tracks === 1 ? "" : "s") + "</span>";
    });

    // Label only where the cell can actually hold the text — selective direct
    // labels, never a number on every mark.
    cell.append("text")
      .attr("class", "treemap-label")
      .attr("x", 5).attr("y", 13)
      .attr("fill", function (d) {
        // Keep contrast against the darker end of the ramp.
        return SEQ.indexOf(seq(d.value)) >= 3 ? PAPER2 : "#211d18";
      })
      .text(function (d) {
        var w = d.x1 - d.x0, h = d.y1 - d.y0;
        if (w < 52 || h < 20) return "";
        var max = Math.floor((w - 10) / 5.6);
        return d.data.name.length > max ? d.data.name.slice(0, max - 1) + "…" : d.data.name;
      });

    svg.selectAll("text.family-head").data(root.children || []).join("text")
      .attr("class", "tick-label tick-label--strong family-head")
      .attr("x", function (d) { return d.x0 + 3; })
      .attr("y", function (d) { return d.y0 + 12; })
      .text(function (d) {
        var w = d.x1 - d.x0;
        if (w < 60) return "";
        var max = Math.floor((w - 6) / 6);
        return d.data.name.length > max ? d.data.name.slice(0, max - 1) + "…" : d.data.name;
      });

    var cap = document.getElementById("treemap-caption");
    if (cap) {
      cap.textContent =
        "Top " + genres.length + " genres by listening share, grouped by family. " +
        (data.combined.genresTruncated
          ? "The full tail runs to " + data.combined.genresTotal + " genres — the rest are too small to draw."
          : "That's all of them.");
    }
  }

  // ---------- 5. playlist fingerprints ----------

  function renderPlaylists(data) {
    var width = widthOf("playlists-holder");
    if (!width) return;

    var all = (data.playlists || [])
      .filter(function (d) { return d.effectiveGenres; })
      .slice()
      .sort(function (a, b) { return b.effectiveGenres - a.effectiveGenres; });
    if (!all.length) return;
    // 189 playlists is a 4,000px-tall chart. Cap it — and say so in the caption
    // rather than silently truncating.
    var PLAYLIST_CAP = 40;
    var rows = all.slice(0, PLAYLIST_CAP);
    var omitted = all.length - rows.length;

    var rowH = 22;
    var margin = { top: 8, right: 130, bottom: 26, left: 92 };
    var innerW = Math.max(120, width - margin.left - margin.right);
    var height = rows.length * rowH + margin.top + margin.bottom;

    var svg = d3.select("#playlists-svg")
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("width", width).attr("height", height);
    svg.selectAll("*").remove();
    var g = svg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    var x = d3.scaleLinear().domain([0, d3.max(rows, function (d) { return d.effectiveGenres; })]).nice().range([0, innerW]);
    var y = d3.scaleBand().domain(rows.map(function (d) { return d.label; })).range([0, rows.length * rowH]).padding(0.24);
    var seq = d3.scaleQuantile().domain(rows.map(function (d) { return d.effectiveGenres; })).range(SEQ);

    g.selectAll("line.grid-line").data(x.ticks(5)).join("line")
      .attr("class", "grid-line")
      .attr("x1", function (d) { return x(d); }).attr("x2", function (d) { return x(d); })
      .attr("y1", 0).attr("y2", rows.length * rowH);

    var bars = g.selectAll("rect").data(rows).join("rect")
      .attr("class", "bar")
      .attr("x", 0).attr("y", function (d) { return y(d.label); })
      .attr("height", y.bandwidth()).attr("rx", 3)
      .attr("fill", function (d) { return seq(d.effectiveGenres); })
      .attr("width", function (d) { return Math.max(2, x(d.effectiveGenres)); });

    bindTip(bars, function (d) {
      var top = (d.topFamilies || []).map(function (f) { return f[0] + " " + pct(f[1], 0); }).join(" · ");
      return "<strong>" + d.label + "</strong><span class='tt-meta'>" +
        num(d.effectiveGenres, 1) + " effective genres · " + d.items + " tracks" +
        (d.owned ? "" : " · followed") + (top ? "<br>" + top : "") + "</span>";
    });

    g.selectAll("text.tick-label").data(rows).join("text")
      .attr("class", "tick-label")
      .attr("x", -10).attr("y", function (d) { return y(d.label) + y.bandwidth() / 2; })
      .attr("dy", "0.35em").attr("text-anchor", "end")
      .text(function (d) { return d.label; });

    // Direct-label the dominant family instead of colouring by it — 15 families
    // is far past the categorical token ceiling.
    g.selectAll("text.value-label").data(rows).join("text")
      .attr("class", "value-label")
      .attr("x", function (d) { return x(d.effectiveGenres) + 8; })
      .attr("y", function (d) { return y(d.label) + y.bandwidth() / 2; })
      .attr("dy", "0.35em")
      .text(function (d) {
        var top = d.topFamilies && d.topFamilies[0] ? d.topFamilies[0][0] : "";
        return num(d.effectiveGenres, 1) + (top ? "  " + top : "");
      });

    g.append("line").attr("class", "axis-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", rows.length * rowH).attr("y2", rows.length * rowH);

    g.selectAll("text.xtick").data(x.ticks(5)).join("text")
      .attr("class", "tick-label xtick")
      .attr("x", function (d) { return x(d); })
      .attr("y", rows.length * rowH + 16)
      .attr("text-anchor", "middle")
      .text(function (d) { return d; });

    var owned = all.filter(function (d) { return d.owned; }).length;
    var cap = document.getElementById("playlists-caption");
    if (cap) {
      cap.textContent =
        (omitted
          ? "The " + rows.length + " most varied of " + all.length + " playlists (" +
            owned + " mine, " + (all.length - owned) + " followed); " + omitted +
            " less varied ones aren't drawn. "
          : all.length + " playlists (" + owned + " mine, " + (all.length - owned) +
            " followed). ") +
        "Ranked by effective genre count; the label on the right is the " +
        "playlist's dominant family.";
    }
  }

  // ---------- 6. drift ----------

  var WINDOW_LABELS = [
    ["short_term", "~4 weeks"],
    ["medium_term", "~6 months"],
    ["long_term", "~1 year+"],
  ];

  function renderDrift(data) {
    var width = widthOf("drift-holder");
    if (!width) return;

    var windows = data.sources.topArtists && data.sources.topArtists.extra
      ? data.sources.topArtists.extra.windows : null;
    if (!windows) return;

    var famSet = {};
    WINDOW_LABELS.forEach(function (w) {
      (windows[w[0]] || []).forEach(function (d) {
        if (d.family === "Unclassified" || d.family === "Other") return;
        famSet[d.family] = Math.max(famSet[d.family] || 0, d.share || 0);
      });
    });

    var allRanked = Object.keys(famSet).sort(function (a, b) { return famSet[b] - famSet[a]; });
    // Families that never clear 1.5% in any window pile into an illegible mat
    // at the baseline and carry no signal — count them off instead of drawing.
    var ranked = allRanked.filter(function (f) { return famSet[f] >= 0.015; });
    var omitted = allRanked.length - ranked.length;
    // Top 6 take the categorical slots; the rest fold into one grey group.
    var colored = ranked.slice(0, 6);
    var tail = ranked.slice(6);

    var series = ranked.map(function (fam) {
      return {
        family: fam,
        colored: colored.indexOf(fam) >= 0,
        color: colored.indexOf(fam) >= 0 ? CAT[colored.indexOf(fam)] : DEEMPH,
        points: WINDOW_LABELS.map(function (w, i) {
          var hit = (windows[w[0]] || []).filter(function (d) { return d.family === fam; })[0];
          return { i: i, share: hit ? hit.share || 0 : 0 };
        }),
      };
    });

    // Size the right gutter from the longest label actually being drawn — a
    // fixed 128px clipped "Ambient / Experimental" by a few pixels.
    var longest = colored.reduce(function (m, f) { return Math.max(m, f.length); }, 0);
    var margin = { top: 22, right: Math.min(190, Math.max(96, longest * 6.2 + 18)), bottom: 34, left: 56 };
    var height = 400;
    var innerW = Math.max(120, width - margin.left - margin.right);
    var innerH = height - margin.top - margin.bottom;

    var svg = d3.select("#drift-svg")
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("width", width).attr("height", height);
    svg.selectAll("*").remove();
    var g = svg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    var x = d3.scalePoint().domain([0, 1, 2]).range([0, innerW]);
    var maxShare = d3.max(series, function (s) { return d3.max(s.points, function (p) { return p.share; }); });
    var y = d3.scaleLinear().domain([0, maxShare]).nice().range([innerH, 0]);

    g.selectAll("line.grid-line").data(y.ticks(5)).join("line")
      .attr("class", "grid-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", function (d) { return y(d); }).attr("y2", function (d) { return y(d); });

    g.selectAll("text.ytick").data(y.ticks(5)).join("text")
      .attr("class", "tick-label ytick")
      .attr("x", -10).attr("y", function (d) { return y(d); })
      .attr("dy", "0.35em").attr("text-anchor", "end")
      .text(function (d) { return pct(d, 0); });

    WINDOW_LABELS.forEach(function (w, i) {
      g.append("text")
        .attr("class", "tick-label tick-label--strong")
        .attr("x", x(i)).attr("y", innerH + 20)
        .attr("text-anchor", i === 0 ? "start" : i === 2 ? "end" : "middle")
        .text(w[1]);
    });

    var line = d3.line().x(function (p) { return x(p.i); }).y(function (p) { return y(p.share); });

    // Grey tail first so the six coloured series draw on top of it.
    var ordered = series.slice().sort(function (a, b) { return (a.colored ? 1 : 0) - (b.colored ? 1 : 0); });

    var paths = g.selectAll("path.slope-line").data(ordered).join("path")
      .attr("class", "slope-line")
      .attr("d", function (s) { return line(s.points); })
      .attr("stroke", function (s) { return s.color; })
      .attr("opacity", function (s) { return s.colored ? 1 : 0.55; });

    bindTip(paths, function (s) {
      return "<strong>" + s.family + "</strong><span class='tt-meta'>" +
        s.points.map(function (p, i) { return WINDOW_LABELS[i][1] + " " + pct(p.share, 1); }).join(" → ") +
        "</span>";
    });

    ordered.forEach(function (s) {
      g.selectAll("circle.d-" + s.family.replace(/[^a-z]/gi, "")).data(s.points).join("circle")
        .attr("class", "slope-dot d-" + s.family.replace(/[^a-z]/gi, ""))
        .attr("cx", function (p) { return x(p.i); })
        .attr("cy", function (p) { return y(p.share); })
        .attr("r", function (p) { return s.colored ? 4.5 : 3; })
        .attr("fill", s.color)
        .attr("opacity", s.colored ? 1 : 0.55);
    });

    // Direct labels on the right for the coloured series only.
    var labelPts = series.filter(function (s) { return s.colored; }).map(function (s) {
      return { family: s.family, color: s.color, y: y(s.points[2].share) };
    }).sort(function (a, b) { return a.y - b.y; });
    // Nudge apart so they never collide.
    for (var i = 1; i < labelPts.length; i++) {
      if (labelPts[i].y - labelPts[i - 1].y < 13) labelPts[i].y = labelPts[i - 1].y + 13;
    }

    g.selectAll("text.slope-label").data(labelPts).join("text")
      .attr("class", "tick-label slope-label")
      .attr("x", innerW + 10).attr("y", function (d) { return d.y; })
      .attr("dy", "0.35em")
      .attr("fill", "#211d18")
      .text(function (d) { return d.family; });

    var legend = clear("drift-legend");
    if (legend) {
      colored.forEach(function (fam, i) {
        var item = document.createElement("span");
        item.className = "legend-item";
        var sw = document.createElement("span");
        sw.className = "legend-swatch";
        sw.style.background = CAT[i];
        var t = document.createElement("span");
        t.textContent = fam;
        item.appendChild(sw); item.appendChild(t);
        legend.appendChild(item);
      });
      if (tail.length) {
        var item2 = document.createElement("span");
        item2.className = "legend-item";
        var sw2 = document.createElement("span");
        sw2.className = "legend-swatch";
        sw2.style.background = DEEMPH;
        var t2 = document.createElement("span");
        t2.textContent = tail.length + " smaller families";
        item2.appendChild(sw2); item2.appendChild(t2);
        legend.appendChild(item2);
      }
      // Never drop series silently — say what isn't drawn.
      if (omitted) {
        var item3 = document.createElement("span");
        item3.className = "legend-item";
        item3.style.borderStyle = "dashed";
        var t3 = document.createElement("span");
        t3.textContent = omitted + " below 1.5%, not drawn";
        item3.appendChild(t3);
        legend.appendChild(item3);
      }
    }
  }

  // ---------- 7. table ----------

  var tableState = { rows: [], sort: "name", dir: 1 };

  function renderTable(data) {
    var table = document.getElementById("genre-table");
    if (!table) return;

    tableState.rows = (data.combined.genres || []).slice();

    var famOrder = rankFamilies(data);
    var famColor = {};
    famOrder.forEach(function (f, i) { famColor[f] = i < 6 ? CAT[i] : OTHER; });

    function paint() {
      var tbody = table.querySelector("tbody");
      tbody.innerHTML = "";
      var rows = tableState.rows.slice().sort(function (a, b) {
        var k = tableState.sort;
        var av = a[k], bv = b[k];
        if (typeof av === "string") return tableState.dir * av.localeCompare(bv);
        return tableState.dir * ((av || 0) - (bv || 0));
      });
      var frag = document.createDocumentFragment();
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        tr.setAttribute("data-genre", r.name);
        tr.addEventListener("click", function () { openGenre(r.name); });
        var td1 = document.createElement("td");
        td1.textContent = r.name;
        var td2 = document.createElement("td");
        var dot = document.createElement("span");
        dot.className = "family-dot";
        dot.style.background = famColor[r.family] || OTHER;
        td2.appendChild(dot);
        td2.appendChild(document.createTextNode(r.family));
        var td3 = document.createElement("td");
        td3.className = "num";
        td3.textContent = pct(r.share, 2);
        var td4 = document.createElement("td");
        td4.className = "num";
        td4.textContent = String(r.tracks);
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);
    }

    table.querySelectorAll("th[data-sort]").forEach(function (th) {
      th.querySelector("button").addEventListener("click", function () {
        var key = th.getAttribute("data-sort");
        if (tableState.sort === key) tableState.dir *= -1;
        else { tableState.sort = key; tableState.dir = key === "name" || key === "family" ? 1 : -1; }
        table.querySelectorAll("th[data-sort]").forEach(function (o) { o.removeAttribute("aria-sort"); });
        th.setAttribute("aria-sort", tableState.dir === 1 ? "ascending" : "descending");
        paint();
      });
    });

    paint();

    var note = document.getElementById("table-note");
    if (note) {
      note.textContent = data.combined.genresTruncated
        ? "Showing the top " + tableState.rows.length + " genres by share, of " +
          data.combined.genresTotal + " total. The tail is real but individually tiny."
        : "All " + tableState.rows.length + " genres.";
    }
  }

  // ---------- 8. method ----------

  function renderMethod(data) {
    var cov = data.combined.coverage;
    var m = data.combined.metrics.genre;

    var un = document.getElementById("cov-unclassified");
    if (un) un.textContent = pct(cov.unclassifiedShare, 1);
    var um = document.getElementById("cov-unmatched");
    if (um) um.textContent = pct(cov.unmatchedShare, 1);

    var g = document.getElementById("method-gini");
    if (g) g.textContent = "Gini " + num(m.gini, 2);
    var e = document.getElementById("method-evenness");
    if (e) e.textContent = "Evenness " + num(m.evenness, 2);
    var s = document.getElementById("method-simpson");
    if (s) s.textContent = "Top 10 = " + pct(m.top10Share, 0);

    var prov = document.getElementById("provenance-line");
    if (prov && data.provenance && data.provenance.resolved) {
      var rs = data.provenance.resolved;
      var tot = (rs.lastfm || 0) + (rs.musicbrainz || 0) + (rs.unresolved || 0);
      if (tot > 0) {
        prov.textContent =
          "Genre sources: " + rs.lastfm + " artists from Last.fm, " +
          rs.musicbrainz + " from MusicBrainz, " + rs.unresolved +
          " neither could identify (" + pct(rs.unresolved / tot, 0) + ").";
      }
    }

    var chips = clear("unmatched-chips");
    if (chips) {
      (data.taxonomy.unmatched || [])
        .slice()
        .sort(function (a, b) { return b.weight - a.weight; })
        .slice(0, 6)
        .forEach(function (u) {
          var c = document.createElement("span");
          c.className = "chip";
          c.textContent = u.genre;
          chips.appendChild(c);
        });
    }

    var asOf = document.getElementById("method-asof");
    if (asOf && data.asOf) {
      var d = new Date(data.asOf);
      asOf.textContent = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    }
  }

  // ---------- boot ----------

  function renderAll(data) {
    buildGenreLookups(data);
    renderHeadline(data);
    renderConstellation(data);
    renderFamilies(data);
    renderSources(data);
    renderTreemap(data);
    renderPlaylists(data);
    renderDrift(data);
    renderTable(data);
    renderMethod(data);
  }

  function redrawResponsive(data) {
    renderConstellation(data);
    renderFamilies(data);
    renderSources(data);
    renderTreemap(data);
    renderPlaylists(data);
    renderDrift(data);
  }

  // Local preview can point at a sample file: music.html?data=…
  // Relative, same-origin paths only — no absolute URLs, no protocol.
  var dataPath = "data/spotify-genres.json";
  try {
    var q = new URLSearchParams(window.location.search).get("data");
    if (q && !/^[a-z]+:|^\/\//i.test(q)) dataPath = q;
  } catch (err) {
    /* no URLSearchParams — fall back to the default path */
  }

  fetch(dataPath, { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.combined) return;
      if (typeof d3 === "undefined") return; // CDN blocked — keep the empty note

      var empty = document.getElementById("music-empty");
      if (empty) empty.hidden = true;
      document.getElementById("music-body").hidden = false;
      document.getElementById("music-main").hidden = false;

      renderAll(data);

      var t = null;
      window.addEventListener("resize", function () {
        clearTimeout(t);
        t = setTimeout(function () { redrawResponsive(data); }, 220);
      });
    })
    .catch(function () {
      /* no data file yet — the empty-state note stays visible */
    });
})();
