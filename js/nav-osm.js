/**
 * 导航规划全屏底图：Leaflet + OpenStreetMap（Carto 浅色瓦片）+ 仿真路线/充电站。
 * 由 cockpit-app 在打开导航叠加层时调用。
 */
(function () {
  "use strict";

  var map = null;
  var layers = { route: null, chargers: [], car: null };
  var lastSig = "";

  function $(id) {
    return document.getElementById(id);
  }

  function simpleHash(s) {
    var h = 0;
    var i;
    var str = s || "";
    for (i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  function destToCenter(dest) {
    var h = simpleHash(dest || "公司");
    return [22.42 + (h % 1800) / 10000, 113.92 + (h % 2200) / 10000];
  }

  function buildRouteLatLng(dest, totalKm) {
    var c = destToCenter(dest);
    var pts = [];
    var n = 52;
    var scale = Math.max(0.06, Math.min(0.42, (totalKm || 100) / 240));
    var i;
    for (i = 0; i <= n; i++) {
      var u = i / n;
      var ang = u * Math.PI * 1.1;
      pts.push([
        c[0] + scale * Math.sin(ang * 1.25) * u * 1.05,
        c[1] + scale * Math.cos(ang * 0.95) * u * 1.12,
      ]);
    }
    return pts;
  }

  function chargerIcon() {
    return L.divIcon({
      className: "nav-lf-charger-icon",
      html: '<div class="nav-lf-charger-disc" aria-hidden="true">⚡</div>',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    });
  }

  function clearRouteLayers() {
    if (!map) return;
    if (layers.route) {
      map.removeLayer(layers.route);
      layers.route = null;
    }
    layers.chargers.forEach(function (m) {
      map.removeLayer(m);
    });
    layers.chargers = [];
    if (layers.car) {
      map.removeLayer(layers.car);
      layers.car = null;
    }
  }

  function initMapOnce() {
    if (map || typeof L === "undefined") return;
    var el = $("navMapLeaflet");
    if (!el) return;
    map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
    });
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
          '&copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20,
      }
    ).addTo(map);
    map.setView([22.54, 114.05], 11);
  }

  function sync(state) {
    if (typeof L === "undefined" || !state || !state.panels || !state.panels.nav)
      return;
    initMapOnce();
    if (!map) return;

    var sig =
      (state.dest || "") +
      "|" +
      (state.totalKm != null ? String(state.totalKm) : "") +
      "|" +
      (state.waypoints || []).join(",");
    if (sig === lastSig && layers.route) {
      queueInvalidate();
      return;
    }
    lastSig = sig;

    var pts = buildRouteLatLng(state.dest, state.totalKm);
    clearRouteLayers();

    layers.route = L.polyline(pts, {
      color: "#16a34a",
      weight: 10,
      opacity: 0.92,
      lineCap: "round",
      lineJoin: "round",
      dashArray: "18 14",
    }).addTo(map);

    var idxA = Math.floor(pts.length * 0.33);
    var idxB = Math.floor(pts.length * 0.68);
    var pairs = [
      [idxA, "充电约 14 分"],
      [idxB, "距车 73 km"],
    ];
    var pair;
    for (pair = 0; pair < pairs.length; pair++) {
      var pr = pairs[pair];
      var mk = L.marker(pts[pr[0]], { icon: chargerIcon() })
        .addTo(map)
        .bindTooltip(pr[1], {
          permanent: true,
          direction: "top",
          offset: [0, -20],
          className: "nav-leaf-tooltip",
        });
      layers.chargers.push(mk);
    }

    layers.car = L.circleMarker(pts[0], {
      radius: 11,
      color: "#16a34a",
      weight: 3,
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).addTo(map);

    try {
      map.fitBounds(layers.route.getBounds(), { padding: [72, 72], maxZoom: 13 });
    } catch (e) {}

    queueInvalidate();
  }

  var invQueued = false;
  function queueInvalidate() {
    if (invQueued || !map) return;
    invQueued = true;
    setTimeout(function () {
      invQueued = false;
      if (map) map.invalidateSize(true);
    }, 120);
  }

  function fitRoute() {
    if (map && layers.route) {
      try {
        map.fitBounds(layers.route.getBounds(), { padding: [64, 64], maxZoom: 13 });
      } catch (e) {}
    }
  }

  window.CockpitNavMap = {
    sync: sync,
    invalidate: queueInvalidate,
    fitRoute: fitRoute,
    resetSig: function () {
      lastSig = "";
    },
    hasMap: function () {
      return !!map;
    },
  };
})();
