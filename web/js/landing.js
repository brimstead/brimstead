// Landing v2. Hero: masked SplitText, the jar nudging the letters. Pinned pour: the camera moves in over the mouth while
// the cobalt rises to the orange brim, then cuts to a side view as the part above the brim pours into the buyer's cup.
// Tools: horizontal pinned track. Marquee: scroll-velocity skew. Live Chainlink numbers tick or scramble in.
import { CONFIG } from '/config.js';
import { readFeeds, fmtUsd, fmtUtc } from '/js/feed.js';
import { initMotion, RM, counter, scramble, getSmoother } from '/js/motion.js';

const html = document.documentElement;
const GL = html.classList.contains('gl');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ───────────── live NVDA price (real or "price unavailable") ─────────────
const NVDA = CONFIG.stocks.find((s) => s.sym === 'NVDA');
const live = { price: null, updatedAt: null };
const AMOUNT = 10;
const STRIKE_UP = 1.05;

function drawReadout(q /* scenario price / strike */) {
  const K = live.price ? live.price * STRIKE_UP : null;
  $('[data-strike]').textContent = K ? fmtUsd(K) : 'live price × 1.05';
  $('[data-scn]').textContent = K ? fmtUsd(K * q) : `${(q * 100).toFixed(1)}% of strike`;
  const buyer = q > 1 ? (AMOUNT * (q - 1)) / q : 0;
  $('[data-buyer]').textContent = buyer.toFixed(3);
  $('[data-writer]').textContent = (AMOUNT - buyer).toFixed(3);
}
function drawLive() {
  const el = $('[data-live-price]');
  if (live.price) counter(el, live.price, fmtUsd, 1.4);
  else el.textContent = 'price unavailable';
  $('[data-live-time]').textContent = live.updatedAt ? fmtUtc(live.updatedAt) : '·';
}

// ───────────── marquee ─────────────
async function marquee() {
  const t1 = $('[data-mq-track]'), t2 = $('[data-mq-track2]');
  const item = (s, p, i) => `<div class="mq-item"><span class="s">${s.sym}</span><span class="p${p === null ? ' na' : ''}" data-mqp="${i}">${p === undefined ? '·' : p ? fmtUsd(p.price) : 'price unavailable'}</span></div>`;
  const draw = (prices, scr) => {
    const row = CONFIG.stocks.map((s, i) => item(s, prices ? prices[s.feed] : undefined, i)).join('');
    t1.innerHTML = row + row;
    t2.innerHTML = [...CONFIG.stocks].reverse().map((s, i) => item(s, prices ? prices[s.feed] : undefined, i)).join('').repeat(2);
    if (scr) $$('.mq [data-mqp]').forEach((el) => !el.classList.contains('na') && scramble(el, el.textContent, 1));
  };
  draw(null);
  const prices = await readFeeds(CONFIG.stocks.map((s) => s.feed));
  const n = prices[NVDA.feed];
  if (n) { live.price = n.price; live.updatedAt = n.updatedAt; }
  draw(prices, true);
  return prices;
}
function runMarquee() {
  if (RM) return;
  const tracks = [[$('[data-mq-track]'), -1], [$('[data-mq-track2]'), 1]];
  const pos = [0, 0];
  let boost = 0;
  const skew = $$('.mq').map((el) => gsap.quickTo(el, 'skewX', { duration: 0.5, ease: 'power3' }));
  ScrollTrigger.create({
    trigger: '.marquee', start: 'top bottom', end: 'bottom top',
    onUpdate: (st) => {
      const v = st.getVelocity();
      boost = Math.min(5, Math.abs(v) / 350);
      skew.forEach((f, i) => f(gsap.utils.clamp(-10, 10, (v / 300) * (i ? 1 : -1))));
    },
    onLeave: () => skew.forEach((f) => f(0)), onLeaveBack: () => skew.forEach((f) => f(0)),
  });
  gsap.ticker.add((_, dt) => {
    boost *= 0.95;
    tracks.forEach(([el, dir], i) => {
      const half = el.scrollWidth / 2 || 1;
      pos[i] += dir * (0.045 + boost * 0.06) * dt;
      const x = ((pos[i] % half) + half) % half;
      el.style.transform = `translate3d(${dir < 0 ? -x : x - half}px,0,0)`;
    });
  });
}

