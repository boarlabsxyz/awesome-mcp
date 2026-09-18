/* Awesome MCP docs — progressive enhancement only.
   Everything here is optional: the sidebar nav, heading anchors and code
   blocks are plain HTML and work with JS disabled. This file adds the
   on-this-page TOC, scrollspy, the mobile drawer, copy buttons and
   motion-gated video autoplay. */
(function () {
  'use strict';

  var HEADER_OFFSET = 72;

  // --- On-this-page TOC ---------------------------------------------------
  // The <aside> ships with `hidden` so no-JS readers get a clean two-column
  // layout instead of an empty "On this page" box.
  function buildToc() {
    var toc = document.getElementById('docs-toc');
    var main = document.getElementById('main');
    if (!toc || !main) return [];

    var headings = main.querySelectorAll('h2[id], h3[id]');
    if (headings.length < 2) return [];

    var list = document.createElement('ul');
    Array.prototype.forEach.call(headings, function (h) {
      var li = document.createElement('li');
      if (h.tagName === 'H3') li.className = 'docs-toc-h3';
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      li.appendChild(a);
      list.appendChild(li);
    });

    var nav = toc.querySelector('nav');
    if (!nav) return [];
    nav.appendChild(list);
    toc.hidden = false;
    return Array.prototype.slice.call(headings);
  }

  // --- Scrollspy ----------------------------------------------------------
  function initScrollspy(headings) {
    if (!headings.length || !('IntersectionObserver' in window)) return;

    var links = {};
    Array.prototype.forEach.call(
      document.querySelectorAll('#docs-toc a[href^="#"]'),
      function (a) { links[decodeURIComponent(a.hash.slice(1))] = a; }
    );

    var visible = Object.create(null);

    function highlight() {
      var current = null;
      for (var i = 0; i < headings.length; i++) {
        if (visible[headings[i].id]) { current = headings[i].id; break; }
      }
      for (var id in links) {
        var on = id === current;
        links[id].classList.toggle('active', on);
        if (on) links[id].setAttribute('aria-current', 'location');
        else links[id].removeAttribute('aria-current');
      }
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        visible[entry.target.id] = entry.isIntersecting;
      });
      highlight();
    }, { rootMargin: '-' + HEADER_OFFSET + 'px 0px -70% 0px' });

    headings.forEach(function (h) { observer.observe(h); });
  }

  // --- Mobile sidebar drawer ---------------------------------------------
  function initMenu() {
    var toggle = document.querySelector('.docs-menu-toggle');
    var sidebar = document.getElementById('docs-sidebar');
    if (!toggle || !sidebar) return;

    function setOpen(open) {
      sidebar.setAttribute('data-open', open ? 'true' : 'false');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    setOpen(false);

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      setOpen(false);
      toggle.focus();
    });

    // Following a link inside the drawer should close it.
    sidebar.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
  }

  // --- Copy buttons on code blocks ---------------------------------------
  function initCopyButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('.docs-pre-wrap'), function (wrap) {
      var pre = wrap.querySelector('pre');
      if (!pre) return;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-copy';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy code to clipboard');
      wrap.appendChild(btn);

      btn.addEventListener('click', function () {
        var text = pre.innerText;
        copy(text).then(function () {
          flash('copied', 'Copied!');
        }, function () {
          flash('copy-failed', 'Press Ctrl+C');
        });
      });

      function flash(cls, label) {
        btn.classList.add(cls);
        btn.textContent = label;
        setTimeout(function () {
          btn.classList.remove(cls);
          btn.textContent = 'Copy';
        }, 2000);
      }
    });

    function copy(text) {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        var ok;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        document.body.removeChild(ta);
        if (ok) { resolve(); } else { reject(new Error('copy failed')); }
      });
    }
  }

  // --- Video autoplay, gated ---------------------------------------------
  // Only clips explicitly marked data-autoplay, only when the reader has not
  // asked for reduced motion, and only while on screen. Never an autoplay
  // attribute in the markup — that would ignore the motion preference.
  function initVideos() {
    var videos = document.querySelectorAll('video[data-autoplay]');
    if (!videos.length) return;
    if (!('IntersectionObserver' in window)) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var v = entry.target;
        if (entry.isIntersecting) {
          var p = v.play();
          if (p && p.catch) p.catch(function () { /* autoplay refused; controls remain */ });
        } else {
          v.pause();
        }
      });
    }, { threshold: 0.4 });

    Array.prototype.forEach.call(videos, function (v) { observer.observe(v); });
  }

  initScrollspy(buildToc());
  initMenu();
  initCopyButtons();
  initVideos();
})();
