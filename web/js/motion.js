// Shared motion layer (every page). GSAP 3.13 + ScrollTrigger, SplitText, Flip, ScrollSmoother, ScrambleText, DrawSVG,
// MorphSVG. Everything here degrades to static content without GSAP and is skipped under prefers-reduced-motion.
const html = document.documentElement;
export const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
let smoother = null;
export const getSmoother = () => smoother;

export const gsapReady = () =>
  new Promise((res) => {
    const ok = () => window.gsap && window.ScrollTrigger && window.SplitText;
    if (ok()) return res(true);
    addEventListener('load', () => res(!!ok()), { once: true });
  });

function register() {
  const g = window.gsap;
  const plugins = ['ScrollTrigger', 'SplitText', 'Flip', 'ScrollSmoother', 'ScrambleTextPlugin', 'DrawSVGPlugin', 'MorphSVGPlugin']
    .map((n) => window[n]).filter(Boolean);
  g.registerPlugin(...plugins);
  g.defaults({ ease: 'power2.out' });
}

// ───────────── page wipe (kiln orange) between pages ─────────────
function wipe() {
  const el = document.createElement('div');
  el.className = 'wipe';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<span class="wipe-mark"></span>';
  document.body.appendChild(el);
  let came = false;
  try { came = sessionStorage.getItem('brim-wipe') === '1'; sessionStorage.removeItem('brim-wipe'); } catch {}
  if (came && !RM) {
    gsap.set(el, { yPercent: 0 });
    gsap.to(el, { yPercent: -100, duration: 0.7, ease: 'power3.inOut', delay: 0.05 });
  } else gsap.set(el, { yPercent: 100 });
  if (RM) return;
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || a.target === '_blank') return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || (u.pathname === location.pathname && u.hash) || u.pathname === location.pathname && !u.hash) return;
    if (/\.(png|svg|json|js|glb)$/.test(u.pathname)) return;
    e.preventDefault();
    try { sessionStorage.setItem('brim-wipe', '1'); } catch {}
    gsap.fromTo(el, { yPercent: 100 }, { yPercent: 0, duration: 0.55, ease: 'power3.inOut', onComplete: () => (location.href = u.href) });
  });
  addEventListener('pageshow', (e) => { if (e.persisted) gsap.set(el, { yPercent: 100 }); });
}

// ───────────── cursor (desktop only) ─────────────
function cursor() {
  if (!FINE || RM) return;
  const c = document.createElement('div');
  c.className = 'cursor';
  c.setAttribute('aria-hidden', 'true');
  document.body.appendChild(c);
  html.classList.add('has-cursor');
  const xTo = gsap.quickTo(c, 'x', { duration: 0.18, ease: 'power3' });
  const yTo = gsap.quickTo(c, 'y', { duration: 0.18, ease: 'power3' });
  addEventListener('pointermove', (e) => { xTo(e.clientX); yTo(e.clientY); }, { passive: true });
  const SEL = 'a, button, select, input, textarea, summary, label, [role="tab"], .chip';
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest(SEL);
    c.classList.toggle('is-link', !!t && !t.matches('input, textarea, select'));
    c.classList.toggle('is-text', !!t && t.matches('input, textarea'));
  });
  document.addEventListener('pointerdown', () => c.classList.add('is-down'));
  document.addEventListener('pointerup', () => c.classList.remove('is-down'));
  document.addEventListener('pointerleave', () => gsap.to(c, { opacity: 0, duration: 0.2 }));
  document.addEventListener('pointerenter', () => gsap.to(c, { opacity: 1, duration: 0.2 }));
}

// ───────────── magnetic CTAs (desktop) ─────────────
export function magnetic(root = document) {
  if (!FINE || RM) return;
  root.querySelectorAll('.btn-hot, .btn-mag').forEach((b) => {
    if (b.__mag) return;
    b.__mag = true;
    const xTo = gsap.quickTo(b, 'x', { duration: 0.4, ease: 'power3' });
    const yTo = gsap.quickTo(b, 'y', { duration: 0.4, ease: 'power3' });
    b.addEventListener('pointermove', (e) => {
      const r = b.getBoundingClientRect();
      xTo((e.clientX - r.left - r.width / 2) * 0.28);
      yTo((e.clientY - r.top - r.height / 2) * 0.4);
    });
    b.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
  });
}

// ───────────── headings: masked line reveals ─────────────
export function revealHeadings(root = document) {
  if (RM) return;
  root.querySelectorAll('h1, h2, h3.reveal').forEach((h) => {
    if (h.dataset.split === 'custom' || h.__split) return;
    h.__split = true;
    const st = new SplitText(h, { type: 'lines', mask: 'lines', linesClass: 'ln' });
    gsap.from(st.lines, {
      yPercent: 105, duration: 0.9, ease: 'power3.out', stagger: 0.08,
      scrollTrigger: { trigger: h, start: 'top 88%', once: true },
    });
  });
  root.querySelectorAll('[data-stagger]').forEach((g) => {
    if (g.__st) return;
    g.__st = true;
    gsap.from(g.children, {
      y: 36, opacity: 0, duration: 0.8, ease: 'power3.out', stagger: 0.07,
      scrollTrigger: { trigger: g, start: 'top 88%', once: true },
    });
  });
  root.querySelectorAll('svg.draw path, svg.draw line').forEach((p) => {
    if (p.__draw) return;
    p.__draw = true;
    gsap.from(p, { drawSVG: '0%', duration: 1.1, ease: 'power2.inOut', scrollTrigger: { trigger: p.closest('svg'), start: 'top 90%', once: true } });
  });
}