// ───────────── showcase ─────────────
async function showcase() {
  const box = $('[data-offers]');
  const done = (h) => { box.innerHTML = h; box.removeAttribute('aria-busy'); };
  const empty = (title, body) =>
    `<div class="empty"><div><h3>${title}</h3><p>${body}</p></div><a class="btn btn-hot" href="/app/#write">Write the first offer <span class="arr">→</span></a></div>`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(CONFIG.contracts.vault || '')) {
    return done(empty('Contracts deploy before launch.', 'The vault address appears here once BrimVault is deployed. No offer is shown that does not exist on chain.'));
  }
  try {
    const c = await import('/js/contract.js');
    const offers = (await c.getOffers({ limit: 200 })).filter((o) => c.isBuyable(o)).slice(0, 6);
    if (!offers.length) return done(empty('No open offers right now.', 'Every offer listed here is read from BrimVault. Lock stock tokens and set a strike to put the first one on the shelf.'));
    const day = (t) => new Date(t * 1000).toLocaleString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    done(offers.map((o) => `<a class="offer" href="/app/#buy">
      <span class="sym">${o.stock ? o.stock.sym : 'Token'}</span>
      <span><span class="k">Strike</span><span class="v hot">${fmtUsd(Number(o.strike) / 1e8)}</span></span>
      <span><span class="k">Expiry</span><span class="v">${day(o.expiry)} ${fmtUtc(o.expiry)}</span></span>
      <span><span class="k">Premium / token</span><span class="v cobalt">${Number(c.formatUnits(o.premiumPerToken, 18)).toPrecision(4)} ETH</span></span>
      <span><span class="k">Writer</span><span class="v">${o.writer.slice(0, 6)}…${o.writer.slice(-4)}</span></span></a>`).join(''));
  } catch {
    done(`<p class="muted mono">Could not read the vault right now. Nothing is shown rather than a guess.</p>`);
  }
  if (window.gsap && !RM) gsap.from(box.children, { y: 24, opacity: 0, stagger: 0.06, duration: 0.6, ease: 'power3.out' });
}

// ───────────── hero ─────────────
let heroSplit = null;
function splitHero() {
  heroSplit = $$('.hero-h .hl').map((l) => new SplitText(l, { type: 'lines,words,chars', charsClass: 'char', mask: 'lines', aria: 'none' }));
  const chars = heroSplit.flatMap((s) => s.chars);
  const masks = heroSplit.flatMap((s) => s.masks || []);
  if (!RM) {
    gsap.from(chars, {
      yPercent: 115, rotate: 6, duration: 1, ease: 'power4.out', stagger: 0.022, delay: 0.15,
      onComplete: () => masks.forEach((m) => (m.style.overflow = 'visible')), // let the jar push letters past the line box
    });
    gsap.from('.hero-eyebrow, .hero-foot > *, .hero-ca', { y: 24, opacity: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08, delay: 0.6 });
  } else masks.forEach((m) => (m.style.overflow = 'visible'));
  return chars;
}

function typeInteraction(stage, chars) {
  const h1 = $('.hero-h');
  let boxes = [];
  const measure = () => {
    const o = h1.getBoundingClientRect();
    boxes = chars.map((el) => {
      el.style.translate = '';
      const r = el.getBoundingClientRect();
      return { el, x: r.left + r.width / 2 - o.left, y: r.top + r.height / 2 - o.top, dx: 0, dy: 0 };
    });
  };
  // measure once the intro has landed (chars are offset while they slide in)
  setTimeout(measure, RM ? 0 : 1900);
  addEventListener('resize', () => requestAnimationFrame(measure));
  stage.onFrame((s) => {
    if (!boxes.length) return;
    const o = h1.getBoundingClientRect();
    if (o.bottom < -50) return;
    const R = s.r * 1.3;
    for (const b of boxes) {
      const vx = b.x + o.left - s.x, vy = b.y + o.top - s.y;
      const d = Math.hypot(vx, vy) || 1;
      const f = d < R ? Math.pow(1 - d / R, 2) : 0;
      const tx = (vx / d) * f * 64, ty = (vy / d) * f * 40;
      b.dx += (tx - b.dx) * 0.12; b.dy += (ty - b.dy) * 0.12;
      if (Math.abs(b.dx) > 0.05 || Math.abs(b.dy) > 0.05) b.el.style.translate = `${b.dx.toFixed(1)}px ${b.dy.toFixed(1)}px`;
      else if (b.el.style.translate) b.el.style.translate = '';
    }
  });
}

