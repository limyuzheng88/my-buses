// Stand-in for Leaflet with the parts the app uses. Like real Leaflet, a tap on a marker also reaches the map
// unless the marker was made with bubblingMouseEvents: false.
(() => {
  const evts = () => { const h = {}; return { on(e, f) { (h[e] = h[e] || []).push(f); return this; }, _fire(e, a) { (h[e] || []).forEach((f) => f(a)); } }; };
  window.__markers = [];
  window.L = {
    canvas(o) { window.__canvas = o; return { canvas: true, o }; },
    map(id, opts) { const m = Object.assign(evts(), { c: [0, 0], z: 0, opts,
      fire(e, a) { this._fire(e, a); },
      setView(c, z) { this.c = c; this.z = z; this.fire('moveend'); return this; }, getZoom() { return this.z; },
      getCenter() { return { lat: this.c[0], lng: this.c[1] }; },
      getBounds() { const d = 0.004 * Math.pow(2, 17 - this.z); const [la, ln] = this.c; return { getSouth: () => la - d, getNorth: () => la + d, getWest: () => ln - d, getEast: () => ln + d }; },
      invalidateSize() { window.__sizes = (window.__sizes || 0) + 1; }, panTo(c) { window.__pans = (window.__pans || []).concat([c.map((v) => +(+v).toFixed(5)) ]); this.c = c; this.fire('moveend'); return this; } }); window.__map = m; return m; },
    tileLayer(url) { window.__tiles = url; return { addTo() { return this; } }; },
    layerGroup() { const items = []; return { items, addTo() { return this; }, clearLayers() { items.length = 0; if (this === window.__stopsLayer) window.__markers.length = 0; } }; },
    circleMarker(ll, o) { const mk = Object.assign(evts(), { ll, o,
      fire(e, a) { this._fire(e, a); if (e === 'click' && o.bubblingMouseEvents !== false) window.__map.fire('click', a); },
      addTo(g) { g.items.push(this); if (!window.__stopsLayer && (o.radius === 8 || o.radius === 11)) window.__stopsLayer = g; if (g === window.__stopsLayer) window.__markers.push(this); return this; } }); return mk; },
  };
})();
