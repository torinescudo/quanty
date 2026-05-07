// Three-layer parallax starfield
(() => {
  const layers = [
    { id: 'starfield-far',  count: 240, speed: 0.012, sizeMin: 0.3, sizeMax: 0.8, alpha: 0.5,  hue: 220 },
    { id: 'starfield-mid',  count: 110, speed: 0.035, sizeMin: 0.5, sizeMax: 1.3, alpha: 0.7,  hue: 200 },
    { id: 'starfield-near', count: 40,  speed: 0.08,  sizeMin: 0.7, sizeMax: 1.8, alpha: 0.92, hue: 180 },
  ];

  const state = {
    intensity: 1.0,   // multiplier on count + alpha
    enabled: true,
    layers: [],
  };

  function rand(min, max) { return Math.random() * (max - min) + min; }

  function init() {
    state.layers = layers.map(cfg => {
      const canvas = document.getElementById(cfg.id);
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      return { cfg, canvas, ctx, stars: [], width: 0, height: 0 };
    }).filter(Boolean);
    resize();
    state.layers.forEach(layer => regen(layer));
    loop();
    window.addEventListener('resize', () => { resize(); state.layers.forEach(l => regen(l)); });
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    state.layers.forEach(layer => {
      layer.canvas.width = w * dpr;
      layer.canvas.height = h * dpr;
      layer.canvas.style.width = w + 'px';
      layer.canvas.style.height = h + 'px';
      layer.ctx.scale(dpr, dpr);
      layer.width = w;
      layer.height = h;
    });
  }

  function regen(layer) {
    const count = Math.floor(layer.cfg.count * state.intensity);
    layer.stars = [];
    for (let i = 0; i < count; i++) {
      layer.stars.push({
        x: rand(0, layer.width),
        y: rand(0, layer.height),
        size: rand(layer.cfg.sizeMin, layer.cfg.sizeMax),
        twinkle: rand(0, Math.PI * 2),
        speed: layer.cfg.speed * rand(0.7, 1.3),
        baseAlpha: layer.cfg.alpha * rand(0.5, 1),
      });
    }
  }

  function loop(t = 0) {
    if (!state.enabled) { requestAnimationFrame(loop); return; }
    state.layers.forEach(layer => {
      const ctx = layer.ctx;
      ctx.clearRect(0, 0, layer.width, layer.height);
      const stars = layer.stars;
      const intensityAlpha = state.intensity;
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        // slow drift
        s.x -= s.speed;
        if (s.x < -2) s.x = layer.width + 2;
        // twinkle
        const tw = 0.6 + 0.4 * Math.sin(t * 0.001 + s.twinkle);
        const a = s.baseAlpha * tw * intensityAlpha;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${layer.cfg.hue}, 30%, 88%, ${a})`;
        ctx.fill();
        // glow for near layer
        if (layer.cfg.id === 'starfield-near' && s.size > 1.4) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.size * 2.5, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${layer.cfg.hue}, 60%, 80%, ${a * 0.15})`;
          ctx.fill();
        }
      }
    });
    requestAnimationFrame(loop);
  }

  // Public API for tweaks
  window.__starfield = {
    setIntensity(v) {
      state.intensity = Math.max(0, Math.min(2, v));
      state.layers.forEach(l => regen(l));
    },
    setEnabled(b) { state.enabled = b; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