// Desktop hero: the jar sits just right of "brim." (lip at the word's mid-height), sized to the space that is left.
function heroKey() {
  const w = innerWidth, h = innerHeight;
  // the second headline line, measured from its split chars (x is not affected by the intro's vertical slide)
  const line = $('.hero-h .hl-2').getBoundingClientRect();
  const chars = [...document.querySelectorAll('.hero-h .hl-2 .char')];
  const right = chars.length ? Math.max(...chars.map((c) => c.getBoundingClientRect().right)) : line.right;
  const r = { right, top: line.top, height: line.height };
  // a confident hero: ~40–45% of the viewport height, as wide as the space right of "brim." allows
  const size = Math.max(0.3, Math.min(0.46, (w - 32 - r.right) / (0.94 * h * 1.2)));
  const hw = 0.47 * size * h;
  const cx = Math.min(r.right + hw * 1.12, w - hw - 32);
  // vertically centred on the headline block, a little low so the lip sits beside "brim."
  const block = $('.hero-h').getBoundingClientRect();
  const sy = getSmoother() ? getSmoother().scrollTop() : scrollY;
  const cy = sy + (block.top + block.bottom) / 2 + 0.16 * size * h;
  return { x: (cx / w) * 2 - 1, y: -((cy / h) * 2 - 1), size };
}

// ───────────── statement ─────────────
function statement() {
  if (RM) return;
  const st = new SplitText('.statement-h', { type: 'words', wordsClass: 'word', aria: 'auto' });
  gsap.from(st.words, { opacity: 0.1, y: 12, stagger: 0.08, ease: 'none', scrollTrigger: { trigger: '.statement-h', start: 'top 82%', end: 'bottom 50%', scrub: true } });
}

// ───────────── feature steps ─────────────
const COPY = [
  'The writer locks stock tokens and sets a strike. The brim is the strike.',
  'The buyer has paid the ETH premium; it waits in escrow. Below the brim, every token stays with the writer.',
  'At the Friday 21:00 UTC close, the part above the strike pours to the buyer. The writer keeps the rest, and the premium minus the 1% fee.',
];
function setStep(i) {
  $$('.fstep').forEach((el) => el.classList.toggle('is-on', +el.dataset.step === i));
  $$('.fsteps li').forEach((el, k) => el.classList.toggle('is-on', k <= i));
  const c = $('[data-copy]');
  c.textContent = COPY[i];
  if (window.gsap && !RM) gsap.fromTo(c, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4 });
}

// ───────────── tools: horizontal pinned track ─────────────
function tools() {
  if (RM) { html.classList.add('tools-static'); return; }
  const track = $('.tool-track'), view = $('.tool-viewport');
  const dist = () => Math.max(0, track.scrollWidth - view.clientWidth);
  const st = { trigger: '.tools', start: 'top top', end: () => '+=' + Math.max(dist(), innerHeight * 0.6), pin: '.tools-pin', scrub: 0.6, invalidateOnRefresh: true, anticipatePin: 1 };
  const tw = gsap.to(track, { x: () => -dist(), ease: 'none', scrollTrigger: st });
  gsap.fromTo('.tools-rail line', { drawSVG: '0%' }, { drawSVG: '100%', ease: 'none', scrollTrigger: { ...st, pin: false } });
  $$('.tool').forEach((card, i) =>
    gsap.from(card, { yPercent: 18, rotate: 2.5, opacity: 0.35, ease: 'power2.out',
      scrollTrigger: { trigger: card, containerAnimation: tw, start: 'left 98%', end: 'left 62%', scrub: true } })
  );
}

