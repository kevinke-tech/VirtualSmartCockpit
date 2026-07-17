/**
 * Third-person highway (THREE.js) — 参考车载 SR / 赛车视角。
 * 优先保证行车页稳定渲染；车辆使用程序化模型（避免外部模块加载失败导致整屏空白）。
 */

var renderer;
var scene;
var camera;
var clock = new THREE.Clock();
var lastVoiceRenderAt = 0;

var laneWidth = 4.1;
var numLanes = 3;
var roadHalf = (numLanes * laneWidth) / 2;

var egoMesh;
var trafficMeshes = [];
var guideMesh;
/** `/models/` 静态资源：ToyCar 展示 sheen/transmission/clearcoat，体积小、许可清晰（CC0） */
var CAR_GLTF_URL = "models/ToyCar.glb";
/** 当前版本固定走程序化车体；预留后续模型化恢复。 */
var carPreparedProto = null;
/** 与车速同步的「世界流动」系数（米/帧量级，与 traffic 一致） */
var FLOW_K = 0.168;
var roadSegmentMeshes = [];
var laneDashMeshes = [];
var shoulderMeshes = [];
var sceneryGroups = [];

function pseudoRand(seed) {
  var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

  function getState() {
    return window.Cockpit && window.Cockpit.state ? window.Cockpit.state : null;
  }

  function laneIndexToX(li) {
    var i = typeof li === "number" ? li : 1;
    i = Math.max(0, Math.min(2, Math.round(i)));
    return (i - 1) * laneWidth;
  }

  /**
   * 低多边形轿车：针对后车追尾视角做「车体 / 深色玻璃舱 / 外撇轮胎」三道轮廓，避免远看像两块方盒。
   */
  function buildCar(bodyHex, roofHex) {
    bodyHex = bodyHex !== undefined ? bodyHex : 0xf8fafc;
    roofHex = roofHex !== undefined ? roofHex : 0xa8cce8;
    var bodyCol = new THREE.Color(bodyHex);
    var accentCol = new THREE.Color(roofHex);

    function paintMat(lighten) {
      var c = bodyCol.clone();
      if (lighten) c.multiplyScalar(1.07);
      return new THREE.MeshStandardMaterial({
        color: c.getHex(),
        metalness: 0.68,
        roughness: 0.26,
      });
    }

    /** 压住车身色相、保持高对比深色「玻璃盒子」剪影 */
    var tintCol = accentCol.clone().multiplyScalar(0.22).lerp(bodyCol, 0.09);
    var glassMat = new THREE.MeshStandardMaterial({
      color: tintCol.getHex(),
      metalness: 0.55,
      roughness: 0.06,
      transparent: true,
      opacity: 0.9,
      emissive: accentCol.clone().multiplyScalar(0.08),
      emissiveIntensity: 0.26,
    });

    var blackMat = new THREE.MeshStandardMaterial({
      color: 0x0b1220,
      metalness: 0.38,
      roughness: 0.72,
    });
    var rubberMat = new THREE.MeshStandardMaterial({
      color: 0x070707,
      metalness: 0.06,
      roughness: 0.95,
    });
    var rimMat = new THREE.MeshStandardMaterial({
      color: 0xdfe8f6,
      metalness: 0.82,
      roughness: 0.24,
    });
    var headMat = new THREE.MeshStandardMaterial({
      color: 0xfffcf0,
      emissive: 0xfff2d6,
      emissiveIntensity: 1.05,
      metalness: 0.1,
      roughness: 0.38,
    });
    var tailMat = new THREE.MeshStandardMaterial({
      color: 0x8b1e22,
      emissive: 0x58191c,
      emissiveIntensity: 0.55,
      metalness: 0.06,
      roughness: 0.4,
    });

    /** 轮子外移一点，后车视角能看到后轮圆面 */
    function wheel(x, z) {
      var wg = new THREE.Group();
      var tr = 0.352;
      var tireGeo = new THREE.CylinderGeometry(tr, tr, 0.27, 20);
      tireGeo.rotateZ(Math.PI / 2);
      var tire = new THREE.Mesh(tireGeo, rubberMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      var rimGeo = new THREE.CylinderGeometry(0.202, 0.202, 0.296, 16);
      rimGeo.rotateZ(Math.PI / 2);
      wg.add(tire);
      wg.add(new THREE.Mesh(rimGeo, rimMat));
      wg.position.set(x, tr, z);
      return wg;
    }

    var grp = new THREE.Group();

    var skid = new THREE.Mesh(new THREE.BoxGeometry(2.14, 0.34, 5.05), blackMat);
    skid.position.y = 0.17;
    skid.castShadow = true;
    grp.add(skid);

    var hull = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.52, 4.62), paintMat(false));
    hull.position.y = 0.64;
    hull.castShadow = true;
    hull.receiveShadow = true;
    grp.add(hull);

    var hood = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.41, 2.12), paintMat(true));
    hood.position.set(0, 0.93, 1.52);
    hood.rotation.x = -0.13;
    hood.castShadow = true;
    grp.add(hood);

    var cabin = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.76, 2.58), glassMat.clone());
    cabin.position.set(0, 1.34, -0.48);
    cabin.rotation.x = -0.2;
    cabin.castShadow = true;
    grp.add(cabin);

    var roofShelf = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.11, 1.62), paintMat(true));
    roofShelf.position.set(0, 1.66, -0.56);
    roofShelf.rotation.x = -0.12;
    roofShelf.castShadow = true;
    grp.add(roofShelf);

    var spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.26), paintMat(false));
    spoiler.position.set(0, 1.62, -1.62);
    spoiler.rotation.x = 0.1;
    grp.add(spoiler);

    grp.add(wheel(-0.95, 1.74));
    grp.add(wheel(0.95, 1.74));
    grp.add(wheel(-0.95, -1.78));
    grp.add(wheel(0.95, -1.78));

    var mirrorL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.085, 0.14), paintMat(false));
    mirrorL.position.set(-1.08, 1.06, -0.32);
    var mirrorR = mirrorL.clone();
    mirrorR.position.x = 1.08;
    grp.add(mirrorL);
    grp.add(mirrorR);

    var grille = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.36, 0.17), blackMat);
    grille.position.set(0, 0.7, 2.42);
    grp.add(grille);

    var headL = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.15, 0.072), headMat.clone());
    headL.position.set(-0.56, 0.72, 2.54);
    var headR = headL.clone();
    headR.position.x = 0.56;
    grp.add(headL);
    headR.material = headMat.clone();
    grp.add(headR);

    var tlL = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.42, 0.1), tailMat.clone());
    tlL.position.set(-0.66, 0.78, -2.4);
    var tlR = tlL.clone();
    tlR.position.x = 0.66;
    tlR.material = tailMat.clone();
    grp.add(tlL);
    grp.add(tlR);

    var tailBar = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.086, 0.08), tailMat.clone());
    tailBar.position.set(0, 0.7, -2.46);
    grp.add(tailBar);

    var brake = headMat.clone();
    brake.emissive.copy(new THREE.Color(0xdc2626));
    brake.emissiveIntensity = 0.75;
    var brakeLm = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.1, 0.065), brake);
    brakeLm.position.set(0, 1.58, -1.68);
    grp.add(brakeLm);

    grp.traverse(function (o) {
      if (o.isMesh) {
        o.castShadow = true;
      }
    });
    return grp;
  }

  function cloneMeshMaterialsIndependent(root) {
    root.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      if (Array.isArray(o.material))
        o.material = o.material.map(function (m) {
          return m && m.clone ? m.clone() : m;
        });
      else if (o.material.clone) o.material = o.material.clone();
    });
  }

  function glassLikeMaterial(mat) {
    if (!mat) return false;
    if (typeof mat.opacity === "number" && mat.opacity < 0.93 && mat.transparent)
      return true;
    if (typeof mat.transmission === "number" && mat.transmission > 0.28)
      return true;
    var nm = ((mat.name || "") + "").toLowerCase();
    if (nm.indexOf("glass") >= 0 || nm.indexOf("window") >= 0) return true;
    if (nm.indexOf("windshield") >= 0 || nm.indexOf("windscreen") >= 0)
      return true;
    return false;
  }

  function tireLikeMaterial(mat) {
    if (!mat || typeof mat.roughness !== "number") return false;
    var nm = ((mat.name || "") + "").toLowerCase();
    if (nm.indexOf("tire") >= 0 || nm.indexOf("tyre") >= 0) return true;
    return mat.metalness < 0.12 && mat.roughness > 0.9;
  }

  /** 车体水平方向最大尺寸对齐到程序化车量级（便于 ACC_VEHICLE_MARGIN） */
  var CAR_BODY_HINT_MAX_LAT = Math.max(laneWidth * 0.47, 1.94);

  function prepareToyCarHierarchy(sceneRoot, yawY) {
    sceneRoot.updateMatrixWorld(true);
    sceneRoot.traverse(function (o) {
      if (o.isPerspectiveCamera || o.isOrthographicCamera || o.isLight)
        o.visible = false;
    });
    var wrap = new THREE.Group();
    wrap.add(sceneRoot);
    wrap.rotation.y =
      typeof yawY === "number" ? yawY : Math.PI;
    wrap.updateMatrixWorld(true);

    var box = new THREE.Box3().setFromObject(wrap);
    var sz = box.getSize(new THREE.Vector3());
    var xzMax = Math.max(sz.x, sz.z, 0.001);
    var scl = CAR_BODY_HINT_MAX_LAT / xzMax;

    wrap.scale.setScalar(scl);
    wrap.updateMatrixWorld(true);
    box.setFromObject(wrap);
    wrap.position.y = -box.min.y;

    wrap.traverse(function (o) {
      if (o.isMesh) {
        o.castShadow = true;
      }
    });
    return wrap;
  }

  function applyCarPaint(root, bodyHex, roofHex) {
    roofHex = roofHex !== undefined ? roofHex : bodyHex;
    var tint = new THREE.Color(bodyHex);
    var cool = new THREE.Color(roofHex);
    root.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      var mi;
      for (mi = 0; mi < mats.length; mi++) {
        var mat = mats[mi];
        if (
          !mat ||
          !(mat.color && typeof mat.color.lerp === "function")
        )
          continue;

        if (glassLikeMaterial(mat)) {
          mat.color.lerp(cool, 0.22);
          continue;
        }
        if (tireLikeMaterial(mat)) continue;

        if (
          typeof mat.metalness === "number" &&
          typeof mat.roughness === "number" &&
          mat.metalness > 0.92 &&
          mat.roughness < 0.4
        ) {
          mat.color.lerpVectors(
            tint.clone().multiplyScalar(0.86),
            mat.color.clone(),
            0.4
          );
        } else {
          mat.color.lerpVectors(
            tint,
            mat.color.clone(),
            0.74
          );
        }
      }
    });
  }

  function makeStyledVehicle(bodyHex, roofHex) {
    if (!carPreparedProto) return buildCar(bodyHex, roofHex);
    var veh = carPreparedProto.clone(true);
    cloneMeshMaterialsIndependent(veh);
    applyCarPaint(veh, bodyHex, roofHex);
    veh.traverse(function (o) {
      if (o.isMesh) {
        o.castShadow = true;
      }
    });
    veh.receiveShadow = true;
    return veh;
  }

  function loadToyCarPrototype() {
    carPreparedProto = null;
    return Promise.resolve(null);
  }

  /** Dashed lane divider at fixed lateral x (world space). Three lanes ⇒ two dividers at ±laneWidth/2. */
  function addStripeRow(sceneRef, x, baseZ, count) {
    var mat = new THREE.MeshBasicMaterial({ color: 0xf5faff, opacity: 0.96, transparent: true });
    var zz;
    for (zz = 0; zz < count; zz++) {
      var dz = zz * 3.35 + baseZ;
      var dash = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.68), mat.clone());
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(x, 0.05, dz);
      sceneRef.add(dash);
      laneDashMeshes.push(dash);
    }
  }

  /** 路侧随机树木 / 简模楼房，与路面同速滚动营造车速感 */
  function addRoadsideScenery(sceneRef) {
    var trunkMat = new THREE.MeshStandardMaterial({
      color: 0x6b4f3a,
      roughness: 0.92,
      metalness: 0.04,
    });
    var leafMat = new THREE.MeshStandardMaterial({
      color: 0x2f6b46,
      roughness: 0.88,
      metalness: 0.02,
    });
    var bldgMats = [
      new THREE.MeshStandardMaterial({
        color: 0x8899aa,
        roughness: 0.82,
        metalness: 0.08,
      }),
      new THREE.MeshStandardMaterial({
        color: 0xa8b8cc,
        roughness: 0.78,
        metalness: 0.1,
      }),
      new THREE.MeshStandardMaterial({
        color: 0x7d8c9f,
        roughness: 0.85,
        metalness: 0.06,
      }),
    ];
    var si;
    for (si = 0; si < 56; si++) {
      var seed = si * 9749 + 233;
      var side = pseudoRand(seed) > 0.48 ? 1 : -1;
      var bx = side * (roadHalf + 6 + pseudoRand(seed + 1) * 26);
      var z0 = -22 - si * (9.5 + pseudoRand(seed + 2) * 10.5);
      var grp = new THREE.Group();
      if (pseudoRand(seed + 3) > 0.36) {
        var trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.32, 0.42, 1.25, 6),
          trunkMat
        );
        trunk.position.y = 0.62;
        trunk.castShadow = true;
        var crown = new THREE.Mesh(
          new THREE.ConeGeometry(
            1.55 + pseudoRand(seed + 4) * 0.55,
            3.2 + pseudoRand(seed + 5) * 1.8,
            7
          ),
          leafMat
        );
        crown.position.y = 2.35;
        crown.castShadow = true;
        grp.add(trunk);
        grp.add(crown);
      } else {
        var h = 5 + pseudoRand(seed + 6) * 24;
        var w = 2.8 + pseudoRand(seed + 7) * 5.5;
        var d = 2.6 + pseudoRand(seed + 8) * 4.2;
        var body = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, d),
          bldgMats[si % bldgMats.length]
        );
        body.position.y = h * 0.5;
        body.castShadow = true;
        grp.add(body);
      }
      grp.position.set(bx, 0, z0);
      sceneRef.add(grp);
      sceneryGroups.push(grp);
    }
  }

  function bootScene(host) {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xc9dcf0);
    scene.fog = new THREE.FogExp2(0xbfd8ee, 0.0175);

    camera = new THREE.PerspectiveCamera(
      54,
      host.clientWidth / Math.max(host.clientHeight, 1),
      0.12,
      620
    );
    camera.position.set(0, 9.6, 19.8);
    camera.lookAt(0, 2.4, -60);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    host.appendChild(renderer.domElement);

    var amb = new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.95);
    scene.add(amb);
    var dir = new THREE.DirectionalLight(0xfff4e8, 1.08);
    dir.position.set(56, 86, -28);
    dir.castShadow = true;
    dir.shadow.mapSize.width = 2048;
    dir.shadow.mapSize.height = 2048;
    dir.shadow.camera.near = 2;
    dir.shadow.camera.far = 160;
    dir.shadow.camera.left = -55;
    dir.shadow.camera.right = 55;
    dir.shadow.camera.top = 55;
    dir.shadow.camera.bottom = -55;
    scene.add(dir);

    var asphalt = new THREE.MeshStandardMaterial({
      color: 0x596572,
      roughness: 0.93,
      metalness: 0.06,
    });

    var i;
    var edgeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
    });
    var el = roadHalf + 0.14;
    var leftEdge = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 720), edgeMat);
    leftEdge.rotation.x = -Math.PI / 2;
    leftEdge.position.set(-el, 0.06, -200);
    scene.add(leftEdge);
    shoulderMeshes.push(leftEdge);
    var rightEdge = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 720), edgeMat.clone());
    rightEdge.rotation.x = -Math.PI / 2;
    rightEdge.position.set(el, 0.06, -200);
    scene.add(rightEdge);
    shoulderMeshes.push(rightEdge);

    for (i = 0; i < 18; i++) {
      var road = new THREE.Mesh(
        new THREE.PlaneGeometry(roadHalf * 2 + 28, 32),
        asphalt
      );
      road.rotation.x = -Math.PI / 2;
      road.receiveShadow = true;
      road.position.z = -i * 32 - 8;
      scene.add(road);
      roadSegmentMeshes.push(road);
      var divX = laneWidth / 2;
      addStripeRow(scene, -divX, road.position.z + 10, 12);
      addStripeRow(scene, divX, road.position.z + 10, 12);
    }

    addRoadsideScenery(scene);

    guideMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(laneWidth * 0.92, 180),
      new THREE.MeshStandardMaterial({
        color: 0x40a9ff,
        transparent: true,
        opacity: 0.52,
        metalness: 0.06,
        roughness: 0.44,
        emissive: 0x1578ff,
        emissiveIntensity: 0.45,
      })
    );
    guideMesh.rotation.x = -Math.PI / 2;
    guideMesh.position.set(0, 0.085, -110);
    scene.add(guideMesh);

    egoMesh = makeStyledVehicle(0xfcfdff, 0xb8dcf5);
    egoMesh.position.set(0, 0.02, -4.2);
    egoMesh.receiveShadow = true;
    scene.add(egoMesh);

    for (i = 0; i < 14; i++) {
      var tn = makeStyledVehicle(i % 4 === 0 ? 0xc8e2f8 : 0xb4daf4, 0x8ebfe0);
      tn.position.set(
        laneIndexToX(((i * 5) % 3) | 0),
        0.02,
        -26 - ((i * 99) % 320)
      );
      trafficMeshes.push(tn);
      scene.add(tn);
    }
  }

  /** 本车道纵向走廊内最近前车（世界坐标：前方车辆 z 更负） */
  var ACC_CORRIDOR_X = laneWidth * 0.46;
  /** 车头到前车车尾估算用的车长余量（米） */
  var ACC_VEHICLE_MARGIN = 4.75;
  /** 过近时把车往前「推开」避免模型穿插 */
  var ACC_MIN_CENTER_Z = 6.1;

  /** ACC / 自动超车与本车道对齐的横向中心：用座舱 lane（非车身插补位移），否则会「误判无前车」或长期盯错邻道车流 */
  function laneCenterXFromState(st) {
    var li =
      st && typeof st.lane === "number" ? Math.round(st.lane) : 1;
    li = Math.max(0, Math.min(2, li));
    return laneIndexToX(li);
  }

  function computeLeadGapMeters(st) {
    if (!egoMesh) return null;
    var egoZ = egoMesh.position.z;
    var cx = laneCenterXFromState(st);
    var best = Infinity;
    var k;
    for (k = 0; k < trafficMeshes.length; k++) {
      var tm = trafficMeshes[k];
      if (Math.abs(tm.position.x - cx) > ACC_CORRIDOR_X) continue;
      var dz = egoZ - tm.position.z;
      if (dz > 0.45 && dz < best) best = dz;
    }
    if (best === Infinity) return null;
    return Math.max(0, best - ACC_VEHICLE_MARGIN);
  }

  /** 邻车道可否安全并入：纵向无紧邻车、前方不紧挨慢车 — 用于自动超车选道 */
  function evaluateAdjacentLane(laneIdx) {
    var egoZ = egoMesh.position.z;
    var cx = laneIndexToX(laneIdx);
    var k;
    var minAbs = Infinity;
    var bestFwd = Infinity;
    for (k = 0; k < trafficMeshes.length; k++) {
      var tm = trafficMeshes[k];
      if (Math.abs(tm.position.x - cx) > ACC_CORRIDOR_X * 1.06) continue;
      var dz = egoZ - tm.position.z;
      var az = Math.abs(dz);
      if (az < minAbs) minAbs = az;
      if (dz > 0.58 && dz < bestFwd) bestFwd = dz;
    }
    if (minAbs === Infinity) {
      return { ok: true, score: 100 };
    }
    if (minAbs < 5) {
      return { ok: false, score: -1 };
    }
    var fwdGap =
      bestFwd === Infinity ? 72 : Math.max(0, bestFwd - ACC_VEHICLE_MARGIN);
    if (bestFwd !== Infinity && fwdGap < 8.8) {
      return { ok: false, score: -1 };
    }
    return { ok: true, score: fwdGap };
  }

  /** 前车过近时尝试自动变道；优先左侧（靠左超车习惯），两车都空则选纵向余量更大的 */
  function maybeAutoOvertake(st, gapM) {
    if (
      !window.Cockpit ||
      typeof window.Cockpit.tryAutoOvertake !== "function"
    ) {
      return;
    }
    if (!egoMesh || !st || st.stopped || st.pullOver) return;
    if (st.autoOvertakeEnabled === false) return;
    if ((st.overtakeAnim || 0) > 0.1) return;
    if (gapM == null || !isFinite(gapM)) return;
    if (gapM > 32 || gapM < 2.6) return;
    var cruise = st.targetCruiseKmh != null ? st.targetCruiseKmh : 80;
    /** 任一成立即视作「前车压制」：表速明显低于巡航，或车间距仍然偏紧 */
    var speedHeldBack = st.speedKmh + 8 < cruise;
    var gapTight = gapM <= 26;
    if (!(speedHeldBack || gapTight)) return;

    var lane = typeof st.lane === "number" ? st.lane : 1;
    lane = Math.max(0, Math.min(2, Math.round(lane)));

    var li = lane > 0 ? evaluateAdjacentLane(lane - 1) : null;
    var ri = lane < 2 ? evaluateAdjacentLane(lane + 1) : null;
    var leftOk = !!(li && li.ok);
    var rightOk = !!(ri && ri.ok);
    var side = 0;
    if (leftOk && rightOk) {
      side = (li.score >= ri.score ? -1 : 1);
      if (li.score === ri.score) side = -1;
    } else if (leftOk) {
      side = -1;
    } else if (rightOk) {
      side = 1;
    }
    if (side !== 0) {
      window.Cockpit.tryAutoOvertake(side);
    }
  }

  function nudgeTrafficSeparation(delta, st) {
    if (!egoMesh) return;
    var egoZ = egoMesh.position.z;
    var cx = laneCenterXFromState(st);
    var k;
    for (k = 0; k < trafficMeshes.length; k++) {
      var tm = trafficMeshes[k];
      if (Math.abs(tm.position.x - cx) > ACC_CORRIDOR_X) continue;
      var dz = egoZ - tm.position.z;
      if (dz > 0.15 && dz < ACC_MIN_CENTER_Z) {
        tm.position.z -= (ACC_MIN_CENTER_Z - dz) * 4.2 * delta;
      }
    }
  }

  /** 沥青带、虚线护栏、路肩、侧景统一按车速平移 */
  function scrollWorldFlow(flow) {
    var segLen = 32;
    var i;
    for (i = 0; i < roadSegmentMeshes.length; i++) {
      var rm = roadSegmentMeshes[i];
      rm.position.z += flow;
      if (rm.position.z > 35) {
        var minZ = Infinity;
        var k;
        for (k = 0; k < roadSegmentMeshes.length; k++) {
          var zz = roadSegmentMeshes[k].position.z;
          if (zz < minZ) minZ = zz;
        }
        rm.position.z = minZ - segLen;
      }
    }
    for (i = 0; i < laneDashMeshes.length; i++) {
      var dm = laneDashMeshes[i];
      dm.position.z += flow;
      if (dm.position.z > 40) dm.position.z -= 280;
    }
    for (i = 0; i < shoulderMeshes.length; i++) {
      var sh = shoulderMeshes[i];
      sh.position.z += flow;
      if (sh.position.z > 140) sh.position.z -= 480;
    }
    for (i = 0; i < sceneryGroups.length; i++) {
      var sg = sceneryGroups[i];
      sg.position.z += flow * 0.97;
      if (sg.position.z > 50) sg.position.z -= 560;
    }
  }

  function tick(frameAt) {
    requestAnimationFrame(tick);
    frameAt = frameAt || performance.now();
    if (
      window.__cockpitVoiceCapturing &&
      frameAt - lastVoiceRenderAt < 50
    ) {
      return;
    }
    lastVoiceRenderAt = frameAt;
    var st = getState();
    var delta = Math.min(clock.getDelta(), 0.1);
    var spd = st ? Math.max(0, st.speedKmh || 0) : 0;

    var FLOW = spd * FLOW_K * delta;
    scrollWorldFlow(FLOW);

    var otSide =
      st && st.overtakeSide !== undefined && st.overtakeSide < 0 ? -1 : 1;
    var targetX =
      laneIndexToX(st && st.lane !== undefined ? st.lane : 1) +
      (st ? (st.overtakeAnim || 0) * laneWidth * 0.45 * otSide : 0);
    if (egoMesh) {
      /** 换道横向：压低收敛系数 + 每帧限速，避免「猛打方向盘」观感 */
      var dx = targetX - egoMesh.position.x;
      var latK = 3.05;
      var stepRaw = dx * latK * delta;
      var maxLatPerSec =
        spd > 55 ? 2.85 : spd > 20 ? 2.35 : 1.85;
      var stepCap = maxLatPerSec * delta;
      egoMesh.position.x += THREE.MathUtils.clamp(stepRaw, -stepCap, stepCap);
      egoMesh.position.y =
        0.02 +
        (st && st.pullOver
          ? 0
          : Math.sin(performance.now() * 0.0024) * (spd > 50 ? 0.02 : 0.012));
      var rollFromErr = THREE.MathUtils.clamp(dx * 0.022, -0.05, 0.05);
      egoMesh.rotation.z = THREE.MathUtils.lerp(
        egoMesh.rotation.z,
        rollFromErr,
        Math.min(1, delta * 4.8)
      );
    }

    if (guideMesh && egoMesh) {
      guideMesh.position.x = THREE.MathUtils.lerp(
        guideMesh.position.x,
        egoMesh.position.x,
        0.06
      );
    }

    var j;
    for (j = 0; j < trafficMeshes.length; j++) {
      var tm = trafficMeshes[j];
      var rel = 0.74 + (((j * 13) % 25) / 100);
      tm.position.z +=
        FLOW * rel * ((j % 7) === 3 ? 1.1 : 1);
      if (tm.position.z > 18) tm.position.z -= 330;
    }

    nudgeTrafficSeparation(delta, st);
    var gapM = computeLeadGapMeters(st);
    if (window.Cockpit && typeof window.Cockpit.applyAdaptiveCruise === "function") {
      window.Cockpit.applyAdaptiveCruise(gapM, delta);
      st = getState();
      spd = st ? Math.max(0, st.speedKmh || 0) : spd;
      maybeAutoOvertake(st, gapM);
    }

    if (camera && egoMesh) {
      camera.position.x = THREE.MathUtils.lerp(
        camera.position.x,
        egoMesh.position.x * 0.88,
        delta * 3.25
      );
      camera.position.z = 19.8 + (spd > 100 ? 2.2 : 0);
      camera.lookAt(
        egoMesh.position.x * 0.5,
        egoMesh.position.y + 2.9,
        egoMesh.position.z - 112
      );
    }

    if (renderer && scene && camera) renderer.render(scene, camera);

    updateHud(spd, st);
    drawMini(st);
  }

  function updateHud(spd, st) {
    var ringNum = document.getElementById("speedRingText");
    if (ringNum) {
      ringNum.textContent = String(Math.round(st && st.stopped ? 0 : spd));
    }

    var limit = document.getElementById("hudSpeedLimit");
    if (limit)
      limit.textContent =
        spd > 0 ? String(Math.min(120, Math.max(70, Math.round(spd)))) : "80";

    var ringFg = document.querySelector(".viewport-hud .ring-fg");
    if (ringFg) {
      var c = 326;
      var pct = Math.min(160, Math.max(0, spd)) / 160;
      ringFg.style.strokeDashoffset = String(c - pct * c * 0.82);
    }

    var pill = document.getElementById("adasPill");
    var pillIco = document.getElementById("adasPillIco");
    var pillLbl = document.getElementById("adasPillLabel");
    var showOvertake = st && (st.overtakeAnim || 0) > 0.08;
    if (pill)
      pill.classList.toggle("hidden", !showOvertake);
    if (pillIco && pillLbl && showOvertake) {
      var cmdLbl = st.overtakeCmdLabel ? String(st.overtakeCmdLabel).trim() : "";
      var leftMotion = st.overtakeSide !== undefined && st.overtakeSide < 0;
      pillIco.textContent = leftMotion ? "\u21b0" : "\u21b1";
      pillLbl.textContent = cmdLbl || (leftMotion ? "左侧变道" : "右侧变道");
    }

    var man = document.getElementById("navNextManeuverBig");
    if (man && st)
      man.textContent = st.remainKm > 90 ? ">99 km" : st.remainKm.toFixed(1) + " km";

  }

  function drawMini(st) {
    var cvs = document.getElementById("minimapCanvas");
    if (!cvs || !egoMesh) return;
    var c = cvs.getContext("2d");
    var W = cvs.width;
    var H = cvs.height;

    var grd = c.createRadialGradient(W / 2, H / 2, 4, W / 2, H / 2, W / 2);
    grd.addColorStop(0, "#eaf3fb");
    grd.addColorStop(1, "#d8e8f8");
    c.fillStyle = grd;
    c.fillRect(0, 0, W, H);
    c.strokeStyle = "#7aa8d4";
    c.strokeRect(0.5, 0.5, W - 1, H - 1);

    var cx = W / 2;
    var baseY = H * 0.72;

    [-1, 0, 1].forEach(function (lb) {
      c.fillStyle = lb === 0 ? "#a8cae8" : "#d2e6f9";
      c.fillRect(cx + lb * 22 - 10, baseY - 95, 20, H);
    });

    trafficMeshes.forEach(function (tm) {
      c.fillStyle = "#6bb3e8";
      c.beginPath();
      c.arc(
        cx + (tm.position.x - egoMesh.position.x) * 5.5,
        baseY - (tm.position.z - egoMesh.position.z) * 0.28,
        3.2,
        0,
        Math.PI * 2
      );
      c.fill();
    });

    c.fillStyle = "#ffffff";
    c.shadowColor = "rgba(50,120,200,0.45)";
    c.shadowBlur = 8;
    c.beginPath();
    c.arc(cx, baseY, 6, 0, Math.PI * 2);
    c.fill();
    c.shadowBlur = 0;
    c.fillStyle = "#38a3ff";
    c.beginPath();
    c.arc(cx, baseY, 3.5, 0, Math.PI * 2);
    c.fill();

  }

  function onResize(host) {
    if (!camera || !renderer || !host) return;
    camera.aspect = host.clientWidth / Math.max(host.clientHeight, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  }

  async function start() {
    var host = document.getElementById("road3dHost");
    if (!host) return;
    await loadToyCarPrototype();
    bootScene(host);
    window.addEventListener("resize", function () {
      onResize(host);
    });
    tick();
    window.CockpitRoad3D = {
      resize: function () {
        onResize(host);
      },
      getLeadGapMeters: computeLeadGapMeters,
    };
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();