// ───────────── numbers ─────────────
/** Tick a number up from 0 (or its previous value) to `to`, formatting each frame. */
export function counter(el, to, fmt, dur = 1.2) {
  if (!el) return;
  if (RM || !window.gsap || !isFinite(to)) { el.textContent = fmt(to); return; }
  const o = { v: el.__v ?? 0 };
  gsap.to(o, { v: to, duration: dur, ease: 'power2.out', onUpdate: () => (el.textContent = fmt(o.v)), onComplete: () => (el.__v = to) });
}
/** Scramble text in (ScrambleText). */
export function scramble(el, text, dur = 0.9) {
  if (!el) return;
  if (RM || !window.ScrambleTextPlugin) { el.textContent = text; return; }
  gsap.to(el, { duration: dur, scrambleText: { text, chars: '0123456789abcdef', speed: 0.6, revealDelay: 0.15 }, ease: 'none' });
}

// ───────────── logo: draw on load, drop morphs on hover ─────────────
function logo() {
  document.querySelectorAll('.mark').forEach((svg) => {
    const outline = svg.querySelector('.mark-outline');
    const fills = svg.querySelectorAll('.mark-fill');
    const drop = svg.querySelector('.mark-drop');
    if (!RM && outline && window.DrawSVGPlugin) {
      gsap.timeline({ delay: 0.15 })
        .set(fills, { opacity: 0 })
        .fromTo(outline, { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.9, ease: 'power2.inOut' })
        .to(fills, { opacity: 1, duration: 0.35, stagger: 0.06 }, '-=0.25')
        .to(outline, { opacity: 0, duration: 0.3 }, '-=0.2')
        .from(drop, { y: -6, scale: 0.4, transformOrigin: '50% 0%', duration: 0.5, ease: 'back.out(3)' }, '-=0.3');
    } else if (outline) outline.style.opacity = 0;
    if (!RM && drop && window.MorphSVGPlugin) {
      const host = svg.closest('a') || svg;
      const orig = drop.getAttribute('d');
      const long = 'M55.75 24.5s3.2 7.6 3.2 11.4a3.2 3.2 0 0 1-6.4 0c0-3.8 3.2-11.4 3.2-11.4z';
      host.addEventListener('pointerenter', () => gsap.to(drop, { morphSVG: long, duration: 0.45, ease: 'power2.inOut' }));
      host.addEventListener('pointerleave', () => gsap.to(drop, { morphSVG: orig, duration: 0.6, ease: 'elastic.out(1, 0.45)' }));
    }
  });
}

// ───────────── CA slot ─────────────
function caScramble() {
  document.querySelectorAll('.ca-val').forEach((el) => scramble(el, el.textContent, 1.1));
}

// ───────────── mobile nav ─────────────
function navMotion() {
  const nav = document.querySelector('#nav');
  const tog = nav && nav.querySelector('.nav-toggle');
  if (!tog || RM) return;
  tog.addEventListener('click', () => {
    if (nav.classList.contains('open')) gsap.from(nav.querySelectorAll('.nav-menu a'), { y: 14, opacity: 0, duration: 0.4, stagger: 0.04, ease: 'power3.out' });
  });
}

// ───────────── smooth scroll ─────────────
function smooth() {
  if (RM || !window.ScrollSmoother || !document.querySelector('#smooth-wrapper')) return;
  if (matchMedia('(pointer: coarse)').matches) return; // native scroll on touch
  smoother = ScrollSmoother.create({ wrapper: '#smooth-wrapper', content: '#smooth-content', smooth: 1.1, effects: true, smoothTouch: false, normalizeScroll: false });
  // in-page anchors through the smoother
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href*="#"]');
    if (!a) return;
    const u = new URL(a.href, location.href);
    if (u.pathname !== location.pathname || !u.hash) return;
    const t = document.querySelector(u.hash);
    if (!t) return;
    e.preventDefault();
    smoother.scrollTo(t, true, 'top 80px');
    history.replaceState(null, '', u.hash);
  });
}

export async function initMotion({ headings = true } = {}) {
  const ok = await gsapReady();
  if (!ok) { html.classList.add('no-gsap'); return false; }
  register();
  wipe();
  smooth();
  cursor();
  magnetic();
  logo();
  navMotion();
  if (document.fonts) await document.fonts.ready.catch(() => {});
  if (headings) revealHeadings();
  caScramble();
  if (location.hash && smoother) {
    const t = document.querySelector(location.hash);
    if (t) setTimeout(() => smoother.scrollTo(t, false, 'top 80px'), 50);
  }
  return true;
}