// ───────────── 3D scenes ─────────────
function scrollScenes(stage) {
  const s = stage.state;
  const mm = gsap.matchMedia();
  mm.add({ desk: '(min-width: 861px)', mob: '(max-width: 860px)' }, (ctx) => {
    const { desk } = ctx.conditions;
    const K = desk
      ? { hero: heroKey(), stat: { x: 0.8, y: -0.5, size: 0.28 }, ring: { rx: 0.62, ry: 0.5, rsize: 0.26 },
          feat: { x: 0.4, y: -0.2, size: 0.56 }, close: { x: 0.4, y: -0.3, size: 0.64 }, side: { x: 0.18, y: -0.08, size: 0.44 },
          park: { x: 0.82, y: 0.62, size: 0.14 } }
      : { hero: { x: 0.66, y: 0.4, size: 0.15 }, stat: { x: -0.4, y: -0.6, size: 0.2 }, ring: { rx: 0.45, ry: -0.55, rsize: 0.2 },
          feat: { x: 0, y: 0.5, size: 0.22 }, close: { x: 0, y: 0.46, size: 0.27 }, side: { x: -0.3, y: 0.55, size: 0.18 },
          park: { x: 0.7, y: 0.8, size: 0.08 } };
    // Three sources, one writer: `sc` (scene timelines, before the pin), `pc` (the pinned pour), `pk` (parking after).
    // A scrubbed timeline renders its from-values at progress 0, so each phase owns its own object and mix() decides.
    const sc = { ...K.hero, yaw: 0, elev: 0.42, baseLevel: 0.86, ring: 0 };
    const pc = { ...K.feat, yaw: 0, elev: 0.82, pourLevel: 0, spill: 0, cup: 0, cupFill: 0 };
    const pk = { t: 0 };
    stage.scene = sc;
    Object.assign(s, K.ring, { visible: 1, opacity: 1 });
    const onRefresh = () => { if (desk && (getSmoother() ? getSmoother().scrollTop() : scrollY) < 10) Object.assign(sc, heroKey()); };
    ScrollTrigger.addEventListener('refreshInit', onRefresh);

    // hero → statement: the jar steps aside, the glazed ring floats in
    gsap.timeline({ scrollTrigger: { trigger: '.statement', start: 'top bottom', end: 'center center', scrub: 0.8, invalidateOnRefresh: true } })
      .to(sc, { ...K.stat, baseLevel: 0.35, elev: 0.5, yaw: 0.6, ease: 'power2.inOut' }, 0)
      .to(sc, { ring: 1, ease: 'back.out(1.6)' }, 0.25);

    // statement → pour: three-quarter view, then over the mouth
    gsap.timeline({ scrollTrigger: { trigger: '.feature', start: 'top bottom', end: 'top top', scrub: 0.8 } })
      .to(sc, { ...K.feat, yaw: 0, elev: 0.82, baseLevel: 0.0, ease: 'power2.inOut' }, 0)
      .to(sc, { ring: 0, ease: 'power2.in' }, 0);

    // pinned pour
    const pour = { p: 0 };
    let step = -1;
    const tl = gsap.timeline({
      scrollTrigger: { trigger: '.feature', start: 'top top', end: desk ? '+=300%' : '+=240%', pin: '.feature-pin', scrub: 0.7, anticipatePin: 1 },
      onUpdate: () => {
        const p = pour.p;
        const i = p < 0.22 ? 0 : p < 0.56 ? 1 : 2;
        if (i !== step) { step = i; setStep(i); }
        const q = p < 0.22 ? 1 / STRIKE_UP : p < 0.56 ? 1 / STRIKE_UP + ((p - 0.22) / 0.34) * (1 - 1 / STRIKE_UP) : 1 + ((p - 0.56) / 0.44) * 0.1;
        drawReadout(q);
      },
    });
    const at = (v, t) => ({ ...v, immediateRender: false, duration: t });
    tl.fromTo(pour, { p: 0 }, { p: 1, ease: 'none', duration: 1 }, 0)
      // 1 · fill, camera settles over the mouth
      .fromTo(pc, { pourLevel: 0 }, at({ pourLevel: 0.42, ease: 'power2.in' }, 0.22), 0)
      .fromTo(pc, { ...K.feat, elev: 0.82 }, at({ ...K.close, elev: 1.02, ease: 'power1.inOut' }, 0.5), 0)
      // 2 · rise to the brim with a small overshoot, the strike line draws
      .fromTo(pc, { pourLevel: 0.42 }, at({ pourLevel: 1.03, ease: 'power2.in' }, 0.3), 0.24)
      .fromTo('.strike-line line', { drawSVG: '0%' }, at({ drawSVG: '100%', ease: 'power2.inOut' }, 0.3), 0.24)
      .fromTo(pc, { pourLevel: 1.03 }, at({ pourLevel: 1.0, ease: 'power1.out' }, 0.04), 0.54)
      // 3 · cut to the side view, the cup appears, the brim spills
      .fromTo(pc, { ...K.close, elev: 1.02, yaw: 0 }, at({ ...K.side, elev: 0.12, yaw: 0.43, ease: 'expo.inOut' }, 0.05), 0.56)
      .fromTo(pc, { cup: 0 }, at({ cup: 1, ease: 'back.out(2)' }, 0.06), 0.58)
      .fromTo(pc, { pourLevel: 1.0, spill: 0 }, at({ pourLevel: 1.1, spill: 1, ease: 'power2.out' }, 0.16), 0.62)
      .fromTo(pc, { cupFill: 0 }, at({ cupFill: 1, ease: 'power1.inOut' }, 0.3), 0.66);
    const pin = tl.scrollTrigger;

    // pour → tools: the jar settles small in a corner behind the next sections, then rendering stops
    gsap.fromTo(pk, { t: 0 }, { t: 1, ease: 'power2.inOut', immediateRender: false, scrollTrigger: { trigger: '.tools', start: 'top bottom', end: 'top top', scrub: 0.8 } });
    ScrollTrigger.create({ trigger: '.tools', start: 'top top', onEnter: () => (s.visible = 0), onLeaveBack: () => (s.visible = 1) });

    const CAM = ['x', 'y', 'size', 'elev', 'yaw'];
    const parkTo = { ...K.park, elev: 0.5, yaw: 0 };
    const mix = () => {
      if (window.__brimFreeze) return; // asset render scripts pose the jar by hand
      const pinned = pin.progress > 0;
      const src = pinned ? pc : sc;
      for (const k of CAM) s[k] = src[k];
      s.level = pinned ? pc.pourLevel : sc.baseLevel;
      s.spill = pinned ? pc.spill : 0;
      s.cup = pinned ? pc.cup : 0;
      s.cupFill = pinned ? pc.cupFill : 0;
      s.ring = sc.ring;
      const t = pk.t;
      if (t > 0) for (const k of CAM) s[k] += (parkTo[k] - s[k]) * t;
      s.opacity = 1 - t;
    };
    mix();
    gsap.ticker.add(mix);
    return () => { gsap.ticker.remove(mix); ScrollTrigger.removeEventListener('refreshInit', onRefresh); };
  });
}

