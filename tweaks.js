/* Tweaks panel — color/density/font live preview.
   Hosts the floating button + flyout panel; reapplies CSS vars at the :root level. */
(function () {
  'use strict';

  const PALETTES = {
    Navy: { '--navy': '#1f3864', '--navy-deep': '#15264a', '--navy-soft': '#4a6296', '--navy-tint': '#e7ecf6', '--navy-tint-2': '#d9e1f2', '--amber': '#c97a3b', '--amber-soft': '#e0a677', '--amber-tint': '#fbeede', '--amber-tint-2': '#f6dcc1' },
    Forest: { '--navy': '#234d39', '--navy-deep': '#163326', '--navy-soft': '#5e8772', '--navy-tint': '#e3efe8', '--navy-tint-2': '#cfe1d6', '--amber': '#c97a3b', '--amber-soft': '#e0a677', '--amber-tint': '#fbeede', '--amber-tint-2': '#f6dcc1' },
    Plum:   { '--navy': '#4a2e54', '--navy-deep': '#321f3a', '--navy-soft': '#7d5e89', '--navy-tint': '#efe7f2', '--navy-tint-2': '#dec8e3', '--amber': '#cf7a4e', '--amber-soft': '#e2a684', '--amber-tint': '#faead9', '--amber-tint-2': '#f4d4ba' },
    Mono:   { '--navy': '#1a1f2e', '--navy-deep': '#0c0f17', '--navy-soft': '#5b6175', '--navy-tint': '#e9ebef', '--navy-tint-2': '#d3d6df', '--amber': '#7a7a7a', '--amber-soft': '#a3a3a3', '--amber-tint': '#ececec', '--amber-tint-2': '#dcdcdc' },
  };

  const FONTS = {
    'Inter + Instrument': { '--font-sans': "'Inter', system-ui, sans-serif", '--font-display': "'Instrument Serif', Georgia, serif" },
    'Geist + Instrument': { '--font-sans': "'Geist', system-ui, sans-serif", '--font-display': "'Instrument Serif', Georgia, serif" },
    'IBM Plex':           { '--font-sans': "'IBM Plex Sans', system-ui, sans-serif", '--font-display': "'IBM Plex Sans', Georgia, serif" },
    'System':             { '--font-sans': "system-ui, -apple-system, 'Segoe UI', sans-serif", '--font-display': "Georgia, serif" },
  };

  const DENSITIES = {
    Cozy:    { '--pad-card': '26px', '--gap-card': '20px', '--r-md': '14px', '--r-lg': '18px', '--r-xl': '24px' },
    Compact: { '--pad-card': '18px', '--gap-card': '14px', '--r-md': '10px', '--r-lg': '14px', '--r-xl': '18px' },
    Roomy:   { '--pad-card': '34px', '--gap-card': '26px', '--r-md': '16px', '--r-lg': '22px', '--r-xl': '28px' },
  };

  const STORE = 'stitcher.tweaks.v1';
  let state = { palette: 'Navy', font: 'Inter + Instrument', density: 'Cozy' };
  try { Object.assign(state, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) {}

  function applyVars(map) {
    const root = document.documentElement;
    for (const k in map) root.style.setProperty(k, map[k]);
  }
  function apply() {
    applyVars(PALETTES[state.palette] || PALETTES.Navy);
    applyVars(FONTS[state.font] || FONTS['Inter + Instrument']);
    applyVars(DENSITIES[state.density] || DENSITIES.Cozy);
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
  }

  apply();

  function buildOptions(group, current, choices, onPick) {
    return choices.map(name => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      if (name === current) b.classList.add('active');
      b.addEventListener('click', () => { onPick(name); render(); });
      return b;
    });
  }

  function buildSwatches(current, onPick) {
    return Object.keys(PALETTES).map(name => {
      const p = PALETTES[name];
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'tweaks-swatch';
      if (name === current) sw.classList.add('active');
      sw.title = name;
      sw.style.setProperty('--swatch', `linear-gradient(135deg, ${p['--navy']} 0 50%, ${p['--amber']} 50% 100%)`);
      sw.addEventListener('click', () => { onPick(name); render(); });
      return sw;
    });
  }

  let fab, panel;
  function render() {
    apply();
    if (panel) {
      const open = !panel.hidden;
      panel.remove();
      panel = null;
      if (open) showPanel();
    }
  }

  function showPanel() {
    panel = document.createElement('div');
    panel.className = 'tweaks-panel';

    const head = document.createElement('h4');
    head.innerHTML = '<span>Tweaks</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => { panel.remove(); panel = null; fab.style.display = 'inline-flex'; });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    // Color palette
    const colorRow = document.createElement('div');
    colorRow.className = 'tweaks-row';
    colorRow.innerHTML = '<div class="label">Color palette</div>';
    const sw = document.createElement('div');
    sw.className = 'tweaks-swatches';
    buildSwatches(state.palette, (name) => state.palette = name).forEach(b => sw.appendChild(b));
    colorRow.appendChild(sw);
    panel.appendChild(colorRow);

    // Font
    const fontRow = document.createElement('div');
    fontRow.className = 'tweaks-row';
    fontRow.innerHTML = '<div class="label">Font pairing</div>';
    const fontOpts = document.createElement('div');
    fontOpts.className = 'tweaks-options';
    buildOptions('font', state.font, Object.keys(FONTS), (name) => state.font = name).forEach(b => fontOpts.appendChild(b));
    fontRow.appendChild(fontOpts);
    panel.appendChild(fontRow);

    // Density
    const densRow = document.createElement('div');
    densRow.className = 'tweaks-row';
    densRow.innerHTML = '<div class="label">Density</div>';
    const densOpts = document.createElement('div');
    densOpts.className = 'tweaks-options';
    buildOptions('density', state.density, Object.keys(DENSITIES), (name) => state.density = name).forEach(b => densOpts.appendChild(b));
    densRow.appendChild(densOpts);
    panel.appendChild(densRow);

    document.body.appendChild(panel);
    fab.style.display = 'none';
  }

  function init() {
    fab = document.createElement('button');
    fab.className = 'tweaks-fab';
    fab.type = 'button';
    fab.innerHTML = '<span class="dot"></span> Tweaks';
    fab.addEventListener('click', showPanel);
    document.body.appendChild(fab);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
