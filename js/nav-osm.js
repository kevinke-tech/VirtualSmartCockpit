/**
 * 简化版虚拟导航：不依赖在线瓦片，提供可辨识的离线底图 + 轨迹 + 车头 + 目的地标签。
 */
(function () {
  "use strict";

  var map = null;
  var layers = { basemap: null, route: null, car: null, dest: null };
  var lastSig = "";
  var basemapSig = "";
  var NAV_ZOOM_DEFAULT = 13;
  var NAV_ZOOM_FIT_MIN = 12;
  var NAV_ZOOM_FIT_MAX = 16;

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
    return [22.45 + (h % 900) / 10000, 113.95 + (h % 700) / 10000];
  }

  function buildRouteLatLng(dest, totalKm) {
    var end = destToCenter(dest);
    var span = Math.max(0.024, Math.min(0.055, (totalKm || 100) / 3200));
    var start = [end[0] - span * 0.95, end[1] - span * 0.75];
    var pts = [];
    var n = 40;
    var i;
    for (i = 0; i <= n; i++) {
      var t = i / n;
      var bend = Math.sin(t * Math.PI * 1.7) * span * 0.12;
      pts.push([
        start[0] + (end[0] - start[0]) * t + bend * 0.55,
        start[1] + (end[1] - start[1]) * t - bend * 0.35,
      ]);
    }
    return pts;
  }

  function carIcon() {
    return L.divIcon({
      className: "nav-lf-car-icon",
      html: '<div class="nav-lf-car-disc" aria-hidden="true">🚗</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  function ensureBasemap(dest, totalKm) {
    if (!map) return;
    var sig = (dest || "公司") + "|" + String(Math.round((totalKm || 100) / 10));
    if (sig === basemapSig && layers.basemap) return;
    basemapSig = sig;
    if (layers.basemap) {
      map.removeLayer(layers.basemap);
      layers.basemap = null;
    }

    var center = destToCenter(dest || "公司");
    var span = Math.max(0.03, Math.min(0.07, (totalKm || 100) / 2200));
    var lat = center[0];
    var lng = center[1];
    var g = L.layerGroup();
    var i;

    // Soft water area to make map look less blank.
    L.polygon(
      [
        [lat - span * 1.15, lng + span * 0.15],
        [lat - span * 1.05, lng + span * 1.25],
        [lat + span * 0.3, lng + span * 1.2],
        [lat + span * 0.2, lng + span * 0.05],
      ],
      {
        stroke: false,
        fill: true,
        fillColor: "#dbeafe",
        fillOpacity: 0.9,
        interactive: false,
      }
    ).addTo(g);

    // Park block.
    L.polygon(
      [
        [lat - span * 0.8, lng - span * 1.05],
        [lat - span * 0.35, lng - span * 0.95],
        [lat - span * 0.42, lng - span * 0.35],
        [lat - span * 0.86, lng - span * 0.45],
      ],
      {
        stroke: false,
        fill: true,
        fillColor: "#dcfce7",
        fillOpacity: 0.78,
        interactive: false,
      }
    ).addTo(g);

    // Secondary road mesh.
    for (i = -4; i <= 4; i++) {
      L.polyline(
        [
          [lat - span * 1.25, lng + i * span * 0.26],
          [lat + span * 1.15, lng + i * span * 0.2],
        ],
        {
          color: "#cbd5e1",
          weight: 2,
          opacity: 0.8,
          interactive: false,
        }
      ).addTo(g);
      L.polyline(
        [
          [lat + i * span * 0.24, lng - span * 1.2],
          [lat + i * span * 0.2, lng + span * 1.2],
        ],
        {
          color: "#d1d5db",
          weight: 1.6,
          opacity: 0.7,
          interactive: false,
        }
      ).addTo(g);
    }

    // Two arterial roads.
    L.polyline(
      [
        [lat - span * 1.2, lng - span * 0.9],
        [lat - span * 0.35, lng - span * 0.3],
        [lat + span * 0.2, lng + span * 0.25],
        [lat + span * 1.12, lng + span * 0.72],
      ],
      {
        color: "#94a3b8",
        weight: 5,
        opacity: 0.85,
        lineCap: "round",
        interactive: false,
      }
    ).addTo(g);
    L.polyline(
      [
        [lat - span * 0.95, lng + span * 0.95],
        [lat - span * 0.2, lng + span * 0.52],
        [lat + span * 0.55, lng + span * 0.1],
        [lat + span * 1.05, lng - span * 0.35],
      ],
      {
        color: "#a3b1c0",
        weight: 4,
        opacity: 0.82,
        lineCap: "round",
        interactive: false,
      }
    ).addTo(g);

    // A few map labels to increase recognizability.
    L.circleMarker([lat - span * 0.48, lng - span * 0.78], {
      radius: 4,
      color: "#059669",
      weight: 2,
      fillColor: "#34d399",
      fillOpacity: 1,
      interactive: false,
    })
      .addTo(g)
      .bindTooltip("城市公园", {
        permanent: true,
        direction: "top",
        offset: [0, -6],
        className: "nav-leaf-tooltip",
      });

    L.circleMarker([lat + span * 0.26, lng + span * 0.88], {
      radius: 4,
      color: "#2563eb",
      weight: 2,
      fillColor: "#60a5fa",
      fillOpacity: 1,
      interactive: false,
    })
      .addTo(g)
      .bindTooltip("滨水区", {
        permanent: true,
        direction: "right",
        offset: [10, 0],
        className: "nav-leaf-tooltip",
      });

    L.circleMarker([lat + span * 0.62, lng - span * 0.2], {
      radius: 4,
      color: "#7c3aed",
      weight: 2,
      fillColor: "#a78bfa",
      fillOpacity: 1,
      interactive: false,
    })
      .addTo(g)
      .bindTooltip("商务区", {
        permanent: true,
        direction: "bottom",
        offset: [0, 6],
        className: "nav-leaf-tooltip",
      });

    g.addTo(map);
    layers.basemap = g;
  }

  function clearRouteLayers() {
    if (!map) return;
    if (layers.route) {
      map.removeLayer(layers.route);
      layers.route = null;
    }
    if (layers.car) {
      map.removeLayer(layers.car);
      layers.car = null;
    }
    if (layers.dest) {
      map.removeLayer(layers.dest);
      layers.dest = null;
    }
  }

  function initMapOnce() {
    if (map || typeof L === "undefined") return;
    var el = $("navMapLeaflet");
    if (!el) return;
    map = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      worldCopyJump: false,
      preferCanvas: true,
    });
    map.setView([22.54, 114.05], NAV_ZOOM_DEFAULT);
  }

  function fitPadding() {
    var stack = document.querySelector(".nav-ui-stack");
    var leftW = stack ? stack.clientWidth : 0;
    var leftPad = Math.min(620, Math.max(280, leftW + 34));
    return {
      paddingTopLeft: [leftPad, 70],
      paddingBottomRight: [36, 76],
      maxZoom: NAV_ZOOM_FIT_MAX,
    };
  }

  function sync(state) {
    if (typeof L === "undefined" || !state || !state.panels || !state.panels.nav) return;
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
    ensureBasemap(state.dest, state.totalKm);

    var pts = buildRouteLatLng(state.dest, state.totalKm);
    var startPt = pts[0];
    var endPt = pts[pts.length - 1];
    clearRouteLayers();

    layers.route = L.polyline(pts, {
      color: "#16a34a",
      weight: 8,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
      dashArray: "12 8",
    }).addTo(map);

    layers.car = L.marker(startPt, { icon: carIcon() }).addTo(map);

    layers.dest = L.circleMarker(endPt, {
      radius: 8,
      color: "#0f172a",
      weight: 2,
      fillColor: "#f59e0b",
      fillOpacity: 1,
    })
      .addTo(map)
      .bindTooltip("阿杰所在，目的地 " + (state.dest || "公司"), {
        permanent: true,
        direction: "top",
        offset: [0, -12],
        className: "nav-leaf-tooltip",
      });

    try {
      var b = layers.route.getBounds();
      map.fitBounds(b, fitPadding());
      if (map.getZoom() < NAV_ZOOM_FIT_MIN) map.setView(b.getCenter(), NAV_ZOOM_FIT_MIN);
    } catch (_e) {}

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
        var b = layers.route.getBounds();
        map.fitBounds(b, fitPadding());
      } catch (_e) {}
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