function staticFeature() {
  setStep(2);
  drawReadout(1.06);
}

// ───────────── boot ─────────────
(async function boot() {
  const pricesP = marquee().catch(() => ({}));
  showcase();
  drawReadout(1 / STRIKE_UP);
  const ok = await initMotion(); // smoother first, then every ScrollTrigger below
  pricesP.then(() => { drawLive(); drawReadout(1 / STRIKE_UP); ok && ScrollTrigger.refresh(); });
  if (!ok) { staticFeature(); return; }
  const chars = splitHero();
  statement();
  tools();
  runMarquee();
  if (!GL) { staticFeature(); pricesP.then(() => drawReadout(1.06)); ScrollTrigger.refresh(); return; }
  let stage;
  try {
    const { createStage } = await import('/js/vessel.js');
    stage = createStage($('#stage'));
  } catch (e) {
    console.warn('3D unavailable, static fallback', e);
    html.classList.replace('gl', 'no-gl');
    staticFeature();
    return;
  }
  typeInteraction(stage, chars);
  scrollScenes(stage);
  ScrollTrigger.sort(); // the pour pin sits above the tools pin on the page but is created after it
  ScrollTrigger.refresh();
  if (!RM && stage.scene) gsap.from(stage.scene, { size: stage.scene.size * 0.7, baseLevel: 0, duration: 1.6, ease: 'power3.out', delay: 0.2 });
  window.__brimStage = stage; // used by the asset render + perf scripts
})();
