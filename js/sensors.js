// WalkSense sensor engine: step and turn detection from DeviceMotion.
// Same algorithm as index.html and the same localStorage keys (walksenseTune,
// walksenseFlip), so thresholds tuned in the lab page apply here too.
//
//   const s = WalkSensors.create({onStep(t){}, onTurn(dir, deg, after){}, onTurning(deg){}, onIgnored(msg){}});
//   headingTurns:true also detects slow, gradual turns from the net change in heading across
//   steps. `after` is how many steps were already walked past the turn's midpoint when it
//   was reported, so the caller can credit them to the next stretch.
//   confirmStill:true holds back a rotation made while standing until the walker takes a couple
//   of steps in the new direction, so looking around after stopping is not taken for a turn.
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
    // Heading (deg, +ve = left) integrated from the gyro, and the heading at each committed step.
    // Only steps with i >= baseI belong to the current straight; settling absorbs the tail of an arc.
    let heading = 0, steps = [], stepI = 0, baseI = 0, settling = false;
    // Anchored turn: a turn toward `dir` measured from a known heading, with no steps needed.
    let anchor = null;
    // Rotation made standing still, awaiting steps: h0 = heading before it, i = first step after it.
    let standTurn = null;
    const CONFIRM_N = 2;
    const useHeading = !!opts.headingTurns, confirmStill = !!opts.confirmStill;
    const upSign = () => (IOS ? 1 : -1) * (flip ? -1 : 1);

    // ---- Steps ----
    // Buffered candidates are committed on a pause rather than thrown away (B-1).
    function flushPending() {
      if (pending.length < 2) return;
      const p = pending; pending = [];
      p.forEach(commit);
    }
    function commit(x) {
      steps.push({i: stepI++, t: x.t, h: x.h});
      if (steps.length > 40) steps.shift();
      onStep(x.t);
      if (standTurn) checkStandTurn(x.t);
      if (useHeading) checkHeadingTurn(x.t);
    }
    function onStepCandidate(t, amp) {
      const gap = t - lastStepAt;
      const warmup = opts.warmup || Math.max(2, T.warmup);
      if (walking && gap > 1500) walking = false;
      if (gap > 4000) pending = [];
      else if (gap > 1200) flushPending();
      if (lastStepAt && gap >= 250 && gap <= 1200) stepGap = stepGap*0.7 + gap*0.3;
      lastStepAt = t; ampAvg = ampAvg*0.8 + amp*0.2;
      const x = {t, h: heading};
      if (walking) commit(x);
      else {
        pending.push(x);
        if (pending.length >= warmup) { walking = true; const p = pending; pending = []; p.forEach(commit); }
      }
    }
    // ---- Turns ----
    // Steps walked since the heading passed the midpoint of a turn of `deg` (signed).
    function stepsAfter(deg) {
      let n = 0;
      for (let k = steps.length-1; k >= 0 && steps[k].i >= baseI; k--) {
        if (Math.sign(deg)*(heading - steps[k].h) < Math.abs(deg)/2) n++; else break;
      }
      return n;
    }
    function emit(deg, now) {
      const after = stepsAfter(deg);
      lastTurnAt = now; settling = true; baseI = stepI; anchor = null; standTurn = null;
      onTurn(deg > 0 ? 'L' : 'R', Math.round(Math.abs(deg)), after);
    }
    // Steady = the last 5 steps lie within 10°, i.e. under ~2°/step. A slow arc turns 3-4° a step,
    // so it only counts as steady once it has really ended and is reported once, in full.
    const SETTLE = 10, SETTLE_N = 5, WIN = 20;
    function settled(n) {
      if (n < SETTLE_N-1) return false;
      const hs = steps.slice(n-SETTLE_N+1, n+1).map(x => x.h);
      return Math.max(...hs) - Math.min(...hs) < SETTLE;
    }
    // Gradual turns never reach startRate, or get split into pieces below turnDeg. Compare the
    // heading of the last 3 (steady) steps with the start of the current straight instead.
    function checkHeadingTurn(now) {
      const n = steps.length-1;
      if (!settled(n)) return;
      if (settling) { settling = false; baseI = steps[n-SETTLE_N+1].i; return; }
      let k0 = n;
      while (k0 > 0 && n-k0 < WIN && steps[k0-1].i >= baseI) k0--;
      if (n-k0 < SETTLE_N+1) return;
      const deg = (steps[n].h + steps[n-1].h + steps[n-2].h)/3 - (steps[k0].h + steps[k0+1].h)/2;
      if (Math.abs(deg) < T.turnDeg || seg || now-lastTurnAt <= T.cooldown) return;
      emit(deg, now);
    }
    // A standing rotation counts only if the walker then steps off in the new direction. The net
    // heading is measured from before the first rotation, so a look left and back cancels out.
    function checkStandTurn(now) {
      const st = standTurn, after = steps.filter(x => x.i >= st.i);
      if (after.length < CONFIRM_N) return;
      standTurn = null;
      const net = after.reduce((a, x) => a + x.h, 0)/after.length - st.h0;
      if (Math.abs(net) >= T.turnDeg && !seg && now-lastTurnAt > T.cooldown) emit(net, now);
      else onIgnored(`Rotation while standing not followed by walking that way (net ${Math.round(Math.abs(net))}°), ignored`);
    }
    function finishTurn(now) {
      const s = seg; seg = null; onTurning(null);
      if (!s) return;
      const deg = Math.abs(s.angle), dur = now - s.start;
      // No step for longer than any step gap: the walker had stopped, maybe just to look around.
      const still = !walking || now-lastStepAt > 1200;
      const ok = confirmStill || walking || now-lastStepAt < 5000;
      if (deg >= T.turnDeg && dur < 6000 && ok && now-lastTurnAt > T.cooldown) {
        if (confirmStill && still) {
          if (standTurn) standTurn.i = stepI; else standTurn = {h0: s.h0, i: stepI};
          onIgnored(`Rotation of ${Math.round(deg)}° while standing: waiting for steps to confirm the turn`);
        } else emit(s.angle, now);
      } else if (deg >= 15) onIgnored(`Rotation of ${Math.round(deg)}° ignored (${deg < T.turnDeg ? 'below '+T.turnDeg+'° minimum' : !ok ? 'no recent steps' : 'too slow / cooldown'})`);
    }
    function trackTurn(yaw, ys, dt, now) {
      yawBuf.push({t:now, a:yaw*dt});
      while (yawBuf.length && now - yawBuf[0].t > 600) yawBuf.shift();
      if (!seg) {
        if (Math.abs(ys) <= T.startRate) return;
        const pre = yawBuf.reduce((x,b)=>x+b.a,0);
        seg = {angle: pre, start:now, last:now, dir:Math.sign(ys), h0: heading - pre};
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
        heading += yaw*dt;
        trackTurn(yaw, yawS, dt, now);
        // Report once the rotation has stopped, so the angle is the whole turn.
        if (anchor && anchor.sg*(heading - anchor.h) >= anchor.min && Math.abs(yawS) < T.keepRate && now-lastTurnAt > T.cooldown) {
          onIgnored(`Turn measured from the reference heading: ${Math.round(Math.abs(heading - anchor.h))}°`);
          emit(heading - anchor.h, now);
        }
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
      heading = 0; steps = []; baseI = stepI; settling = false; anchor = null; standTurn = null;
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
      resetTurn() { seg = null; lastTurnAt = 0; baseI = stepI; settling = false; standTurn = null; },
      // For a turn confirmed by hand: look back over this straight for the largest heading change
      // toward `dir`. Returns {deg, after} (after = steps walked past its midpoint) or null.
      findTurn(dir, minDeg = 20) {
        const sg = dir === 'L' ? 1 : -1;
        let best = 0, bestK = -1;
        for (let k = steps.length-1; k >= 0 && steps[k].i >= baseI; k--) {
          const d = sg*(heading - steps[k].h);
          if (d > best) { best = d; bestK = k; }
        }
        if (best < minDeg) return null;
        let after = 0;
        for (let k = steps.length-1; k > bestK; k--) { if (sg*(heading - steps[k].h) < best/2) after++; else break; }
        return {deg: Math.round(best), after};
      },
      // Expect a turn toward `dir`, measured from the current heading, whether or not the walker
      // steps first. For turns made standing still, e.g. right after stepping out of the lift.
      armTurn(dir, minDeg = 45) { anchor = {h: heading, sg: dir === 'L' ? 1 : -1, min: minDeg}; },
      disarmTurn() { anchor = null; },
      get armed() { return !!anchor; },
      // A turn handled by hand ends the current straight, like a detected one.
      markTurn() { seg = null; lastTurnAt = performance.now(); baseI = stepI; settling = true; standTurn = null; },
    };
  }

  window.WalkSensors = {create, DEF};
})();
