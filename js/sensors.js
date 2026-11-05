// WalkSense sensor engine: step and turn detection from DeviceMotion.
// Same algorithm as index.html and the same localStorage keys (walksenseTune,
// walksenseFlip), so thresholds tuned in the lab page apply here too.
//
//   const s = WalkSensors.create({onStep(t){}, onTurn(dir, deg){}, onTurning(deg){}, onIgnored(msg){}});
//   await s.start();  // must be called from a tap (iOS permission prompt)
//   s.stop();
(() => {
  const DEF = {warnPct:25, warnMin:4, earlyPct:50, earlyMin:6, turnDeg:30, startRate:12, keepRate:6, holdMs:500, cooldown:800, warmup:4, stepThr:0.6};
  const IOS = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function loadTune() {
    const T = {...DEF};
    try { const s = JSON.parse(localStorage.getItem('walksenseTune') || '{}') || {}; for (const k in DEF) if (s[k] != null && Number.isFinite(+s[k])) T[k] = +s[k]; } catch (_) {}
    return T;
  }

  function create(opts = {}) {
    const noop = () => {};
    const onStep = opts.onStep || noop, onTurn = opts.onTurn || noop, onTurning = opts.onTurning || noop, onIgnored = opts.onIgnored || noop;
    let T = loadTune(), flip = false;
    let active = false, tick = null, wakeLock = null;
    let g = null, lastT = 0, vS = 0, v1 = 0, v2 = 0, t1 = 0, ampAvg = 1.5, stepGap = 500;
    let lastStepAt = 0, pending = [], walking = false;
    let yawS = 0, seg = null, lastTurnAt = 0, yawBuf = [];
    const upSign = () => (IOS ? 1 : -1) * (flip ? -1 : 1);

    // ---- Steps ----
    // Buffered candidates are committed on a pause rather than thrown away (B-1).
    function flushPending() {
      if (pending.length < 2) return;
      const p = pending; pending = [];
      p.forEach(x => onStep(x));
    }
    function onStepCandidate(t, amp) {
      const gap = t - lastStepAt;
      const warmup = opts.warmup || Math.max(2, T.warmup);
      if (walking && gap > 1500) walking = false;
      if (gap > 4000) pending = [];
      else if (gap > 1200) flushPending();
      if (lastStepAt && gap >= 250 && gap <= 1200) stepGap = stepGap*0.7 + gap*0.3;
      lastStepAt = t; ampAvg = ampAvg*0.8 + amp*0.2;
      if (walking) onStep(t);
      else {
        pending.push(t);
        if (pending.length >= warmup) { walking = true; const p = pending; pending = []; p.forEach(x => onStep(x)); }
      }
    }
    // ---- Turns ----
    function finishTurn(now) {
      const s = seg; seg = null; onTurning(null);
      if (!s) return;
      const deg = Math.abs(s.angle), dur = now - s.start;
      const ok = walking || now-lastStepAt < 5000;
      if (deg >= T.turnDeg && dur < 6000 && ok && now-lastTurnAt > T.cooldown) { lastTurnAt = now; onTurn(s.angle > 0 ? 'L' : 'R', Math.round(deg)); }
      else if (deg >= 15) onIgnored(`Rotation of ${Math.round(deg)}° ignored (${deg < T.turnDeg ? 'below '+T.turnDeg+'° minimum' : !ok ? 'no recent steps' : 'too slow / cooldown'})`);
    }
    function trackTurn(yaw, ys, dt, now) {
      yawBuf.push({t:now, a:yaw*dt});
      while (yawBuf.length && now - yawBuf[0].t > 600) yawBuf.shift();
      if (!seg) {
        if (Math.abs(ys) <= T.startRate) return;
        seg = {angle: yawBuf.reduce((x,b)=>x+b.a,0), start:now, last:now, dir:Math.sign(ys)};
        yawBuf = [];
        return;
      }
      seg.angle += yaw*dt;
      if (Math.abs(ys) > T.keepRate && Math.sign(ys) === seg.dir) seg.last = now;
      else if (Math.abs(ys) > T.startRate) { finishTurn(now); return; }
      onTurning(Math.abs(Math.round(seg.angle)));
      if (now - seg.last > T.holdMs || now - seg.start > 6000) finishTurn(now);
    }
    function handleMotion(e) {
      if (!active) return;
      const ag = e.accelerationIncludingGravity;
      if (!ag || ag.x == null || ag.y == null || ag.z == null) return;
      const now = performance.now();
      const dt = lastT ? Math.min((now-lastT)/1000, 0.1) : 0.016; lastT = now;
      const a = [ag.x, ag.y, ag.z];
      if (!g) g = a.slice();
      const kg = dt/(0.6+dt);
      for (let i = 0; i < 3; i++) g[i] += kg*(a[i]-g[i]);
      const gm = Math.hypot(g[0],g[1],g[2]) || 9.81;
      const vert = (a[0]*g[0]+a[1]*g[1]+a[2]*g[2])/gm - gm;
      vS += dt/(0.04+dt)*(vert - vS);
      const thr = clamp(ampAvg*0.5, T.stepThr, 3);
      if (v1 > v2 && v1 >= vS && v1 > thr && t1 - lastStepAt > Math.max(250, stepGap*0.5)) onStepCandidate(t1, v1);
      v2 = v1; v1 = vS; t1 = now;
      const r = e.rotationRate;
      if (r) {
        const yaw = upSign()*((r.beta||0)*g[0] + (r.gamma||0)*g[1] + (r.alpha||0)*g[2])/gm; // +ve = left
        yawS += dt/(0.15+dt)*(yaw - yawS);
        trackTurn(yaw, yawS, dt, now);
      }
    }
    // Housekeeping that index.html does in its render tick.
    function housekeep() {
      const now = performance.now();
      if (walking && now - lastStepAt > 1500) { walking = false; ampAvg = 1.5; }
      if (pending.length && now - lastStepAt > 1200) flushPending();
      if (pending.length && now - lastStepAt > 4000) pending = [];
    }
    async function getWakeLock() { try { if (navigator.wakeLock && active) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {} }
    const onVis = () => { if (!document.hidden && active) getWakeLock(); };

    async function start() {
      if (active) return;
      if (!window.isSecureContext) throw new Error('HTTPS is required for sensor access.');
      const S = window.DeviceMotionEvent;
      if (!S) throw new Error('Motion sensors are not supported in this browser.');
      if (typeof S.requestPermission === 'function' && await S.requestPermission() !== 'granted') throw new Error('Sensor permission was not granted.');
      T = loadTune();
      try { flip = localStorage.getItem('walksenseFlip') === '1'; } catch (_) {}
      g = null; lastT = 0; vS = v1 = v2 = 0; ampAvg = 1.5; stepGap = 500; yawS = 0; yawBuf = [];
      walking = false; pending = []; seg = null; lastTurnAt = 0;
      lastStepAt = performance.now();
      active = true;
      window.addEventListener('devicemotion', handleMotion);
      document.addEventListener('visibilitychange', onVis);
      tick = setInterval(housekeep, 250);
      getWakeLock();
    }
    function stop() {
      if (!active) return;
      flushPending(); // commit any buffered steps before they are lost
      active = false; seg = null; onTurning(null);
      window.removeEventListener('devicemotion', handleMotion);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(tick); tick = null;
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }
    return {
      start, stop,
      get active() { return active; },
      get walking() { return walking; },
      // A manual turn starts the cooldown, like a detected one.
      noteTurn() { lastTurnAt = performance.now(); },
      // After undoing a turn, forget any half-tracked rotation.
      resetTurn() { seg = null; lastTurnAt = 0; },
    };
  }

  window.WalkSensors = {create, DEF};
})();
