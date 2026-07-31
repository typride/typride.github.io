// Homepage interactions — scroll reveals, counters, nav. No dependencies.
(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- year stamp ----------
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ---------- sticky nav state ----------
  var nav = document.querySelector(".site-nav");
  var progress = document.querySelector(".progress");

  function onScroll() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 12);
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var pct = max > 0 ? (window.scrollY / max) * 100 : 0;
      progress.style.width = pct + "%";
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // ---------- mobile menu ----------
  var toggle = document.querySelector(".nav-toggle");
  var menu = document.getElementById("mobile-menu");
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var open = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        menu.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // ---------- counters ----------
  function animateCount(el) {
    var target = parseInt(el.getAttribute("data-count"), 10);
    if (isNaN(target)) return;
    if (reducedMotion) {
      el.textContent = String(target);
      return;
    }
    var duration = 1300;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      el.textContent = String(Math.round(eased * target));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---------- reveal on scroll ----------
  var revealed = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reducedMotion) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in");
          entry.target.querySelectorAll("[data-count]").forEach(animateCount);
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealed.forEach(function (el) { io.observe(el); });
  } else {
    revealed.forEach(function (el) {
      el.classList.add("in");
      el.querySelectorAll("[data-count]").forEach(animateCount);
    });
  }
  // ---------- Spotify "On rotation" bar (hero) ----------
  // Populated by the typride-spotify Cloudflare Worker. Leave the endpoint
  // empty to keep the bar hidden (e.g., before the Worker is deployed).
  var SPOTIFY_ENDPOINT = "https://typride-spotify.tylerpridemilligan.workers.dev";
  if (SPOTIFY_ENDPOINT && document.getElementById("rotation")) {
    fetch(SPOTIFY_ENDPOINT)
      .then(function (res) {
        if (!res.ok) throw new Error("spotify endpoint " + res.status);
        return res.json();
      })
      .then(function (data) {
        var current = data.nowPlaying || data.lastPlayed;
        if (!current) return;

        document.getElementById("rotation-label").textContent =
          data.nowPlaying ? "Now playing" : "Last played";
        document.getElementById("rotation-live").hidden = !data.nowPlaying;
        document.getElementById("rotation-name").textContent = current.track;
        document.getElementById("rotation-artist").textContent = "— " + current.artist;

        var art = document.getElementById("rotation-art");
        if (current.image) {
          art.src = current.image;
          art.alt = current.track + " album art";
          art.hidden = false;
        }

        var artists = data.topArtists || [];
        if (artists.length) {
          var row = document.getElementById("rotation-artists");
          artists.forEach(function (artist) {
            var el;
            if (artist.url) {
              el = document.createElement("a");
              el.href = artist.url;
              el.target = "_blank";
              el.rel = "noopener";
            } else {
              el = document.createElement("span");
            }
            el.className = "chip";
            el.textContent = artist.name;
            row.appendChild(el);
          });
          row.hidden = false;
        }

        var playBtn = document.getElementById("rotation-play");
        var embedWrap = document.getElementById("rotation-embed");
        if (current.id) {
          playBtn.addEventListener("click", function () {
            if (!embedWrap.firstChild) {
              var iframe = document.createElement("iframe");
              iframe.src =
                "https://open.spotify.com/embed/track/" + current.id + "?utm_source=generator";
              iframe.title = "Spotify player — " + current.track;
              iframe.loading = "lazy";
              iframe.allow =
                "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
              embedWrap.appendChild(iframe);
            }
            var open = embedWrap.hidden;
            embedWrap.hidden = !open;
            playBtn.setAttribute("aria-expanded", open ? "true" : "false");
            playBtn.innerHTML = open
              ? "Hide player"
              : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg> Play';
          });
        } else {
          playBtn.hidden = true;
        }

        document.getElementById("rotation").hidden = false;
      })
      .catch(function () {
        /* leave the bar hidden if the endpoint is unreachable */
      });
  }

  // ---------- menu carousel ----------
  var menuTrack = document.getElementById("menu-track");
  if (menuTrack && menuTrack.querySelector(".menu-card")) {
    document.getElementById("menu").hidden = false;
    var step = 504; // two cards + gaps
    document.getElementById("menu-prev").addEventListener("click", function () {
      menuTrack.scrollBy({ left: -step, behavior: "smooth" });
    });
    document.getElementById("menu-next").addEventListener("click", function () {
      menuTrack.scrollBy({ left: step, behavior: "smooth" });
    });
  }

  // ---------- where I've been (map dots) ----------
  var PLACES = [
    // North America
    { name: "Seattle, WA", lat: 47.61, lon: -122.33 },
    { name: "Portland, OR", lat: 45.52, lon: -122.68 },
    { name: "Los Angeles, CA", lat: 34.05, lon: -118.24 },
    { name: "Boulder, CO", lat: 40.01, lon: -105.27 },
    { name: "Oklahoma City, OK", lat: 35.47, lon: -97.52 },
    { name: "Nashville, TN", lat: 36.16, lon: -86.78 },
    { name: "Tampa, FL", lat: 27.95, lon: -82.46 },
    { name: "Virginia Beach, VA", lat: 36.85, lon: -75.98 },
    { name: "New York, NY", lat: 40.71, lon: -74.01 },
    { name: "Oahu, Hawaii", lat: 21.48, lon: -158.00 },
    // Alaska
    { name: "Juneau, Alaska", lat: 58.30, lon: -134.42 },
    { name: "Valdez, Alaska", lat: 61.13, lon: -146.35 },
    { name: "Naknek, Alaska", lat: 58.73, lon: -157.02 },
    { name: "Toolik Field Station, Alaska", lat: 68.63, lon: -149.6 },
    // Mexico
    { name: "Mexico City", lat: 19.43, lon: -99.13 },
    { name: "Puerto Escondido, Mexico", lat: 15.87, lon: -97.08 },
    { name: "Sayulita, Mexico", lat: 20.87, lon: -105.44 },
    // Iberia
    { name: "Porto, Portugal", lat: 41.15, lon: -8.61 },
    { name: "Lisbon, Portugal", lat: 38.72, lon: -9.14 },
    { name: "The Algarve, Portugal", lat: 37.02, lon: -7.93 },
    { name: "Barcelona, Spain", lat: 41.39, lon: 2.17 },
    { name: "Valencia, Spain", lat: 39.47, lon: -0.38 },
    // France & Monaco
    { name: "Paris, France", lat: 48.86, lon: 2.35 },
    { name: "Marseille, France", lat: 43.30, lon: 5.37 },
    { name: "Monte Carlo, Monaco", lat: 43.74, lon: 7.42 },
    // Italy
    { name: "Rome, Italy", lat: 41.90, lon: 12.50 },
    { name: "Pisa, Italy", lat: 43.72, lon: 10.4 },
    { name: "Siena, Italy", lat: 43.32, lon: 11.33 },
    { name: "Tuscany, Italy", lat: 43.77, lon: 11.26 },
    // Central Europe & the Alps
    { name: "Swiss Alps", lat: 46.02, lon: 7.75 },
    { name: "Salzburg, Austria", lat: 47.81, lon: 13.05 },
    { name: "Vienna, Austria", lat: 48.21, lon: 16.37 },
    { name: "Munich, Germany", lat: 48.14, lon: 11.58 },
    { name: "Nuremberg, Germany", lat: 49.45, lon: 11.08 },
    { name: "Prague, Czechia", lat: 50.09, lon: 14.42 },
    { name: "Krakow, Poland", lat: 50.06, lon: 19.95 },
    { name: "Budapest, Hungary", lat: 47.50, lon: 19.04 },
    // UK & Greece
    { name: "London, UK", lat: 51.51, lon: -0.13 },
    { name: "Athens, Greece", lat: 37.98, lon: 23.73 },
    { name: "Milos, Greece", lat: 36.74, lon: 24.42 },
    // Japan
    { name: "Tokyo, Japan", lat: 35.68, lon: 139.69 },
    { name: "Nagano, Japan", lat: 36.65, lon: 138.18 },
    { name: "Kyoto, Japan", lat: 35.01, lon: 135.77 },
    { name: "Nasu, Japan", lat: 36.97, lon: 140.12 },
    // India
    { name: "Hampi, India", lat: 15.34, lon: 76.46 },
    { name: "Bangalore, India", lat: 12.97, lon: 77.59 },
  ];
  function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  var worldMap = document.getElementById("world-map");
  if (worldMap) {
    var dotBySlug = {};
    PLACES.forEach(function (place) {
      var slug = slugify(place.name);
      var dot = document.createElement("button");
      dot.type = "button";
      dot.className = "map-dot";
      dot.setAttribute("data-name", place.name);
      dot.setAttribute("aria-label", place.name);
      dot.style.left = ((place.lon + 180) / 360) * 100 + "%";
      dot.style.top = ((90 - place.lat) / 180) * 100 + "%";
      worldMap.appendChild(dot);
      dotBySlug[slug] = { dot: dot, place: place };
    });

    // Photos live in images/trips/<slug>/ and are listed in manifest.json
    // (regenerate it with `node scripts/build-trips.js`). Pins with photos
    // start pulsing and open a lightbox on click.
    fetch("images/trips/manifest.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (manifest) {
        Object.keys(manifest || {}).forEach(function (slug) {
          var entry = manifest[slug];
          var photos = Array.isArray(entry) ? entry : (entry && entry.photos) || [];
          var ref = dotBySlug[slug];
          if (!ref || !photos.length) return;
          ref.dot.classList.add("has-photos");
          ref.dot.setAttribute("data-name", ref.place.name + " · " + photos.length + " 📷");
          ref.dot.addEventListener("click", function () {
            openLightbox(ref.place.name, slug, photos);
          });
        });
      })
      .catch(function () { /* no manifest yet — pins still work as dots */ });
  }

  // ---------- trip photo lightbox ----------
  var lb = null, lbImgs = [], lbIdx = 0, lbTitle = "";
  function buildLightbox() {
    lb = document.createElement("div");
    lb.className = "trip-lightbox";
    lb.setAttribute("aria-hidden", "true");
    lb.innerHTML =
      '<div class="tl-backdrop"></div>' +
      '<div class="tl-stage" role="dialog" aria-modal="true" aria-label="Trip photos">' +
        '<button class="tl-close" type="button" aria-label="Close">×</button>' +
        '<button class="tl-nav tl-prev" type="button" aria-label="Previous photo">‹</button>' +
        '<figure class="tl-figure"><img class="tl-img" alt=""><figcaption class="tl-cap"></figcaption></figure>' +
        '<button class="tl-nav tl-next" type="button" aria-label="Next photo">›</button>' +
        '<div class="tl-count"></div>' +
      '</div>';
    document.body.appendChild(lb);
    lb.querySelector(".tl-backdrop").addEventListener("click", closeLightbox);
    lb.querySelector(".tl-close").addEventListener("click", closeLightbox);
    lb.querySelector(".tl-prev").addEventListener("click", function () { showPhoto(lbIdx - 1); });
    lb.querySelector(".tl-next").addEventListener("click", function () { showPhoto(lbIdx + 1); });
    document.addEventListener("keydown", function (e) {
      if (!lb || !lb.classList.contains("open")) return;
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") showPhoto(lbIdx - 1);
      else if (e.key === "ArrowRight") showPhoto(lbIdx + 1);
    });
  }
  function openLightbox(title, slug, photos) {
    if (!lb) buildLightbox();
    lbTitle = title;
    lbImgs = photos.map(function (p) { return "images/trips/" + slug + "/" + p; });
    lb.classList.add("open");
    lb.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    showPhoto(0);
  }
  function showPhoto(i) {
    if (!lb || !lbImgs.length) return;
    lbIdx = (i + lbImgs.length) % lbImgs.length;
    lb.querySelector(".tl-img").src = lbImgs[lbIdx];
    lb.querySelector(".tl-img").alt = lbTitle + " — photo " + (lbIdx + 1);
    lb.querySelector(".tl-cap").textContent = lbTitle;
    lb.querySelector(".tl-count").textContent = (lbIdx + 1) + " / " + lbImgs.length;
    var multi = lbImgs.length > 1;
    lb.querySelector(".tl-prev").style.display = multi ? "" : "none";
    lb.querySelector(".tl-next").style.display = multi ? "" : "none";
  }
  function closeLightbox() {
    if (!lb) return;
    lb.classList.remove("open");
    lb.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  // ---------- copy email ----------
  var copyBtn = document.getElementById("copy-email");
  if (copyBtn) {
    var showCopied = function () {
      copyBtn.textContent = "Copied ✓";
      copyBtn.classList.add("copied");
      setTimeout(function () {
        copyBtn.textContent = "Copy email";
        copyBtn.classList.remove("copied");
      }, 2200);
    };
    var legacyCopy = function (text) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) { /* unsupported */ }
      document.body.removeChild(ta);
      if (ok) showCopied();
    };
    copyBtn.addEventListener("click", function () {
      var email = copyBtn.getAttribute("data-email");
      if (navigator.clipboard) {
        navigator.clipboard.writeText(email).then(showCopied, function () {
          legacyCopy(email);
        });
      } else {
        legacyCopy(email);
      }
    });
  }
})();
