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
  // ---------- Spotify "On rotation" card ----------
  // Populated by the typride-spotify Cloudflare Worker. Leave the endpoint
  // empty to keep the card hidden (e.g., before the Worker is deployed).
  var SPOTIFY_ENDPOINT = "";
  if (SPOTIFY_ENDPOINT) {
    fetch(SPOTIFY_ENDPOINT)
      .then(function (res) {
        if (!res.ok) throw new Error("spotify endpoint " + res.status);
        return res.json();
      })
      .then(function (data) {
        var current = data.nowPlaying || data.lastPlayed;
        if (!current && (!data.topArtists || !data.topArtists.length)) return;

        if (current) {
          document.getElementById("listening-now-label").textContent =
            data.nowPlaying ? "Now playing" : "Last played";
          document.getElementById("listening-live").hidden = !data.nowPlaying;
          document.getElementById("listening-name").textContent = current.track;
          document.getElementById("listening-artist").textContent = current.artist;
          var link = document.getElementById("listening-track");
          if (current.url) link.href = current.url;
          var art = document.getElementById("listening-art");
          if (current.image) {
            art.src = current.image;
            art.alt = current.track + " album art";
            art.hidden = false;
          }
        }

        var chips = document.getElementById("listening-artists");
        (data.topArtists || []).forEach(function (artist) {
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
          chips.appendChild(el);
        });

        document.getElementById("listening").hidden = false;
      })
      .catch(function () {
        /* leave the card hidden if the endpoint is unreachable */
      });
  }
})();
