// SOLAR — planets, sun, asteroid belt, ships, comets layer
(() => {
  const canvas = document.getElementById('solar-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;
  const dpr = window.devicePixelRatio || 1;

  const state = {
    intensity: 1.0,
    enabled: true,
    t: 0,
  };

  // Distant sun (off-screen top-right)
  const sun = { x: 0.92, y: 0.08, r: 60, hue: 30 };

  // Planets — positioned as background scenery (not orbiting sun for layout reasons,
  // they're discrete worlds at fixed parallax positions)
  const planets = [
    {
      // Big gas giant — top-left, partial view
      cx: 0.08, cy: 0.18, r: 180,
      surface: 'gas',
      colors: ['#3a2a52', '#5d3d7a', '#8b5fbf', '#c896e8'],
      bands: 7,
      ringTilt: 0.18,
      hasRings: true,
      ringInner: 1.35, ringOuter: 1.95,
      glowColor: 'rgba(167,139,250,0.18)',
    },
    {
      // Small icy world — middle-right
      cx: 0.88, cy: 0.55, r: 70,
      surface: 'rocky',
      colors: ['#1e3a5f', '#2c5282', '#5eead4', '#a7f3d0'],
      bands: 0,
      hasRings: false,
      glowColor: 'rgba(94,234,212,0.22)',
      craters: 8,
    },
    {
      // Distant red planet — bottom-left
      cx: 0.12, cy: 0.82, r: 50,
      surface: 'rocky',
      colors: ['#3f1d1d', '#7a2e2e', '#c25450', '#f0abfc'],
      bands: 0,
      hasRings: false,
      glowColor: 'rgba(240,171,252,0.15)',
      craters: 6,
    },
    {
      // Tiny moon — middle
      cx: 0.62, cy: 0.34, r: 18,
      surface: 'moon',
      colors: ['#3a3f4a', '#6b7280', '#9ca3af', '#d1d5db'],
      hasRings: false,
      glowColor: 'rgba(148,163,184,0.18)',
      craters: 4,
    },
  ];

  // Asteroid belt — diagonal sweep
  const asteroids = [];
  function genAsteroids() {
    asteroids.length = 0;
    const count = Math.floor(40 * state.intensity);
    for (let i = 0; i < count; i++) {
      asteroids.push({
        // belt parameter t along a diagonal line
        u: Math.random(),
        v: (Math.random() - 0.5) * 0.18, // perpendicular spread
        size: 1 + Math.random() * 3.5,
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.02,
        speed: 0.0008 + Math.random() * 0.0015,
        shape: Math.floor(Math.random() * 3),
        alpha: 0.4 + Math.random() * 0.5,
      });
    }
  }

  // Ships — slow probes/satellites moving across
  const ships = [];
  function genShips() {
    ships.length = 0;
    ships.push({
      kind: 'probe',
      progress: 0.15,
      speed: 0.00008,
      // path from bottom-left to top-right
      x0: -0.05, y0: 0.95, x1: 1.05, y1: -0.05,
      scale: 1.2,
    });
    ships.push({
      kind: 'satellite',
      progress: 0.6,
      speed: 0.00006,
      x0: 1.05, y0: 0.3, x1: -0.05, y1: 0.7,
      scale: 0.9,
    });
    ships.push({
      kind: 'cruiser',
      progress: 0.4,
      speed: 0.000045,
      x0: -0.05, y0: 0.4, x1: 1.05, y1: 0.6,
      scale: 1.0,
    });
  }

  // Comets — occasional
  const comets = [];
  function spawnComet() {
    comets.push({
      x: Math.random() * 1.2 - 0.1,
      y: -0.05,
      vx: -0.0008 - Math.random() * 0.0006,
      vy: 0.0012 + Math.random() * 0.0008,
      life: 1,
      size: 1.5 + Math.random() * 1.5,
    });
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = w; H = h;
  }

  // === DRAW HELPERS ===
  function drawSun() {
    const x = sun.x * W, y = sun.y * H, r = sun.r;
    // Outer corona
    const grad = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 4);
    grad.addColorStop(0, 'rgba(255,200,120,0.5)');
    grad.addColorStop(0.2, 'rgba(255,170,90,0.2)');
    grad.addColorStop(0.5, 'rgba(251,146,60,0.08)');
    grad.addColorStop(1, 'rgba(251,146,60,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);

    // core
    const core = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    core.addColorStop(0, '#fff5d4');
    core.addColorStop(0.5, '#ffd28a');
    core.addColorStop(1, '#fb923c');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // flickering edge
    ctx.strokeStyle = 'rgba(255,200,120,' + (0.4 + 0.2 * Math.sin(state.t * 0.005)) + ')';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawPlanet(p) {
    const x = p.cx * W, y = p.cy * H, r = p.r;
    ctx.save();

    // Outer glow
    const glow = ctx.createRadialGradient(x, y, r, x, y, r * 1.8);
    glow.addColorStop(0, p.glowColor);
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Rings (back half)
    if (p.hasRings) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.ringTilt);
      ctx.scale(1, 0.22);
      ctx.strokeStyle = 'rgba(200,150,232,0.45)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(0, 0, r * (p.ringInner + p.ringOuter) / 2, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(167,139,250,0.25)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, r * p.ringOuter * 0.95, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Sphere base
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();

    // Base color (mid)
    ctx.fillStyle = p.colors[1];
    ctx.fillRect(x - r, y - r, r * 2, r * 2);

    // Bands for gas giants (wavy)
    if (p.surface === 'gas') {
      for (let i = 0; i < p.bands; i++) {
        const bandY = y - r + (i + 0.5) * (r * 2 / p.bands);
        const colorIdx = i % p.colors.length;
        ctx.fillStyle = p.colors[colorIdx];
        ctx.globalAlpha = 0.65;
        ctx.beginPath();
        const wobble = 4 + (i % 3) * 2;
        for (let xx = x - r; xx <= x + r; xx += 2) {
          const yy = bandY + Math.sin((xx + i * 30) * 0.04) * wobble;
          if (xx === x - r) ctx.moveTo(xx, yy);
          else ctx.lineTo(xx, yy);
        }
        for (let xx = x + r; xx >= x - r; xx -= 2) {
          const yy = bandY + r * 2 / p.bands + Math.sin((xx + i * 30) * 0.04) * wobble;
          ctx.lineTo(xx, yy);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Craters for rocky/moon
    if (p.surface === 'rocky' || p.surface === 'moon') {
      // surface variations
      for (let i = 0; i < 30; i++) {
        const ang = (i * 137.5) * Math.PI / 180;
        const dist = (i / 30) * r * 0.95;
        const px = x + Math.cos(ang) * dist;
        const py = y + Math.sin(ang) * dist;
        const ps = 4 + (i % 5) * 2;
        ctx.fillStyle = p.colors[i % p.colors.length];
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        ctx.arc(px, py, ps, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // craters
      for (let i = 0; i < (p.craters || 0); i++) {
        const ang = (i * 73.3) * Math.PI / 180;
        const dist = ((i * 17) % 100) / 100 * r * 0.7;
        const px = x + Math.cos(ang) * dist;
        const py = y + Math.sin(ang) * dist;
        const cs = 3 + (i % 4) * 2;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.arc(px, py, cs, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = p.colors[3];
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(px - cs * 0.3, py - cs * 0.3, cs * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // Lighting — sun is top-right, so highlight comes from top-right
    const lightDx = x + r * 0.4;
    const lightDy = y - r * 0.4;
    const light = ctx.createRadialGradient(lightDx, lightDy, r * 0.1, lightDx, lightDy, r * 1.5);
    light.addColorStop(0, 'rgba(255,230,180,0.35)');
    light.addColorStop(0.4, 'rgba(255,200,150,0.1)');
    light.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = light;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);

    // Shadow on opposite side
    const shadow = ctx.createRadialGradient(x - r * 0.5, y + r * 0.5, r * 0.2, x - r * 0.5, y + r * 0.5, r * 1.6);
    shadow.addColorStop(0, 'rgba(0,0,0,0.7)');
    shadow.addColorStop(0.6, 'rgba(0,0,0,0.3)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);

    ctx.restore();

    // Rim light
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,220,180,0.25)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // Front rings
    if (p.hasRings) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.ringTilt);
      ctx.scale(1, 0.22);
      ctx.strokeStyle = 'rgba(200,150,232,0.55)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(0, 0, r * (p.ringInner + p.ringOuter) / 2, 0, Math.PI);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(167,139,250,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r * p.ringOuter * 0.95, 0, Math.PI);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawAsteroidBelt() {
    // belt runs diagonal across middle
    // belt center at (0.5, 0.5), direction (1, -0.5) normalized
    const cx = 0.5, cy = 0.55;
    const dx = 1, dy = -0.4;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;

    asteroids.forEach(a => {
      a.u += a.speed;
      if (a.u > 1.2) a.u = -0.2;
      a.rot += a.rotSpeed;

      const tx = (a.u - 0.5) * 1.3 + cx;
      const ty = (a.u - 0.5) * 1.3 * (dy / dx) + cy;
      const x = (tx + a.v * px) * W;
      const y = (ty + a.v * py) * H;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a.rot);
      ctx.fillStyle = `rgba(140,130,120,${a.alpha})`;
      ctx.beginPath();
      const s = a.size;
      // irregular polygon
      if (a.shape === 0) {
        ctx.moveTo(s, 0);
        ctx.lineTo(s * 0.5, s * 0.8);
        ctx.lineTo(-s * 0.7, s * 0.6);
        ctx.lineTo(-s, -s * 0.3);
        ctx.lineTo(-s * 0.2, -s);
        ctx.lineTo(s * 0.7, -s * 0.5);
      } else if (a.shape === 1) {
        ctx.moveTo(s, s * 0.2);
        ctx.lineTo(s * 0.3, s);
        ctx.lineTo(-s * 0.8, s * 0.4);
        ctx.lineTo(-s * 0.6, -s * 0.6);
        ctx.lineTo(s * 0.4, -s * 0.8);
      } else {
        ctx.arc(0, 0, s, 0, Math.PI * 2);
      }
      ctx.closePath();
      ctx.fill();
      // tiny highlight
      ctx.fillStyle = `rgba(220,210,200,${a.alpha * 0.4})`;
      ctx.beginPath();
      ctx.arc(-s * 0.3, -s * 0.3, s * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // === SHIPS ===
  function drawShip(s) {
    s.progress += s.speed;
    if (s.progress > 1.1) s.progress = -0.1;
    const t = s.progress;
    const x = (s.x0 + (s.x1 - s.x0) * t) * W;
    const y = (s.y0 + (s.y1 - s.y0) * t) * H;
    const angle = Math.atan2((s.y1 - s.y0) * H, (s.x1 - s.x0) * W);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(s.scale, s.scale);

    if (s.kind === 'probe') drawProbe();
    else if (s.kind === 'satellite') drawSatellite();
    else if (s.kind === 'cruiser') drawCruiser();

    ctx.restore();
  }

  function drawProbe() {
    // small triangular probe with engine trail
    // Trail
    const trailGrad = ctx.createLinearGradient(-40, 0, 0, 0);
    trailGrad.addColorStop(0, 'rgba(94,234,212,0)');
    trailGrad.addColorStop(1, 'rgba(94,234,212,0.7)');
    ctx.fillStyle = trailGrad;
    ctx.beginPath();
    ctx.moveTo(-40, -2);
    ctx.lineTo(-4, -1);
    ctx.lineTo(-4, 1);
    ctx.lineTo(-40, 2);
    ctx.closePath();
    ctx.fill();

    // Body
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-4, -3);
    ctx.lineTo(-4, 3);
    ctx.closePath();
    ctx.fill();
    // accent
    ctx.fillStyle = '#5eead4';
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(2, -1);
    ctx.lineTo(2, 1);
    ctx.closePath();
    ctx.fill();
    // engine glow
    ctx.fillStyle = 'rgba(94,234,212,0.9)';
    ctx.beginPath();
    ctx.arc(-4, 0, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSatellite() {
    // Box body with solar panels
    ctx.save();
    ctx.rotate(-Math.atan2(1, 1)); // counter-rotate so panels stay relative
    // Body
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(-4, -3, 8, 6);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(-4, -3, 8, 6);
    // dish
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.arc(0, -3, 2, Math.PI, Math.PI * 2);
    ctx.fill();
    // Solar panels
    ctx.fillStyle = '#1e3a8a';
    ctx.fillRect(-14, -1.5, 9, 3);
    ctx.fillRect(5, -1.5, 9, 3);
    // panel grid lines
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 0.3;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(-14 + i * 2.25, -1.5);
      ctx.lineTo(-14 + i * 2.25, 1.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(5 + i * 2.25, -1.5);
      ctx.lineTo(5 + i * 2.25, 1.5);
      ctx.stroke();
    }
    // antenna tip
    ctx.fillStyle = '#f0abfc';
    ctx.beginPath();
    ctx.arc(0, -5, 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawCruiser() {
    // Larger ship — elongated with multiple engines
    // Trail
    const trailGrad = ctx.createLinearGradient(-60, 0, -8, 0);
    trailGrad.addColorStop(0, 'rgba(167,139,250,0)');
    trailGrad.addColorStop(1, 'rgba(167,139,250,0.5)');
    ctx.fillStyle = trailGrad;
    ctx.beginPath();
    ctx.moveTo(-60, -4);
    ctx.lineTo(-8, -2);
    ctx.lineTo(-8, 2);
    ctx.lineTo(-60, 4);
    ctx.closePath();
    ctx.fill();

    // Hull
    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(14, -3);
    ctx.lineTo(-8, -5);
    ctx.lineTo(-8, 5);
    ctx.lineTo(14, 3);
    ctx.closePath();
    ctx.fill();
    // upper deck
    ctx.fillStyle = '#64748b';
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(12, -2);
    ctx.lineTo(-6, -3);
    ctx.lineTo(-6, 3);
    ctx.lineTo(12, 2);
    ctx.closePath();
    ctx.fill();
    // bridge windows
    ctx.fillStyle = '#5eead4';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(2 + i * 3, -0.5, 1.5, 1);
    }
    // Engines
    ctx.fillStyle = 'rgba(167,139,250,0.95)';
    ctx.beginPath();
    ctx.arc(-8, -3, 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-8, 0, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-8, 3, 1.2, 0, Math.PI * 2);
    ctx.fill();
    // hull line
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(-8, 0);
    ctx.stroke();
  }

  function drawComets() {
    for (let i = comets.length - 1; i >= 0; i--) {
      const c = comets[i];
      c.x += c.vx;
      c.y += c.vy;
      c.life -= 0.005;
      if (c.life <= 0 || c.x < -0.2 || c.y > 1.2) {
        comets.splice(i, 1); continue;
      }
      const x = c.x * W, y = c.y * H;
      // tail
      const tailLen = 80;
      const tx = x - c.vx * W * 60;
      const ty = y - c.vy * H * 60;
      const grad = ctx.createLinearGradient(tx, ty, x, y);
      grad.addColorStop(0, 'rgba(167,139,250,0)');
      grad.addColorStop(1, 'rgba(255,255,255,' + (0.7 * c.life) + ')');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();
      // head
      ctx.fillStyle = `rgba(255,255,255,${c.life})`;
      ctx.beginPath();
      ctx.arc(x, y, c.size, 0, Math.PI * 2);
      ctx.fill();
      // glow
      ctx.fillStyle = `rgba(167,139,250,${0.4 * c.life})`;
      ctx.beginPath();
      ctx.arc(x, y, c.size * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (Math.random() < 0.002) spawnComet();
  }

  function loop() {
    if (!state.enabled) {
      ctx.clearRect(0, 0, W, H);
      requestAnimationFrame(loop);
      return;
    }
    state.t++;
    ctx.clearRect(0, 0, W, H);
    drawSun();
    planets.forEach(drawPlanet);
    drawAsteroidBelt();
    ships.forEach(drawShip);
    drawComets();
    requestAnimationFrame(loop);
  }

  function init() {
    resize();
    genAsteroids();
    genShips();
    loop();
    window.addEventListener('resize', resize);
  }

  window.__solar = {
    setIntensity(v) { state.intensity = Math.max(0, Math.min(2, v)); genAsteroids(); },
    setEnabled(b) { state.enabled = b; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
