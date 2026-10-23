/* Relay site motion. No dependencies; load with <script src=".../motion.js" defer>.
 * Content is visible without JS. With prefers-reduced-motion: reduce nothing moves:
 * reveals show at once, --p stays at its CSS default (1), every sequence step is
 * .is-active (so steps stack), and videos keep their poster.
 *
 * [data-reveal]          Rises and sharpens in when it enters the viewport (adds .is-in).
 *                        data-reveal="fade": opacity only. style="--d:120ms": extra delay.
 * [data-reveal-stagger]  The direct children reveal in turn (each gets --i; gap --stagger, 70ms).
 * [data-scroll]          Writes --p (0..1). data-scroll: 0 when its top meets the viewport
 *                        bottom, 1 when its bottom leaves the top. data-scroll="enter": 0 at the
 *                        bottom, 1 once its top reaches 20% of the viewport. CSS default --p:1.
 * [data-sequence]        Pinned presentation (style="--steps:N"; .sequence-stage sticks inside).
 *                        [data-seq-step] elements are steps, numbered by order among their
 *                        siblings (or data-seq-step="2"). Sets data-step="i" and --p on the
 *                        section and .is-active on every step with index i.
 * video[data-autoplay]   Plays while at least 35% visible, pauses otherwise.
 * details.nav-menu       Closes on Escape, outside click or link click.
 * html[data-scrolled]    Present once the page is scrolled more than 8px.
 * window.relayMotion.refresh()  Re-scan after adding elements.
 */
(function () {
  "use strict";
  var doc = document;
  var root = doc.documentElement;
  var reduce = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  var hasIO = "IntersectionObserver" in window;
  var all = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };
  var clamp = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };

  var scrollEls = [];
  var seqs = [];
  var ticking = false;

  var revealIO = hasIO && !reduce ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("is-in");
      revealIO.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px -8% 0px" }) : null;

  var videoIO = hasIO && !reduce ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var v = e.target;
      if (e.isIntersecting) {
        v.muted = true;
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      } else if (!v.paused) {
        v.pause();
      }
    });
  }, { threshold: 0.35 }) : null;

  function setSeq(s, i) {
    s.i = i;
    s.el.setAttribute("data-step", i);
    s.steps.forEach(function (st) { st.el.classList.toggle("is-active", reduce || st.i === i); });
  }

  function initSeq(el) {
    var steps = all("[data-seq-step]", el).map(function (st) {
      var v = st.getAttribute("data-seq-step");
      var i = v !== "" && !isNaN(v) ? +v : Array.prototype.filter.call(st.parentNode.children, function (c) {
        return c.hasAttribute("data-seq-step");
      }).indexOf(st);
      return { el: st, i: i };
    });
    var n = steps.reduce(function (m, st) { return Math.max(m, st.i + 1); }, 1);
    var s = { el: el, steps: steps, n: n, i: -1 };
    el.style.setProperty("--steps", n);
    setSeq(s, 0);
    return s;
  }

  function update() {
    ticking = false;
    if (window.pageYOffset > 8) root.setAttribute("data-scrolled", "");
    else root.removeAttribute("data-scrolled");
    if (reduce) return;
    var vh = window.innerHeight || root.clientHeight;
    scrollEls.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var p = el.getAttribute("data-scroll") === "enter"
        ? (vh - r.top) / (vh * 0.8)
        : (vh - r.top) / (vh + r.height);
      p = clamp(p).toFixed(4);
      if (el._p !== p) { el._p = p; el.style.setProperty("--p", p); }
    });
    seqs.forEach(function (s) {
      var r = s.el.getBoundingClientRect();
      var p = clamp(-r.top / Math.max(1, r.height - vh));
      s.el.style.setProperty("--p", p.toFixed(4));
      var i = Math.min(s.n - 1, Math.floor(p * s.n));
      if (i !== s.i) setSeq(s, i);
    });
  }

  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }

  function refresh() {
    all("[data-reveal-stagger]").forEach(function (el) {
      Array.prototype.forEach.call(el.children, function (c, i) { c.style.setProperty("--i", i); });
    });
    all("[data-reveal]:not(.is-in),[data-reveal-stagger]:not(.is-in)").forEach(function (el) {
      if (revealIO) revealIO.observe(el); else el.classList.add("is-in");
    });
    scrollEls = all("[data-scroll]");
    seqs = all("[data-sequence]").map(initSeq);
    if (videoIO) all("video[data-autoplay]").forEach(function (v) { videoIO.observe(v); });
    update();
  }

  all("details.nav-menu").forEach(function (d) {
    var summary = d.querySelector("summary");
    d.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("a")) d.open = false;
    });
    doc.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && d.open) { d.open = false; if (summary) summary.focus(); }
    });
    doc.addEventListener("click", function (e) {
      if (d.open && !d.contains(e.target)) d.open = false;
    });
  });

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  window.addEventListener("load", onScroll);
  window.relayMotion = { reduce: reduce, refresh: refresh };
  refresh();
})();
