// Tweaks for VOID dashboard
const VOID_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#5eead4",
  "density": "normal",
  "starfield": 1.0,
  "nebula": true,
  "solar": true
}/*EDITMODE-END*/;

const ACCENT_OPTIONS = ["#5eead4", "#a78bfa", "#22d3ee", "#f0abfc", "#fbbf24"];

function applyTweaks(t) {
  document.body.dataset.density = t.density;
  document.documentElement.style.setProperty("--accent", t.accent);
  document.documentElement.style.setProperty("--accent-soft", t.accent + "66");
  const neb = document.querySelector(".nebula");
  if (neb) neb.style.opacity = t.nebula ? "1" : "0";
  if (window.__starfield) window.__starfield.setIntensity(t.starfield);
  if (window.__solar) window.__solar.setEnabled(t.solar);
}

function VoidTweaks() {
  const [t, setTweak] = window.useTweaks(VOID_DEFAULTS);
  React.useEffect(() => { applyTweaks(t); }, [t]);

  return (
    <window.TweaksPanel title="VOID · TWEAKS">
      <window.TweakSection label="Accent" />
      <window.TweakColor
        label="Primary"
        value={t.accent}
        options={ACCENT_OPTIONS}
        onChange={v => setTweak("accent", v)}
      />
      <window.TweakSection label="Layout" />
      <window.TweakRadio
        label="Density"
        value={t.density}
        options={["compact", "normal", "spacious"]}
        onChange={v => setTweak("density", v)}
      />
      <window.TweakSection label="Cosmos" />
      <window.TweakSlider
        label="Starfield"
        value={t.starfield}
        min={0} max={2} step={0.1}
        onChange={v => setTweak("starfield", v)}
      />
      <window.TweakToggle
        label="Nebula glow"
        value={t.nebula}
        onChange={v => setTweak("nebula", v)}
      />
      <window.TweakToggle
        label="Solar system"
        value={t.solar}
        onChange={v => setTweak("solar", v)}
      />
    </window.TweaksPanel>
  );
}

function boot() {
  if (!window.TweaksPanel || !window.useTweaks) {
    setTimeout(boot, 50); return;
  }
  applyTweaks(VOID_DEFAULTS);
  const root = document.getElementById("tweaks-root");
  ReactDOM.createRoot(root).render(<VoidTweaks />);
}
boot();
