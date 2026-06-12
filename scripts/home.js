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
    { name: "Seattle, WA", lat: 47.61, lon: -122.33 },
    { name: "Boulder, CO", lat: 40.01, lon: -105.27 },
    { name: "Toolik Field Station, Alaska", lat: 68.63, lon: -149.6 },
    { name: "Oklahoma", lat: 35.47, lon: -97.52 },
    { name: "Mexico City", lat: 19.43, lon: -99.13 },
    { name: "Tokyo, Japan", lat: 35.68, lon: 139.69 },
    { name: "Nagano, Japan", lat: 36.65, lon: 138.18 },
    { name: "Prague, Czechia", lat: 50.09, lon: 14.42 },
    { name: "Swiss Alps", lat: 46.02, lon: 7.75 },
    { name: "Athens, Greece", lat: 37.98, lon: 23.73 },
    { name: "Pisa, Italy", lat: 43.72, lon: 10.4 },
    { name: "Barcelona, Spain", lat: 41.39, lon: 2.17 },
  ];
  var worldMap = document.getElementById("world-map");
  if (worldMap) {
    PLACES.forEach(function (place) {
      var dot = document.createElement("button");
      dot.type = "button";
      dot.className = "map-dot";
      dot.setAttribute("data-name", place.name);
      dot.setAttribute("aria-label", place.name);
      dot.style.left = ((place.lon + 180) / 360) * 100 + "%";
      dot.style.top = ((90 - place.lat) / 180) * 100 + "%";
      worldMap.appendChild(dot);
    });
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
