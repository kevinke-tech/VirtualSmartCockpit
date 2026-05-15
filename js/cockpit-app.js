/**
 * Virtual Smart Cockpit — HMI state, virtual road, overlays, music, coffee, scenic.
 *
 * 「视频链路」对照 E:\\21_Coding\\vui：
 *   - vui 使用 <video id="videoPlayer"> 点播外链视频 + voice-doubao 里对视频的串音抑制。
 *   - 右侧路况为 THREE.js 第三人称高速路（js/road-three.js）；音乐用 <audio id="cockpitMusic">（外链playlist 见 TRACKS）
 *     构图打卡用 <video id="camPreview"> getUserMedia，逻辑上仍属「扬声器/回声」链路，
 *     由 sibling js/voice-cockpit.js（由 vui 的 voice-doubao 改编）监听 #cockpitMusic 与 #cockpitVideo（媒体回声抑制）。
 */
(function () {
  "use strict";

  var OVERLAY_IDLE_MS = 5000;
  /** 仿真扫码支付完成后，再等此时间自动收起点咖啡页（非 idle 倒计时） */
  var COFFEE_POST_PAY_CLOSE_MS = 5000;

  /**
   * 风景打卡「车外虚拟取景」：与座舱场景一致的摄影素材（汽车 · 自驾游 · 公路/城市 · 户外风景），
   * 每次打开打卡页递增 seed 在本列表中轮询。图源 Unsplash（需网络可达；CDN 带 CORS 便于 canvas 拼接）。
   */
  var SCENIC_EXTERIOR_URLS = [
    "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&w=960&h=540&q=80",
    "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=960&h=540&q=80",
    "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?auto=format&fit=crop&w=960&h=540&q=80",
    "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=960&h=540&q=80",
    "https://images.unsplash.com/photo-1449824913935-59a10b8d2000?auto=format&fit=crop&w=960&h=540&q=80",
    "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?auto=format&fit=crop&w=960&h=540&q=80",
    "https://images.unsplash.com/photo-1502877338535-766e1452684a?auto=format&fit=crop&w=960&h=540&q=80",
    "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=960&h=540&q=80",
    "https://images.unsplash.com/photo-1489515217757-5fd1be406fef?auto=format&fit=crop&w=960&h=540&q=80",
  ];

  var state = {
    totalKm: 100,
    remainKm: 90,
    dest: "公司",
    waypoints: [],
    speedKmh: 80,
    /** ACC 目标巡航（前车清空后收敛到此速度；语音加减车速会改它） */
    targetCruiseKmh: 80,
    totalMin: 75,
    /** 仿真用 */
    roadMode: "cruise",
    lane: 1,
    overtakeAnim: 0,
    /** 超车动画横向摆动：-1 左、+1 右（与本次变道位移一致） */
    overtakeSide: 1,
    /** HUD 与语音话术：「向左超车」「向右超车」 */
    overtakeCmdLabel: "",
    /** ADAS：前车过近时由路况脚本触发自动变道，关闭后仅能手/语音超车 */
    autoOvertakeEnabled: true,
    pullOver: false,
    stopped: false,
    music: {
      on: false,
      index: 0,
      volume: 0.7,
      playing: false,
    },
    ac: {
      on: true,
      temp: 23,
      passTemp: 23,
      sync: true,
      compressor: true,
      auto: false,
      fan: 2,
      wind: "均匀",
    },
    panels: {
      nav: false,
      ac: false,
      music: false,
      coffee: false,
      scenic: false,
      video: false,
    },
    video: {
      index: 0,
      volume: 0.85,
    },
    coffee: {
      cart: [],
      qr: false,
      lastShop: null,
      pendingCheckoutShop: null,
      /** 顺路推荐店名（打开点单或首次加购时生成，用于 UI 与途经点） */
      suggestedShop: null,
    },
    coffeeUi: { tab: 0, catIdx: 0 },
    scenic: { compositeDataUrl: null, shooting: false, exteriorSeed: 0 },
    /** 驾驶员监测（闭眼/疲劳弹窗）：false 时不做检测、不弹窗 */
    dms: { enabled: true },
    navSearch: "",
    /** 沿路 POI 多选：与订咖啡/接人途经点共用 waypoints 列表 */
    poiPickSession: null,
    /** 演示收件箱：好友约接人地点，供大模型上下文与「信息里那个地方」解析 */
    messages: [
      {
        id: "demo-pickup-1",
        from: "阿杰",
        body:
          "兄弟，我今晚加班到八点左右，等会儿能不能顺路来接我一下？我在深圳湾万象城 B2 层网约车专区等你，到了给我发微信。",
        place_hint: "深圳湾万象城 B2 层网约车专区",
        at: "2 分钟前",
      },
    ],
    /** 最近一次代发回复（演示） */
    msgLastReply: null,
  };

  var overlayTimers = {};
  var tickHandle = null;

  /**
   * 免费外链试听 · 偏重「华语流行临场感」（林海《流动的城市》维基 CC 演奏版、中文童趣钢琴习作等）。
   * 另有街头路演实录、女声合唱现场、贺岁采风、游戏机厅轻快电音，以及 Hitomi Jamendo / Kevin MacLeod 东方走向。
   * 不包含版权金曲整曲（如港台榜单录音）；可自行在本地 music/ 放入自有 MP3 并改 url。
   */
  var TRACKS = [
    {
      title: "流动的城市（林海 Lin Hai｜维基 CC 演奏版）",
      artist: "Jason M. C., Han（演奏）",
      album: "Wikimedia Commons · CC BY-SA",
      url: "https://upload.wikimedia.org/wikipedia/commons/c/c9/Flowing_City_%28Lin_Hai%29%2C_Player_and_Teacher_JMC%2CHan_%28Jason%29.ogg",
    },
    {
      title: "Kid's Dance（Chinese）童趣钢琴习作",
      artist: "Kunlu, Han · Jason M.C. Han 项目",
      album: "Wikimedia Commons · CC BY-SA",
      url: "https://upload.wikimedia.org/wikipedia/commons/6/69/Kid%27s_Dance_%28Chinese%29_-_Student_Kunlu%2C_Han.ogg",
    },
    {
      title: "北京街头路演（器乐与人声采风）",
      artist: "iainmccurdy",
      album: "Freesound · CC BY",
      url: "https://cdn.freesound.org/previews/571/571353_3655844-hq.mp3",
    },
    {
      title: "上海女声合唱现场（当代艺术双年展）",
      artist: "RTB45",
      album: "Freesound · CC BY",
      url: "https://cdn.freesound.org/previews/327/327446_2409224-hq.mp3",
    },
    {
      title: "游戏机厅娃娃机轻快电音",
      artist: "ho52nest",
      album: "Freesound · CC BY",
      url: "https://cdn.freesound.org/previews/585/585717_12796956-hq.mp3",
    },
    {
      title: "春节唐人街贺岁采风（器乐与人声）",
      artist: "kevp888",
      album: "Freesound · CC BY",
      url: "https://cdn.freesound.org/previews/676/676174_9034501-hq.mp3",
    },
    {
      title: "中华风管弦「Wuxia」",
      artist: "PeriTune",
      album: "Wikimedia · CC BY",
      url: "https://upload.wikimedia.org/wikipedia/commons/7/76/%E3%80%90%E7%84%A1%E6%96%99%E3%83%95%E3%83%AA%E3%83%BCBGM%E3%80%91%E4%B8%AD%E8%8F%AF%E9%A2%A8%E3%81%AE%E5%8B%87%E5%A3%AE%E3%81%AA%E3%82%AA%E3%83%BC%E3%82%B1%E3%82%B9%E3%83%88%E3%83%A9%E6%9B%B2%E3%80%8CWuxia%E3%80%8D.ogg",
    },
    {
      title: "Oriental Music Library HB2001",
      artist: "Hitomi Lai",
      album: "Jamendo · CC BY-NC-ND",
      url: "https://prod-1.storage.jamendo.com/?trackid=1371990&format=mp32",
    },
    {
      title: "Oriental Music Library MH019",
      artist: "Hitomi Lai",
      album: "Jamendo · CC BY-NC-ND",
      url: "https://prod-1.storage.jamendo.com/?trackid=1266902&format=mp32",
    },
    {
      title: "Tea Roots",
      artist: "Kevin MacLeod",
      album: "Incompetech · CC BY",
      url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Tea%20Roots.mp3",
    },
    {
      title: "Tabuk",
      artist: "Kevin MacLeod",
      album: "Incompetech · CC BY",
      url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Tabuk.mp3",
    },
  ];

  /** 虚拟咖啡菜单（参考连锁点单结构，无真实下单） */
  var COFFEE_MENU = [
    {
      id: "hot",
      label: "人气Top",
      badge: "上新",
      items: [
        {
          sku: "latte-raw",
          name: "生椰拿铁",
          desc: "浓郁椰香与浓缩咖啡融合",
          price: 36,
          orig: 42,
          tags: ["人气"],
          grad: "linear-gradient(145deg,#134e4a,#0f766e)",
        },
        {
          sku: "orange-am",
          name: "橙C美式",
          desc: "真实橙汁 · 清爽低负担",
          price: 28,
          orig: 35,
          tags: ["季节"],
          grad: "linear-gradient(145deg,#9a3412,#ea580c)",
        },
      ],
    },
    {
      id: "americano",
      label: "美式家族",
      items: [
        {
          sku: "std-am",
          name: "标准美式",
          desc: "金奖拼配 · 香醇平衡",
          price: 25,
          orig: 32,
          tags: ["金奖豆"],
          grad: "linear-gradient(145deg,#2a1810,#5c3d2e)",
        },
        {
          sku: "ice-am",
          name: "加浓美式",
          desc: "双倍浓缩 · 更提神",
          price: 27,
          orig: 33,
          tags: [],
          grad: "linear-gradient(145deg,#1c1410,#422c22)",
        },
      ],
    },
    {
      id: "latte",
      label: "拿铁",
      items: [
        {
          sku: "latte-std",
          name: "经典拿铁",
          desc: "丝滑奶泡 · 日常首选",
          price: 32,
          orig: 38,
          tags: [],
          grad: "linear-gradient(145deg,#57534e,#d6d3d1)",
        },
        {
          sku: "mocha",
          name: "摩卡",
          desc: "巧克力与咖啡经典搭配",
          price: 34,
          orig: 40,
          tags: [],
          grad: "linear-gradient(145deg,#422006,#713f12)",
        },
      ],
    },
    {
      id: "tea",
      label: "茶饮",
      items: [
        {
          sku: "milk-tea",
          name: "轻乳茶",
          desc: "低糖配方 · 清爽不腻",
          price: 22,
          orig: 28,
          tags: ["首杯价"],
          grad: "linear-gradient(145deg,#14532d,#166534)",
        },
      ],
    },
  ];

  function findCoffeeSku(sku) {
    var c, i;
    for (c = 0; c < COFFEE_MENU.length; c++) {
      for (i = 0; i < COFFEE_MENU[c].items.length; i++) {
        if (COFFEE_MENU[c].items[i].sku === sku) return COFFEE_MENU[c].items[i];
      }
    }
    return null;
  }

  function listCoffeeCatalog() {
    var out = [];
    var c, i;
    for (c = 0; c < COFFEE_MENU.length; c++) {
      for (i = 0; i < COFFEE_MENU[c].items.length; i++) {
        out.push(COFFEE_MENU[c].items[i]);
      }
    }
    return out;
  }

  function coffeeMenuSpeechHint(maxNames) {
    var mx = typeof maxNames === "number" ? maxNames : 6;
    var names = listCoffeeCatalog().map(function (it) {
      return it.name;
    });
    return names.slice(0, mx).join("、");
  }

  function pickAlongRouteCoffeeShopDemo(destLabel) {
    var d = (destLabel || "目的地").trim() || "目的地";
    return (
      "顺路备选咖啡店 · 「星空咖啡~" +
      d +
      "沿线」（距主路线约800m·仿真）"
    );
  }

  function ensureCoffeeSuggestedShop() {
    if (state.coffee.suggestedShop) return state.coffee.suggestedShop;
    var s = pickAlongRouteCoffeeShopDemo(state.dest || "目的地");
    state.coffee.suggestedShop = s;
    return s;
  }

  function formatCartSummaryInline() {
    if (!state.coffee.cart.length) return "";
    var parts = [];
    var i;
    for (i = 0; i < state.coffee.cart.length; i++) {
      var ln = state.coffee.cart[i];
      parts.push((ln.name || ln.sku || "饮品") + "×" + (ln.qty || 1));
    }
    return parts.join("；");
  }

  /**
   * 语音/模型给出的饮品名 → sku；无法确信匹配时返回 null（勿默认乱加一杯美式）。
   * 使用 normalizeDrinkKey：拉丁字母统一小写，避免「橙C / 橙c」对不上菜单名。
   */
  function normalizeDrinkKey(s) {
    return String(s || "")
      .replace(/\s+/g, "")
      .trim()
      .toLowerCase();
  }

  function resolveCoffeeSkuFromSpeech(text, explicitSku) {
    var ex = (explicitSku != null ? String(explicitSku).trim() : "") || "";
    if (ex && findCoffeeSku(ex)) return ex;
    var rawLc = normalizeDrinkKey(text);
    if (!rawLc) return null;

    var items = listCoffeeCatalog();
    var bestSku = null;
    var best = 0;
    var xi, cand, nx, overlap;
    for (xi = 0; xi < items.length; xi++) {
      cand = items[xi];
      nx = normalizeDrinkKey(cand.name);
      if (!nx) continue;
      if (rawLc.indexOf(nx) !== -1 || nx.indexOf(rawLc) !== -1) {
        overlap = Math.min(nx.length, rawLc.length);
        if (overlap > best) {
          best = overlap;
          bestSku = cand.sku;
        }
      }
    }
    if (bestSku && best >= 2) return bestSku;

    if (/橙.?美式|^橙c|橙汁美式|橙汁/.test(rawLc)) return "orange-am";
    if (/生椰拿铁|^生椰|椰浆拿铁|椰云拿铁/.test(rawLc)) return "latte-raw";
    if ((/椰拿|生椰|椰浆/.test(rawLc)) && /拿铁/.test(rawLc)) return "latte-raw";
    if (/加浓|双倍/.test(rawLc) && (/美式|浓缩/.test(rawLc) || rawLc.length <= 8))
      return "ice-am";
    if (/美式/.test(rawLc) && !/橙|果|加浓|浓/.test(rawLc)) return "std-am";
    if (/拿铁/.test(rawLc) && !/生椰|椰|椰浆/.test(rawLc)) return "latte-std";
    if (/摩卡/.test(rawLc)) return "mocha";
    if (/乳茶|轻乳|奶茶/.test(rawLc)) return "milk-tea";
    return bestSku || null;
  }

  /** @deprecated 仅保留给旧话术；新路应使用 resolveCoffeeSkuFromSpeech */
  function guessSkuFromName(name) {
    var sku = resolveCoffeeSkuFromSpeech(name);
    return sku || "std-am";
  }

  function addCoffeeSku(sku, addQty) {
    var qtyAdd = typeof addQty === "number" && addQty >= 1 ? Math.floor(addQty) : 1;
    var it = findCoffeeSku(sku);
    if (!it) return false;
    var k, cart = state.coffee.cart;
    for (k = 0; k < cart.length; k++) {
      if (cart[k].sku === sku) {
        cart[k].qty += qtyAdd;
        syncChrome();
        return true;
      }
    }
    cart.push({
      sku: sku,
      name: it.name,
      price: it.price,
      qty: qtyAdd,
    });
    syncChrome();
    return true;
  }

  function renderCoffeeUi() {
    var catNav = $("coffeeCatNav");
    var list = $("coffeeProductList");
    var filters = $("coffeeFilterPills");
    var modal = document.querySelector(".coffee-modal");
    if (!catNav || !list) return;

    if (modal) {
      modal.classList.toggle("coffee-modal--tea", state.coffeeUi.tab === 1);
    }

    if (state.panels.coffee) {
      ensureCoffeeSuggestedShop();
    }

    var menu = COFFEE_MENU;
    if (state.coffeeUi.tab === 1) {
      menu = COFFEE_MENU.map(function (cat) {
        var copy = {
          id: cat.id,
          label: cat.label,
          badge: cat.badge,
          items: cat.items.filter(function (it) {
            return /茶|椰|橙|拿铁|轻乳|果/.test(it.name) || (it.tags && it.tags.length);
          }),
        };
        return copy;
      }).filter(function (c) {
        return c.items.length > 0;
      });
    }

    if (state.coffeeUi.catIdx >= menu.length) state.coffeeUi.catIdx = 0;
    var activeCat = menu[state.coffeeUi.catIdx];
    if (!activeCat) return;

    catNav.innerHTML = menu
      .map(function (cat, idx) {
        var b = cat.badge
          ? '<span class="coffee-cat-badge">' + cat.badge + "</span>"
          : "";
        return (
          '<button type="button" class="coffee-cat-item' +
          (idx === state.coffeeUi.catIdx ? " is-active" : "") +
          '" data-cat-idx="' +
          idx +
          '">' +
          "<i></i><span>" +
          cat.label +
          "</span>" +
          b +
          "</button>"
        );
      })
      .join("");

    if (filters) {
      filters.innerHTML =
        '<span class="coffee-filter is-active">全部（' +
        activeCat.items.length +
        "）</span>" +
        '<span class="coffee-filter">门店热销</span>';
    }

    list.innerHTML = activeCat.items
      .map(function (it) {
        var tags = (it.tags || [])
          .map(function (t) {
            return '<span class="coffee-tag">' + t + "</span>";
          })
          .join("");
        return (
          '<article class="coffee-card" data-sku="' +
          it.sku +
          '">' +
          '<div class="coffee-card-img" style="background:' +
          it.grad +
          '"><span class="coffee-cup">☕</span></div>' +
          '<div class="coffee-card-body">' +
          "<h4>" +
          it.name +
          "</h4>" +
          '<div class="coffee-card-tags">' +
          tags +
          "</div>" +
          '<p class="coffee-card-desc">' +
          it.desc +
          "</p>" +
          '<div class="coffee-card-row">' +
          '<div class="coffee-price"><span class="coffee-price-now">¥' +
          it.price +
          '</span><span class="coffee-price-was">¥' +
          it.orig +
          '</span></div><button type="button" class="coffee-add" data-add-sku="' +
          it.sku +
          '" aria-label="加入' +
          it.name +
          '">+</button>' +
          "</div></div></article>"
        );
      })
      .join("");

    var ob = $("coffeeOrderedBlock");
    if (ob) {
      ob.classList.toggle("coffee-ordered-panel--has-items", state.coffee.cart.length > 0);
      if (!state.coffee.cart.length) {
        ob.innerHTML =
          '<div class="coffee-ordered-empty"><strong>当前已选：</strong>暂无。可在下方菜单点蓝色加号，或语音说「来一个生椰拿铁」「加杯橙 C 美式」。</div>';
      } else {
        var linesHtml = state.coffee.cart
          .map(function (ln) {
            var q = ln.qty || 1;
            var sub = (ln.price || 0) * q;
            return (
              '<li class="coffee-ordered-line"><span>' +
              (ln.name || ln.sku || "饮品") +
              " × " +
              q +
              '</span><span class="coffee-ordered-meta">¥' +
              sub +
              "</span></li>"
            );
          })
          .join("");
        ob.innerHTML =
          '<div class="coffee-ordered-title">当前已选（明细）</div><ul class="coffee-ordered-list">' +
          linesHtml +
          "</ul>" +
          '<p class="coffee-ordered-hint">还需要其他东西吗？可以说「再来一杯 xxx」。若不再需要，可说「不用了」「就这些」，将为您<strong>调出收款码</strong>。</p>';
      }
    }

    var ssEl = $("coffeeShopSuggest");
    if (ssEl) {
      if (state.panels.coffee && state.coffee.suggestedShop) {
        var subQr = state.coffee.qr
          ? "该店已加入<strong>左侧导航途经点</strong>。请扫上方收款码完成虚拟支付。"
          : "点击下方「去结算」或口述结账时，会把该推荐店<strong>写入导航途经点</strong>。";
        ssEl.innerHTML =
          '<div class="coffee-shop-suggest__inner"><span class="coffee-shop-suggest__ico" aria-hidden="true">📍</span><div class="coffee-shop-suggest__body"><div class="coffee-shop-suggest__k">顺路取餐（仿真推荐）</div><div class="coffee-shop-suggest__name">' +
          state.coffee.suggestedShop +
          '</div><div class="coffee-shop-suggest__sub">' +
          subQr +
          "</div></div></div>";
        ssEl.hidden = false;
      } else {
        ssEl.innerHTML = "";
        ssEl.hidden = true;
      }
    }

    var cf = $("coffeeCartSummaryFoot");
    if (cf) {
      if (!state.coffee.cart.length) {
        cf.innerHTML = "";
      } else {
        cf.innerHTML =
          '<span class="coffee-cart-summary-foot__label">本单已选</span><span class="coffee-cart-summary-foot__txt">' +
          formatCartSummaryInline() +
          "</span>";
      }
    }

    var total = 0;
    var count = 0;
    state.coffee.cart.forEach(function (line) {
      total += line.price * line.qty;
      count += line.qty;
    });
    var badge = $("coffeeCartBadge");
    var totEl = $("coffeeCartTotal");
    if (badge) {
      badge.textContent = count > 0 ? String(count) : "0";
      badge.classList.toggle("coffee-badge--on", count > 0);
    }
    if (totEl) totEl.textContent = "¥" + total;

    var qrEl = $("coffeeQrSlot");
    if (qrEl) qrEl.classList.toggle("hidden", !state.coffee.qr);
  }
  function $(id) {
    return document.getElementById(id);
  }

  function speakOrToast(msg) {
    var el = $("toastLine");
    if (el) el.textContent = msg;
    /** 一车一张嘴：先入队播报；与其它模块互不抢声道 */
    if (window.CockpitTTS && typeof window.CockpitTTS.speak === "function")
      window.CockpitTTS.speak(msg, {});
    else if (typeof window.speakTTS === "function") window.speakTTS(msg, {});
  }

  function clearOverlayTimer(name) {
    if (overlayTimers[name]) clearTimeout(overlayTimers[name]);
    overlayTimers[name] = null;
  }

  function bumpOverlay(name) {
    if (name === "music" || name === "video" || name === "coffee") return;
    clearOverlayTimer(name);
    if (!state.panels[name]) return;
    overlayTimers[name] = setTimeout(function () {
      state.panels[name] = false;
      syncChrome();
    }, OVERLAY_IDLE_MS);
  }

  function resetAllOverlaysBump() {
    ["nav", "ac", "scenic"].forEach(function (p) {
      if (state.panels[p]) bumpOverlay(p);
    });
  }

  function syncNavNumbers() {
    var speed = state.stopped ? 0 : state.speedKmh;
    if (state.remainKm <= 0.01) {
      state.remainKm = 90;
      state.totalKm = 100;
      state.waypoints = [];
      state.dest = "公司";
      speakOrToast("已到达目的地附近，导航重新开始演示路线");
    }
    state.remainMin = speed > 1 ? (state.remainKm / speed) * 60 : state.remainMin;
    var done = state.totalKm - state.remainKm;
    state.totalMin = Math.max(state.remainMin + done / Math.max(speed, 1) * 60, state.remainMin);
    var pct = Math.min(100, Math.max(0, (done / state.totalKm) * 100));
    var bm = $("navNextManeuverBig");
    if (bm) bm.textContent = state.remainKm > 99 ? ">99 km" : state.remainKm.toFixed(1) + " km";
    $("navRemainKm").textContent = state.remainKm.toFixed(1);
    $("navTotalKm").textContent = state.totalKm.toFixed(0);
    $("navRemainMin").textContent = Math.round(state.remainMin);
    $("navTotalMin").textContent = Math.round(state.totalMin);
    $("navProgress").style.width = pct + "%";
    var spEl = $("speedRingText") || $("speedReadout");
    if (spEl) spEl.textContent = String(Math.round(speed));
    renderWaypoints();
    renderNavPanel();
  }

  function renderWaypoints() {
    var ul = $("waypointList");
    if (!ul) return;
    ul.innerHTML = "";
    state.waypoints.forEach(function (w, i) {
      var li = document.createElement("li");
      li.textContent = i + 1 + ". " + w;
      ul.appendChild(li);
    });
  }

  function renderAcUi() {
    var root = $("acShell");
    if (!root) return;
    var ac = state.ac;
    var tDr = ac.temp;
    var tPa = ac.sync ? ac.temp : ac.passTemp;
    var drvEl = $("acTempDrv");
    var pasEl = $("acTempPas");
    if (drvEl) drvEl.textContent = String(tDr);
    if (pasEl) pasEl.textContent = String(tPa);
    root.classList.toggle("ac-shell--off", !ac.on);
    var zs = $("acZonePass");
    if (zs) zs.classList.toggle("ac-zone--linked", !!ac.sync);
    var syncBtn = $("acBtnSync");
    var compBtn = $("acBtnCompressor");
    var autoBtn = $("acBtnAuto");
    var powBtn = $("acBtnPower");
    if (syncBtn) syncBtn.classList.toggle("is-active", ac.sync);
    if (compBtn) compBtn.classList.toggle("is-active", ac.compressor);
    if (autoBtn) autoBtn.classList.toggle("is-active", ac.auto);
    if (powBtn) powBtn.classList.toggle("is-active", ac.on);
    var i;
    var leds = root.querySelectorAll(".ac-fan-led");
    for (i = 0; i < leds.length; i++) {
      leds[i].classList.toggle("is-on", i < ac.fan);
    }
    var fn = $("acFanNum");
    if (fn) fn.textContent = String(ac.fan);
    var windBtns = root.querySelectorAll("[data-ac-wind]");
    var wlen = windBtns.length;
    var w;
    for (w = 0; w < wlen; w++) {
      var b = windBtns[w];
      b.classList.toggle("is-active", b.getAttribute("data-ac-wind") === ac.wind);
    }
    var wr = $("acWindReadout");
    if (wr) wr.textContent = ac.wind;
  }

  function renderNavPanel() {
    var nd = $("navDest");
    if (nd) nd.textContent = state.dest;
    var inp = $("navSearchInput");
    if (inp && document.activeElement !== inp) inp.value = state.dest;
    var oe = $("navOvEcho");
    if (oe) oe.textContent = state.navSearch || "POI · 等待语音沿路搜";
    if ($("navOvDest")) $("navOvDest").textContent = state.dest;
    if ($("navOvTotalKm")) $("navOvTotalKm").textContent = state.totalKm.toFixed(0);
    if ($("navOvRemainKm"))
      $("navOvRemainKm").textContent = state.remainKm.toFixed(1);
    if ($("navOvRemainMin"))
      $("navOvRemainMin").textContent = String(Math.round(state.remainMin));
    if ($("navOvTotalMin"))
      $("navOvTotalMin").textContent = String(Math.round(state.totalMin));
    var banner = $("navOvBanner");
    var bannerTxt = $("navOvBannerTxt");
    var ratio =
      state.totalKm > 0.01 ? state.remainKm / state.totalKm : 1;
    var tight = ratio < 0.22 && state.remainKm > 2 && state.speedKmh > 5;
    if (banner && bannerTxt) {
      banner.classList.toggle("nav-route-banner--warn", tight);
      banner.classList.toggle("nav-route-banner--ok", !tight);
      bannerTxt.textContent = tight
        ? "仿真提示 · 电量与剩余里程偏紧，路线中插入充电备选（占位）"
        : "OpenStreetMap 数据 · Carto 浅色样式 · 绿色虚线为仿真能耗路线";
    }
    var ul = $("navOvWaypoints");
    if (ul) {
      ul.innerHTML = "";
      state.waypoints.forEach(function (w, i) {
        var li = document.createElement("li");
        var ix = document.createElement("span");
        ix.className = "nav-wp-idx";
        ix.textContent = String(i + 1);
        var nx = document.createElement("span");
        nx.className = "nav-wp-name";
        nx.textContent = w;
        li.appendChild(ix);
        li.appendChild(nx);
        ul.appendChild(li);
      });
      if (!state.waypoints.length) {
        var empty = document.createElement("li");
        empty.className = "nav-wp-empty";
        empty.textContent = "暂无；可订咖啡、读信息接人，或口述「顺路沿途搜加油站」";
        ul.appendChild(empty);
      }
    }
    if (state.panels.nav && window.CockpitNavMap) window.CockpitNavMap.sync(state);
    renderPoiPickSheet();
  }

  var POI_PICK_TIMEOUT_MS = 14000;

  function clearPoiPickSession() {
    if (state.poiPickSession && state.poiPickSession.timerId) {
      clearTimeout(state.poiPickSession.timerId);
    }
    state.poiPickSession = null;
  }

  function buildFakeAlongRouteChoices(queryRaw) {
    var q = (queryRaw || "").trim();
    if (q.indexOf("加油") !== -1 || q.indexOf("油站") !== -1) {
      return [
        {
          title: "壳牌 · 滨河大道合营站（演示）",
          sub: "偏离主路约 1.1 km · 顺路推荐指数高",
        },
        {
          title: "中石油 · 福田高铁枢纽（演示）",
          sub: "约 2.3 km · 便利店营业中",
        },
        {
          title: "民营 · 快充能量廊道（沿江匝道，演示）",
          sub: "卫生间开放 · 与充电位同区",
        },
      ];
    }
    if (
      q.indexOf("充电") !== -1 ||
      q.indexOf("快充") !== -1 ||
      q.indexOf("充电桩") !== -1
    ) {
      return [
        {
          title: "小桔超充 · 南山科技园 B 区（演示）",
          sub: "约偏离 800 m · 占位费低",
        },
        {
          title: "特斯拉目的地桩 · MixC（演示）",
          sub: "下地库后步行约 5 分钟",
        },
        {
          title: "国家电网 · 蛇口港（演示）",
          sub: "大功率 · 错峰优惠",
        },
      ];
    }
    if (q.indexOf("服务区") !== -1) {
      return [
        {
          title: "广深沿江 · 国际会展中心服务区（演示）",
          sub: "餐饮 · 加油 · 充电一体",
        },
        {
          title: "广深沿江 · 福永服务区（演示）",
          sub: "卫生间改造完成",
        },
        {
          title: "南光高速 · 李松蓢小型停靠（演示）",
          sub: "简餐 · 咖啡",
        },
      ];
    }
    if (
      q.indexOf("卫生间") !== -1 ||
      q.indexOf("厕所") !== -1 ||
      q.indexOf("洗手间") !== -1
    ) {
      return [
        {
          title: "蛇口邮轮中心公厕（演示）",
          sub: "距主路出口约 400 m",
        },
        {
          title: "深圳湾口岸联检楼（演示）",
          sub: "室内通道可用",
        },
        {
          title: "滨海休闲带驿站（演示）",
          sub: "夜间照明好",
        },
      ];
    }
    if (q.indexOf("商场") !== -1 || q.indexOf("购物") !== -1) {
      return [
        {
          title: "深圳湾万象城（演示）",
          sub: "与左侧消息接人示例地点一致",
        },
        {
          title: "卓悦中心（演示）",
          sub: "餐饮选择多",
        },
        {
          title: "海上世界（演示）",
          sub: "海景步行区",
        },
      ];
    }
    return [
      { title: "沿途兴趣点 A（「" + q + "」演示）", sub: "自动推荐 1" },
      { title: "沿途兴趣点 B（「" + q + "」演示）", sub: "自动推荐 2" },
      { title: "沿途兴趣点 C（「" + q + "」演示）", sub: "自动推荐 3" },
    ];
  }

  function poiPickAnnouncementLine(query, choices) {
    var parts = [];
    var i;
    for (i = 0; i < choices.length; i++) {
      var c = choices[i];
      parts.push(
        "第" +
          (i + 1) +
          "个，" +
          c.title +
          "。" +
          (c.sub ? c.sub + "。" : "")
      );
    }
    return (
      "沿途为您找到 " +
      choices.length +
      " 处「" +
      query +
      "」备选，请听完后用语音说第几个；约十四秒内无应答将默认第一项。" +
      parts.join("")
    );
  }

  function renderPoiPickSheet() {
    var sheet = $("navPoiPickSheet");
    var listEl = $("navPoiPickList");
    var titleEl = $("navPoiPickTitle");
    if (!sheet || !listEl) return;
    var sess = state.poiPickSession;
    if (!sess || !sess.choices || !sess.choices.length) {
      sheet.classList.add("hidden");
      listEl.innerHTML = "";
      return;
    }
    sheet.classList.remove("hidden");
    if (titleEl) titleEl.textContent = "沿路搜索 · 「" + (sess.query || "POI") + "」";
    listEl.innerHTML = "";
    var j;
    for (j = 0; j < sess.choices.length; j++) {
      var c = sess.choices[j];
      var li = document.createElement("li");
      li.className = "nav-poi-pick-item";
      li.setAttribute("data-poi-pick-index", String(j + 1));
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", "0");
      var t = document.createElement("strong");
      t.className = "nav-poi-pick-item-title";
      t.textContent = j + 1 + ". " + c.title;
      li.appendChild(t);
      var s = document.createElement("div");
      s.className = "nav-poi-pick-item-sub";
      s.textContent = c.sub || "";
      li.appendChild(s);
      listEl.appendChild(li);
    }
  }

  function startAlongRoutePoiFlow(query, serverReply) {
    clearPoiPickSession();
    state.panels.nav = true;
    var qDisp = (query || "").trim() || "沿途 POI";
    state.navSearch = qDisp;
    var choices = buildFakeAlongRouteChoices(qDisp);
    var speech = poiPickAnnouncementLine(qDisp, choices);
    if (serverReply && String(serverReply).trim()) {
      speech = String(serverReply).trim() + " " + speech;
    }
    state.poiPickSession = {
      query: qDisp,
      choices: choices,
      timerId: setTimeout(function () {
        finalizePoiChoice(1, true);
      }, POI_PICK_TIMEOUT_MS),
    };
    syncChrome();
    renderPoiPickSheet();
    speakOrToast(speech);
  }

  function finalizePoiChoice(oneBased, fromTimeout) {
    var sess = state.poiPickSession;
    if (!sess || !sess.choices || !sess.choices.length) return;
    if (sess.timerId) {
      clearTimeout(sess.timerId);
      sess.timerId = null;
    }
    var n = sess.choices.length;
    var i = parseInt(String(oneBased), 10);
    if (!isFinite(i) || i < 1) i = 1;
    if (i > n) i = n;
    var picked = sess.choices[i - 1];
    var title = picked && picked.title ? picked.title : "途经点";
    clearPoiPickSession();
    state.waypoints.push(title);
    state.remainKm += 5;
    renderPoiPickSheet();
    syncNavNumbers();
    if (fromTimeout) {
      speakOrToast(
        "未听到选择，已默认第一项「" + title + "」，已加入途经点。"
      );
    } else {
      speakOrToast("好的，已将「" + title + "」加入途经点。");
    }
  }

  function renderMessageCard() {
    var mc = $("messageCard");
    if (!mc) return;
    var last = state.messages.length ? state.messages[state.messages.length - 1] : null;
    var fromEl = $("msgCardFrom");
    var bodyEl = $("msgCardBody");
    var metaEl = $("msgCardMeta");
    var replyEl = $("msgCardLastReply");
    if (fromEl)
      fromEl.textContent = last ? "来自 " + last.from : "暂无消息";
    if (bodyEl) bodyEl.textContent = last ? last.body : "—";
    if (metaEl) metaEl.textContent = last && last.at ? last.at : "";
    if (replyEl) {
      if (state.msgLastReply) {
        replyEl.textContent =
          "上次代发 · 致 " +
          state.msgLastReply.to +
          "：" +
          state.msgLastReply.body;
        replyEl.classList.remove("hidden");
      } else {
        replyEl.textContent = "";
        replyEl.classList.add("hidden");
      }
    }
  }

  function syncMusicSidebarState() {
    var panel = $("musicPanel");
    var audio = $("cockpitMusic");
    if (!panel || !TRACKS.length) return;
    var meta = TRACKS[state.music.index] || TRACKS[0];
    var mt = $("musicTitle");
    var mart = $("musicArtist");
    var malb = $("musicAlbum");
    var lyric = $("musicLyric");
    if (mt) mt.textContent = meta.title;
    if (mart) mart.textContent = meta.artist;
    if (malb) malb.textContent = meta.album;
    var playing = !!(
      audio &&
      state.music.on &&
      audio.currentSrc &&
      !audio.paused &&
      !audio.ended
    );
    panel.classList.toggle("music-panel--idle", !state.music.on);
    panel.classList.toggle("music-panel--playing", playing);
    if (lyric) {
      if (playing)
        lyric.textContent =
          "♪ " + meta.title + " — " + meta.artist + "（演示音频）";
      else if (state.music.on)
        lyric.textContent = "（已暂停）· 可点击播放或说「听歌」继续";
      else
        lyric.textContent =
          "（演示流媒体 · 可说「听歌」或点播放）";
    }
  }

  function getVideoCatalog() {
    return window.COCKPIT_VIDEO_LIST && window.COCKPIT_VIDEO_LIST.length
      ? window.COCKPIT_VIDEO_LIST
      : [];
  }

  function formatVideoTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
    return pad(m) + ":" + pad(s);
  }

  function playVideoTrack(autoplay) {
    var list = getVideoCatalog();
    if (!list.length) {
      speakOrToast("暂无视频片源");
      return;
    }
    var el = $("cockpitVideo");
    if (!el) return;
    var ix = ((state.video.index % list.length) + list.length) % list.length;
    var meta = list[ix];
    el.volume = state.video.volume;
    el.src = meta.url;
    el.onloadedmetadata = function () {
      syncVideoPanel();
    };
    el.ontimeupdate = function () {
      if (!el.duration) return;
      var pct = (el.currentTime / el.duration) * 100;
      var peg = $("videoProgress");
      if (peg) peg.style.width = pct + "%";
      var tm = $("videoTime");
      if (tm)
        tm.textContent =
          formatVideoTime(el.currentTime) + " / " + formatVideoTime(el.duration);
    };
    el.onplay = function () {
      syncVideoPanel();
    };
    el.onpause = function () {
      syncVideoPanel();
    };
    el.onended = function () {
      syncVideoPanel();
    };
    syncVideoPanel();
    if (autoplay)
      el.play().catch(function () {
        speakOrToast("请点击页面允许视频播放");
      });
  }

  function renderVideoCatalogList() {
    var ul = $("videoCatalogList");
    if (!ul) return;
    var list = getVideoCatalog();
    ul.innerHTML = "";
    if (!list.length) return;
    var cur =
      ((state.video.index % list.length) + list.length) % list.length;
    var i;
    for (i = 0; i < list.length; i++) {
      var item = list[i];
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "video-modal__item" + (i === cur ? " is-current" : "");
      btn.setAttribute("data-video-index", String(i));
      var si = document.createElement("span");
      si.className = "video-modal__item-idx";
      si.textContent = String(i + 1);
      var st = document.createElement("span");
      st.className = "video-modal__item-txt";
      st.textContent = item.title || "视频";
      btn.appendChild(si);
      btn.appendChild(st);
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  function syncVideoPanel() {
    var list = getVideoCatalog();
    var el = $("cockpitVideo");
    var overlay = $("videoPlayOverlay");
    if (!el || !list.length) {
      if (overlay) overlay.classList.remove("video-modal__big-play--show");
      renderVideoCatalogList();
      return;
    }
    var ix = ((state.video.index % list.length) + list.length) % list.length;
    var meta = list[ix];
    var titleEl = $("videoTitleLine");
    if (titleEl) titleEl.textContent = meta.title || "视频";
    var playing = !!(
      state.panels.video &&
      el.currentSrc &&
      !el.paused &&
      !el.ended
    );
    var playBtn = $("btnVideoPlay");
    if (playBtn) playBtn.textContent = playing ? "暂停" : "播放";
    if (overlay) {
      overlay.classList.toggle(
        "video-modal__big-play--show",
        !!(!playing && state.panels.video)
      );
    }
    if (el.duration && isFinite(el.duration)) {
      var pct = (el.currentTime / el.duration) * 100;
      var peg = $("videoProgress");
      if (peg) peg.style.width = pct + "%";
      var tm = $("videoTime");
      if (tm)
        tm.textContent =
          formatVideoTime(el.currentTime) + " / " + formatVideoTime(el.duration);
    }
    renderVideoCatalogList();
  }

  function syncDmsStatusPill() {
    var el = $("dmsStatusPill");
    if (!el) return;
    var on = !!state.dms.enabled;
    el.classList.toggle("dms-status-pill--on", on);
    el.classList.toggle("dms-status-pill--off", !on);
    el.textContent = on ? "DMS · 开启" : "DMS · 关闭";
    el.setAttribute("aria-label", on ? "驾驶员监测已开启" : "驾驶员监测已关闭");
  }

  function syncChrome() {
    $("panelNav").classList.toggle("hidden", !state.panels.nav);
    $("panelAc").classList.toggle("hidden", !state.panels.ac);
    $("panelCoffee").classList.toggle("hidden", !state.panels.coffee);
    $("panelScenic").classList.toggle("hidden", !state.panels.scenic);
    if ($("panelVideo"))
      $("panelVideo").classList.toggle("hidden", !state.panels.video);
    syncDmsStatusPill();
    syncMusicSidebarState();
    syncVideoPanel();
    renderAcUi();
    renderCoffeeUi();
    renderMessageCard();
    syncNavNumbers();
  }

  function tick() {
    if (!state.stopped && state.speedKmh > 0 && state.remainKm > 0) {
      var kmPerSec = state.speedKmh / 3600;
      state.remainKm = Math.max(0, state.remainKm - kmPerSec / 10);
    }
    /** 超车横向摆动淡出略慢于约 100ms × (1/0.035)，换道体感更平缓 */
    if (state.overtakeAnim > 0) state.overtakeAnim -= 0.035;
    syncNavNumbers();
  }

  /**
   * 由 road-three 每帧调用：根据本车道前车间距调节车速（跟车 / 超车后恢复巡航）。
   * @param {number|null} gapMeters 与前保险杠估算间距，null 表示前方无同走廊车辆
   * @param {number} deltaSec 帧间隔秒
   */
  function applyAdaptiveCruise(gapMeters, deltaSec) {
    if (state.stopped || state.pullOver) return;
    var d = deltaSec;
    if (!(d > 0) || d > 0.12) d = 0.033;
    var cruise = state.targetCruiseKmh != null ? state.targetCruiseKmh : 80;
    cruise = Math.min(150, Math.max(0, cruise));
    var overtaking = (state.overtakeAnim || 0) > 0.08;
    var cap = cruise;
    if (gapMeters != null && isFinite(gapMeters)) {
      var g = gapMeters;
      if (g < 3.5) cap = Math.min(cap, 12);
      else if (g < 7) cap = Math.min(cap, 32);
      else if (!overtaking) {
        if (g < 12) cap = Math.min(cap, 44);
        else if (g < 20) cap = Math.min(cap, 52);
        else if (g < 28) cap = Math.min(cap, cruise * 0.62 + 10);
        else if (g < 38) cap = Math.min(cap, cruise * 0.72 + 8);
        else if (g < 50) cap = Math.min(cap, cruise * 0.82 + 7);
        else if (g < 58) cap = Math.min(cap, cruise * 0.9 + 5);
      } else if (g < 14) {
        cap = Math.min(cap, 68);
      }
    }
    var v = state.speedKmh;
    var rate;
    if (cap < v - 0.35) {
      rate =
        gapMeters != null && gapMeters < 45
          ? 6.4
          : gapMeters != null && gapMeters < 55
            ? 5.1
            : 4.2;
    } else {
      rate = gapMeters == null || gapMeters > 58 ? 2.4 : 3.0;
    }
    var alpha = 1 - Math.exp(-d * rate);
    state.speedKmh = v + (cap - v) * alpha;
    if (state.speedKmh < 0.15) state.speedKmh = 0;
  }

  var AUTO_OVERTAKE_COOLDOWN_MS = 6200;
  var lastAutoOvertakeWallMs = 0;

  /**
   * 自动变道超车（无前轮转向动画，仅占位变道与车道索引）。
   * @param {-1|1} side —左 -1 / 右 +1（与语音超车一致）
   * @returns {boolean}
   */
  function tryAutoOvertake(side) {
    side = side < 0 ? -1 : 1;
    if (!state.autoOvertakeEnabled) return false;
    if (state.stopped || state.pullOver) return false;
    if ((state.overtakeAnim || 0) > 0.12) return false;
    var now =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    if (now - lastAutoOvertakeWallMs < AUTO_OVERTAKE_COOLDOWN_MS) return false;
    if (side < 0) {
      if (state.lane <= 0) return false;
      state.lane -= 1;
    } else {
      if (state.lane >= 2) return false;
      state.lane += 1;
    }
    state.overtakeAnim = 1;
    state.overtakeSide = side < 0 ? -1 : 1;
    state.overtakeCmdLabel =
      side < 0 ? "自动超车 · 向左" : "自动超车 · 向右";
    lastAutoOvertakeWallMs = now;
    return true;
  }

  function tickClock() {
    var el = $("clockBar");
    if (!el) return;
    var d = new Date();
    el.textContent =
      d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) +
      " · " +
      (d.getMonth() + 1) +
      "月" +
      d.getDate() +
      "日";
  }

  function formatInboxSpeech() {
    if (!state.messages.length) return "目前收件箱里没有新消息。";
    var lines = [];
    var i;
    for (i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      lines.push(
        "第 " +
          (i + 1) +
          " 条信息来自 " +
          m.from +
          "。内容如下：" +
          m.body
      );
    }
    return lines.join(" ");
  }

  /** LLM 常把待发正文放在 response（如「已为你回复信息：我快到了」）而 params 为空，用于同步左侧「上次代发」 */
  function resolveOutboundReplyText(params, reply) {
    var raw =
      params &&
      (params.message_text != null && params.message_text !== ""
        ? params.message_text
        : params.text);
    var t = (raw != null ? String(raw) : "").trim();
    if (t) return t;
    var r = (reply || "").trim();
    if (!r) return "";
    var idx = r.lastIndexOf("\uff1a");
    if (idx === -1) idx = r.lastIndexOf(":");
    if (idx !== -1 && idx < r.length - 1) {
      var tail = r.slice(idx + 1).trim();
      if (tail) return tail;
    }
    return r;
  }

  function handleIntent(action, params, response, utteranceVo) {
    var reply = response || "";
    params = params || {};
    utteranceVo = utteranceVo != null ? String(utteranceVo).trim() : "";
    /** 风景倒计时 + 抓拍进行中：空闲计时延至收尾语音之后再 arm */
    var deferOverlayIdleBump = false;

    function confirm(msg) {
      speakOrToast(msg || reply);
    }

    switch (action) {
      /** lane 索引与 three 场景一致：0=最左侧车道、1=中间、2=最右侧（见 road-three laneIndexToX） */
      case "drive_overtake_left":
        if (state.lane <= 0) {
          break;
        }
        state.lane -= 1;
        state.overtakeAnim = 1;
        state.overtakeSide = -1;
        state.overtakeCmdLabel = "向左超车";
        confirm(reply || "好的，正在向左超车");
        break;
      case "drive_overtake_right":
        if (state.lane >= 2) {
          break;
        }
        state.lane += 1;
        state.overtakeAnim = 1;
        state.overtakeSide = 1;
        state.overtakeCmdLabel = "向右超车";
        confirm(reply || "好的，正在向右超车");
        break;
      case "drive_lane_center":
        state.lane = 1;
        state.overtakeAnim = 0;
        state.overtakeSide = 1;
        state.overtakeCmdLabel = "";
        confirm(reply || "好的，已回到中间车道");
        break;
      case "drive_speed_up":
        state.targetCruiseKmh = Math.min(150, (state.targetCruiseKmh || 80) + 10);
        state.speedKmh = Math.min(150, state.speedKmh + 10);
        confirm(reply);
        break;
      case "drive_slow_down":
        state.targetCruiseKmh = Math.max(0, (state.targetCruiseKmh || 80) - 10);
        state.speedKmh = Math.max(0, state.speedKmh - 10);
        confirm(reply);
        break;
      case "drive_pull_over":
        state.stopped = true;
        state.speedKmh = 0;
        state.pullOver = true;
        confirm(reply);
        break;
      case "drive_resume_route":
        state.stopped = false;
        state.targetCruiseKmh = 80;
        state.speedKmh = 80;
        state.pullOver = false;
        confirm(reply);
        break;
      case "nav_open":
        state.panels.nav = true;
        confirm(reply);
        break;
      case "nav_set_destination":
        state.dest = params.destination || state.dest;
        state.panels.nav = true;
        syncNavNumbers();
        confirm(reply);
        break;
      case "nav_search_poi":
        state.navSearch = params.query || "沿途 POI";
        state.panels.nav = true;
        confirm(reply);
        break;
      case "nav_along_route_poi_start":
        startAlongRoutePoiFlow(params.query, reply);
        break;
      case "nav_poi_candidate_pick": {
        if (!state.poiPickSession) {
          confirm(reply || "当前没有沿路选点会话，可先口述顺路沿途搜加油站。");
          break;
        }
        var ci =
          params.choice_index != null ? Number(params.choice_index) : NaN;
        finalizePoiChoice(ci, false);
        break;
      }
      case "nav_poi_candidate_cancel":
        clearPoiPickSession();
        renderPoiPickSheet();
        syncChrome();
        confirm(reply || "好的，已取消本次沿路选点。");
        break;
      case "nav_add_waypoint":
        state.waypoints.push(params.name || "途经点");
        state.remainKm += 5;
        state.panels.nav = true;
        syncNavNumbers();
        confirm(reply || "已添加途经点");
        break;
      case "nav_remove_last_waypoint":
        state.waypoints.pop();
        syncNavNumbers();
        confirm(reply);
        break;
      case "nav_close":
        clearPoiPickSession();
        renderPoiPickSheet();
        state.panels.nav = false;
        clearOverlayTimer("nav");
        if (window.CockpitNavMap && window.CockpitNavMap.resetSig) {
          window.CockpitNavMap.resetSig();
        }
        confirm(reply);
        break;
      case "msg_read_last": {
        var readout = reply && reply.trim() ? reply : formatInboxSpeech();
        confirm(readout);
        break;
      }
      case "msg_reply_send": {
        var toName =
          params.to ||
          (state.messages.length
            ? state.messages[state.messages.length - 1].from
            : "好友");
        var txt = resolveOutboundReplyText(params, reply);
        if (!txt.trim()) {
          confirm(reply || "要帮您回复什么呢？可以再说一下内容。");
          break;
        }
        state.msgLastReply = { to: toName, body: txt.trim(), at: Date.now() };
        confirm(
          reply || "好的，已发送给「" + toName + "」：" + txt.trim()
        );
        break;
      }
      case "ac_open":
        state.panels.ac = true;
        confirm(reply);
        break;
      case "ac_set_temperature":
        {
          var tv = params.temperature != null ? Number(params.temperature) : state.ac.temp;
          if (typeof tv !== "number" || isNaN(tv)) tv = state.ac.temp;
          state.ac.temp = Math.min(32, Math.max(16, Math.round(tv)));
          if (state.ac.sync) state.ac.passTemp = state.ac.temp;
        }
        state.panels.ac = true;
        confirm(reply || "好的");
        break;
      case "ac_adjust_fan":
        state.ac.fan = Math.min(5, Math.max(1, state.ac.fan + (params.delta || 1)));
        state.panels.ac = true;
        confirm(reply);
        break;
      case "ac_adjust_wind":
        {
          var aw = params.preset || state.ac.wind;
          if (aw === "脚底") aw = "吹脚";
          if (aw === "对面") aw = "吹脸";
          state.ac.wind = aw;
        }
        state.panels.ac = true;
        confirm(reply);
        break;
      case "ac_defog_front":
        state.ac.on = true;
        state.ac.compressor = true;
        state.ac.wind = "挡风玻璃";
        state.panels.ac = true;
        confirm(reply || "好的，已打开前挡除雾。");
        break;
      case "ac_comfort_stuffy":
        state.ac.on = true;
        state.ac.compressor = true;
        state.ac.fan = Math.min(5, Math.max(1, state.ac.fan + 1));
        state.panels.ac = true;
        confirm(reply || "好的，已帮您加强换气。");
        break;
      case "ac_close":
        state.panels.ac = false;
        clearOverlayTimer("ac");
        confirm(reply);
        break;
      case "music_open":
        state.music.on = true;
        state.panels.music = true;
        playTrack(true);
        confirm(reply);
        break;
      case "music_toggle": {
        var ma = $("cockpitMusic");
        if (!ma || !state.music.on) {
          state.music.on = true;
          state.panels.music = true;
          playTrack(true);
        } else if (ma.paused) ma.play().catch(function () {});
        else ma.pause();
        confirm(reply);
        break;
      }
      case "music_next":
        state.music.on = true;
        state.panels.music = true;
        state.music.index = (state.music.index + 1) % TRACKS.length;
        playTrack(true);
        confirm(reply);
        break;
      case "music_prev":
        state.music.on = true;
        state.panels.music = true;
        state.music.index =
          (state.music.index + TRACKS.length - 1) % TRACKS.length;
        playTrack(true);
        confirm(reply);
        break;
      case "music_volume_up":
        state.music.volume = Math.min(1, state.music.volume + 0.1);
        if ($("cockpitMusic")) $("cockpitMusic").volume = state.music.volume;
        confirm(reply);
        break;
      case "music_volume_down":
        state.music.volume = Math.max(0, state.music.volume - 0.1);
        if ($("cockpitMusic")) $("cockpitMusic").volume = state.music.volume;
        confirm(reply);
        break;
      case "music_stop_exit":
        state.music.on = false;
        state.panels.music = false;
        clearOverlayTimer("music");
        var am = $("cockpitMusic");
        if (am) am.pause();
        confirm(reply);
        break;
      case "video_open": {
        if (!getVideoCatalog().length) {
          confirm(reply || "暂无可用视频片源");
          break;
        }
        state.panels.video = true;
        var amus = $("cockpitMusic");
        if (amus) amus.pause();
        playVideoTrack(true);
        confirm(reply || "好的，为您打开视频播放");
        break;
      }
      case "video_close":
        state.panels.video = false;
        var vc = $("cockpitVideo");
        if (vc) vc.pause();
        confirm(reply || "好的，已关闭视频");
        break;
      case "video_toggle": {
        var listT = getVideoCatalog();
        if (!listT.length) break;
        if (!state.panels.video) {
          state.panels.video = true;
          var amx = $("cockpitMusic");
          if (amx) amx.pause();
          playVideoTrack(true);
          confirm(reply);
          break;
        }
        var ve = $("cockpitVideo");
        if (!ve) break;
        if (!ve.src) playVideoTrack(true);
        else if (ve.paused) ve.play().catch(function () {});
        else ve.pause();
        confirm(reply);
        break;
      }
      case "video_play":
      case "video_resume": {
        state.panels.video = true;
        var vp = $("cockpitVideo");
        if (vp && vp.src) vp.play().catch(function () {});
        else playVideoTrack(true);
        var amus2 = $("cockpitMusic");
        if (amus2) amus2.pause();
        confirm(reply);
        break;
      }
      case "video_pause": {
        var vpa = $("cockpitVideo");
        if (vpa) vpa.pause();
        confirm(reply);
        break;
      }
      case "video_next": {
        state.panels.video = true;
        var len = getVideoCatalog().length;
        if (!len) break;
        state.video.index = (state.video.index + 1) % len;
        var amn = $("cockpitMusic");
        if (amn) amn.pause();
        playVideoTrack(true);
        confirm(reply);
        break;
      }
      case "video_prev": {
        state.panels.video = true;
        var lenP = getVideoCatalog().length;
        if (!lenP) break;
        state.video.index =
          (state.video.index + lenP - 1) % lenP;
        var amp = $("cockpitMusic");
        if (amp) amp.pause();
        playVideoTrack(true);
        confirm(reply);
        break;
      }
      case "video_volume_up":
        state.video.volume = Math.min(1, state.video.volume + 0.1);
        if ($("cockpitVideo")) $("cockpitVideo").volume = state.video.volume;
        confirm(reply);
        break;
      case "video_volume_down":
        state.video.volume = Math.max(0, state.video.volume - 0.1);
        if ($("cockpitVideo")) $("cockpitVideo").volume = state.video.volume;
        confirm(reply);
        break;
      case "video_select": {
        var listS = getVideoCatalog();
        if (!listS.length) break;
        var ixParam =
          params.clip_index != null
            ? Number(params.clip_index)
            : params.index != null
              ? Number(params.index)
              : NaN;
        if (!isFinite(ixParam)) {
          break;
        }
        var nPick = Math.max(
          1,
          Math.min(listS.length, Math.floor(ixParam))
        );
        state.video.index = nPick - 1;
        state.panels.video = true;
        var ams = $("cockpitMusic");
        if (ams) ams.pause();
        playVideoTrack(true);
        confirm(reply || "好的");
        break;
      }
      case "coffee_open":
        state.panels.coffee = true;
        ensureCoffeeSuggestedShop();
        confirm(
          reply ||
            ("好的，已打开车内点单。页面上方可查看当前已选商品；若要加杯可以说名称，比方说生椰拿铁或橙 C 美式。还需要其他的吗？可以说再加一款，或者说去结账。可以试试" +
              coffeeMenuSpeechHint(5) +
              "。")
        );
        break;
      case "coffee_add_item": {
        state.panels.coffee = true;
        var deny =
          reply ||
            "抱歉，这款暂时不在今日的虚拟菜单里。要不要试试店里的" +
            coffeeMenuSpeechHint(4) +
            "？";
        if (params && params.invalid) {
          confirm(deny);
          break;
        }
        var sku = (params && params.sku && String(params.sku).trim()) || "";
        if (sku && !findCoffeeSku(sku)) sku = "";
        var drinkHint =
          params &&
          (params.drink ||
            params.name ||
            params.item_name ||
            params.product_name ||
            params.item);
        drinkHint =
          drinkHint != null ? String(drinkHint).trim() : "";
        if (!sku) {
          sku = resolveCoffeeSkuFromSpeech(drinkHint, params && params.sku);
        }
        if (!sku && utteranceVo) {
          sku = resolveCoffeeSkuFromSpeech(utteranceVo, params && params.sku);
        }
        var pq =
          params &&
          params.qty != null &&
          !isNaN(Number(params.qty)) &&
          Number(params.qty) >= 1
            ? Math.min(9, Math.floor(Number(params.qty)))
            : 1;

        if (!sku) {
          confirm(deny);
          break;
        }
        addCoffeeSku(sku, pq);
        ensureCoffeeSuggestedShop();
        var it = findCoffeeSku(sku);
        var nm = it ? it.name : "饮品";
        confirm(
          reply ||
            "好的，已为你要了" +
              nm +
              (pq > 1 ? "，共「" + pq + "」杯" : "") +
              "，已加入购物车。还需要别的饮品吗？说「再来一杯 xxx」或直接说没有的我就帮你弹出付款码。"
        );
        break;
      }
      case "coffee_confirm_pay": {
        state.panels.coffee = true;
        var qc = 0;
        state.coffee.cart.forEach(function (ln) {
          qc += ln.qty || 0;
        });
        if (qc < 1) {
          confirm(
            reply ||
              "购物车还是空的哦，先说一下想喝哪款咖啡，或者说「来一个生椰拿铁」也可以。"
          );
          break;
        }
        if (state.coffee.qr) {
          confirm(
            reply ||
              "虚拟收款码已经展开啦，请先在手机上完成仿真扫码，几秒后会自动入账。"
          );
          break;
        }
        var destLbl = state.dest || "目的地";
        var shopPick =
          state.coffee.suggestedShop || pickAlongRouteCoffeeShopDemo(destLbl);
        state.coffee.lastShop = shopPick;
        state.coffee.pendingCheckoutShop = shopPick;
        if (shopPick && state.waypoints.indexOf(shopPick) === -1) {
          state.waypoints.push(shopPick);
        }
        state.coffee.qr = true;
        clearOverlayTimer("coffee");
        syncNavNumbers();

        confirm(
          reply ||
            "好的，「" +
              shopPick +
              "」已写入导航途经点。请抬头看屏幕上的收款码，用手机完成虚拟扫码；约几秒后会提示支付完成，再稍后自动收起点单。"
        );

        setTimeout(function () {
          state.coffee.qr = false;
          state.coffee.cart = [];
          state.coffee.suggestedShop = null;
          var wp = state.coffee.pendingCheckoutShop || shopPick;
          state.coffee.pendingCheckoutShop = null;
          if (wp && state.waypoints.indexOf(wp) === -1) {
            state.waypoints.push(wp);
          }
          state.remainKm += 3;
          syncNavNumbers();
          syncChrome();
          speakOrToast(
            "支付已完成仿真。顺路取餐点「" +
              wp +
              "」已在导航途经点中。到达附近后不妨顺路取餐。" +
              "约五秒后收起点单界面。"
          );
          resetAllOverlaysBump();
          clearOverlayTimer("coffee");
          overlayTimers.coffee = setTimeout(function () {
            overlayTimers.coffee = null;
            state.panels.coffee = false;
            syncChrome();
          }, COFFEE_POST_PAY_CLOSE_MS);
        }, 5200);

        break;
      }
      case "coffee_close":
        if (state.coffee.cart.length > 0) {
          handleIntent(
            "coffee_confirm_pay",
            {},
            reply ||
              "购物车里还有饮品，为您打开收款码，并把顺路咖啡店加入导航途经点。"
          );
          break;
        }
        state.panels.coffee = false;
        state.coffee.suggestedShop = null;
        clearOverlayTimer("coffee");
        confirm(reply);
        break;
      case "scenic_open":
        state.panels.scenic = true;
        refreshScenicExteriorPreview(true);
        confirm(reply);
        break;
      case "scenic_take_photo":
        state.panels.scenic = true;
        ensureScenicExteriorVisible();
        if (state.scenic.shooting) {
          confirm(reply || "正在倒计时，请稍后");
          break;
        }
        deferOverlayIdleBump = true;
        runScenicSequence();
        confirm(reply || "准备拍照");
        break;
      case "scenic_close":
        state.panels.scenic = false;
        clearOverlayTimer("scenic");
        confirm(reply);
        break;
      case "dms_enable":
        state.dms.enabled = true;
        syncDmsToFatigueModule();
        confirm(reply || "好的，已打开驾驶员监测。");
        break;
      case "dms_disable":
        state.dms.enabled = false;
        syncDmsToFatigueModule();
        confirm(reply || "好的，已关闭驾驶员监测。");
        break;
      default:
        if (action === "none") return;
        if (reply) confirm(reply);
    }
    syncChrome();
    if (action !== "none" && !deferOverlayIdleBump) resetAllOverlaysBump();
  }

  function scenicExteriorSeedUrl(seed) {
    var list = SCENIC_EXTERIOR_URLS;
    if (!list.length) {
      return "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&w=960&h=540&q=80";
    }
    var n = list.length;
    var i = ((Number(seed) || 0) % n + n) % n;
    return list[i];
  }

  /** 车外虚拟取景图：打卡打开时换新图；抓拍前若无图则补足 */
  function refreshScenicExteriorPreview(forceNewSeed) {
    var img = $("scenicExteriorPreview");
    if (!img) return;
    if (forceNewSeed || !state.scenic.exteriorSeed) {
      state.scenic.exteriorSeed = (state.scenic.exteriorSeed || 1) + 1;
      if (state.scenic.exteriorSeed > 1e9) state.scenic.exteriorSeed = 1;
    }
    img.crossOrigin = "anonymous";
    img.alt = "车外虚拟取景";
    img.classList.remove("scenic-img--error");
    img.classList.add("scenic-exterior-loading");
    img.onload = function () {
      img.classList.remove("scenic-exterior-loading");
    };
    img.onerror = function () {
      img.classList.remove("scenic-exterior-loading");
      img.classList.add("scenic-img--error");
      img.alt = "";
    };
    img.src = scenicExteriorSeedUrl(state.scenic.exteriorSeed);
  }

  function ensureScenicExteriorVisible() {
    refreshScenicExteriorPreview(false);
  }

  function playTrack(autoplay) {
    var a = $("cockpitMusic");
    if (!a) return;
    if (state.panels.video) {
      var vx = $("cockpitVideo");
      if (vx) vx.pause();
    }
    var t = TRACKS[state.music.index];
    a.src = t.url;
    a.volume = state.music.volume;
    a.onplaying = function () {
      syncMusicSidebarState();
    };
    a.onpause = function () {
      syncMusicSidebarState();
    };
    a.onended = function () {
      syncMusicSidebarState();
    };
    a.ontimeupdate = function () {
      if (!a.duration) return;
      var pct = (a.currentTime / a.duration) * 100;
      var peg = $("musicProgress");
      if (peg) peg.style.width = pct + "%";
    };
    syncMusicSidebarState();
    if (autoplay)
      a.play().catch(function () {
        speakOrToast("请点击页面允许音频播放");
      });
  }

  function runScenicSequence() {
    state.scenic.shooting = true;
    var count = 3;
    var overlay = $("scenicCountdown");
    var vid = $("camPreview");
    function step() {
      if (count > 0) {
        overlay.textContent = count;
        overlay.classList.remove("hidden");
        speakOrToast(count + "");
        count--;
        setTimeout(step, 900);
      } else {
        overlay.textContent = "咔嚓";
        try {
          var beep = new Audio(
            "data:audio/wav;base64,UklGRlQAAABXQVZFZm10IBAAAAABAAEAQB8AAIB8AAACABAAZGF0YRQAAACAgICAgPEBAP//w=="
          );
          beep.volume = 0.3;
          beep.play().catch(function () {});
        } catch (e) {}
        setTimeout(function () {
          overlay.classList.add("hidden");
          composeScenic(vid);
          state.scenic.shooting = false;
          syncChrome();
          speakOrToast("哇，拍的照片真美呆了！");
          resetAllOverlaysBump();
        }, 700);
      }
    }
    step();
  }

  function composeScenic(videoEl) {
    var c = $("composeCanvas");
    if (!c) return;
    var prev = $("composePreview");
    var ctx = c.getContext("2d");
    c.width = 880;
    c.height = 420;

    function finishPreview() {
      state.scenic.compositeDataUrl = c.toDataURL("image/jpeg", 0.85);
      if (prev) {
        prev.src = state.scenic.compositeDataUrl;
        prev.classList.remove("hidden");
      }
    }

    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, c.width, c.height);
    try {
      ctx.drawImage(videoEl, 0, 0, c.width / 2, c.height);
    } catch (e) {
      ctx.fillStyle = "#374151";
      ctx.fillRect(0, 0, c.width / 2, c.height);
      ctx.fillStyle = "#fff";
      ctx.font = '16px "Segoe UI", sans-serif';
      ctx.fillText("车内摄像头不可用", 40, 200);
    }

    function drawOutsideFromDom(done) {
      var extImg = $("scenicExteriorPreview");
      if (
        extImg &&
        extImg.complete &&
        extImg.naturalWidth > 8 &&
        !extImg.classList.contains("scenic-img--error")
      ) {
        try {
          ctx.drawImage(extImg, c.width / 2, 0, c.width / 2, c.height);
          done();
          return;
        } catch (e) {}
      }
      var fb = new Image();
      fb.crossOrigin = "anonymous";
      fb.onload = function () {
        try {
          ctx.drawImage(fb, c.width / 2, 0, c.width / 2, c.height);
        } catch (e2) {
          fallbackGreen();
        }
        done();
      };
      fb.onerror = function () {
        fallbackGreen();
        done();
      };
      fb.src = scenicExteriorSeedUrl(state.scenic.exteriorSeed || 928173);
      function fallbackGreen() {
        ctx.fillStyle = "#065f46";
        ctx.fillRect(c.width / 2, 0, c.width / 2, c.height);
        ctx.fillStyle = "#d1fae5";
        ctx.font = '16px "Segoe UI", sans-serif';
        ctx.fillText("车外虚拟风景", c.width / 2 + 40, 200);
      }
    }

    drawOutsideFromDom(finishPreview);
  }

  function getVoiceContext() {
    var lastMsg =
      state.messages.length > 0
        ? state.messages[state.messages.length - 1]
        : null;
    var pickup =
      lastMsg && lastMsg.place_hint ? String(lastMsg.place_hint) : "";
    var coffeeCartQty = 0;
    state.coffee.cart.forEach(function (ln) {
      coffeeCartQty += ln.qty || 0;
    });
    var coffeeLines = state.coffee.cart.map(function (ln) {
      return {
        name: ln.name,
        qty: ln.qty || 1,
        price_each: ln.price,
      };
    });

    var coffeeFlat = [];
    var ci, cj;
    for (ci = 0; ci < COFFEE_MENU.length; ci++) {
      for (cj = 0; cj < COFFEE_MENU[ci].items.length; cj++) {
        var cit = COFFEE_MENU[ci].items[cj];
        coffeeFlat.push({ sku: cit.sku, name: cit.name, price: cit.price });
      }
    }

    return {
      destination: state.dest,
      remain_km: state.remainKm,
      speed: state.speedKmh,
      target_cruise_kmh: state.targetCruiseKmh,
      /** 仿真车道：0 最左、1 中间、2 最右；超车指令按单次 relative 规则处理 */
      lane_index: state.lane,
      lane_position: ["left", "middle", "right"][state.lane] || "middle",
      /** 座舱 ADAS：是否允许前车受阻时自动选道超车（仅仿真） */
      auto_overtake_enabled: !!state.autoOvertakeEnabled,
      overlay_nav: state.panels.nav,
      overlay_ac: state.panels.ac,
      ac_driver_temp_set: state.ac.temp,
      ac_pass_temp_set: state.ac.passTemp,
      ac_power_on: state.ac.on,
      ac_fan_level: state.ac.fan,
      ac_wind_mode: state.ac.wind,
      ac_compressor_on: state.ac.compressor,
      overlay_music: state.music.on,
      overlay_coffee: state.panels.coffee,
      overlay_scenic: state.panels.scenic,
      overlay_video: state.panels.video,
      dms_enabled: state.dms.enabled,
      video_now_index: state.video.index + 1,
      video_catalog_titles: getVideoCatalog().map(function (x, i) {
        return { index: i + 1, title: x.title };
      }),
      waypoints: state.waypoints.slice(),
      /** 供 LLM 做指代消解：「短信里那个接人点」 */
      messages: state.messages.map(function (m) {
        return {
          from: m.from,
          body: m.body,
          place_hint: m.place_hint || "",
        };
      }),
      last_pickup_place: pickup,
      poi_pick_active: !!state.poiPickSession,
      poi_pick_choices:
        state.poiPickSession && state.poiPickSession.choices
          ? state.poiPickSession.choices.map(function (x) {
              return x.title;
            })
          : [],
      /** 车载咖啡菜单与购物车 — 仅供大模型点单对齐 */
      coffee_menu: coffeeFlat,
      coffee_menu_names_hint: coffeeMenuSpeechHint(8),
      coffee_cart_lines_preview: coffeeLines,
      coffee_cart_item_count: coffeeCartQty,
      coffee_cart_nonempty: coffeeCartQty > 0,
      coffee_waiting_qr: !!state.coffee.qr,
      coffee_suggested_shop: state.coffee.suggestedShop || "",
    };
  }

  function syncDmsToFatigueModule() {
    if (typeof window.__cockpitSetDmsEnabled === "function") {
      window.__cockpitSetDmsEnabled(state.dms.enabled);
    }
  }

  function setupCam() {
    var vid = $("camPreview");
    var dmsVid = $("dmsCam");
    if (!navigator.mediaDevices || !vid) return;
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then(function (stream) {
        vid.srcObject = stream;
        vid.play().catch(function () {});
        if (dmsVid) {
          dmsVid.srcObject = stream;
          dmsVid.play().catch(function () {});
        }
        /** 与同一条摄像头链路共享，避免第二轮 getUserMedia 在多数浏览器上失败导致 DMS 完全不工作 */
        if (typeof window.__cockpitStartFatigueDms === "function") {
          window.__cockpitStartFatigueDms();
        }
      })
      .catch(function () {
        $("camHint").textContent = "未能打开摄像头 — 仍可体验虚拟车外风景拼接";
        if (typeof window.__cockpitStartFatigueDms === "function") {
          window.__cockpitStartFatigueDms();
        }
      });
  }

  function bindAcPanel() {
    var shell = $("acShell");
    if (!shell) return;
    shell.addEventListener("click", function (e) {
      var tgt = /** @type {HTMLElement} */ (e.target);

      function acRefresh() {
        state.panels.ac = true;
        bumpOverlay("ac");
        syncChrome();
      }

      var tempStep = tgt.closest("[data-ac-temp]");
      if (tempStep) {
        var zone = tempStep.getAttribute("data-ac-temp");
        var delta = parseInt(tempStep.getAttribute("data-ac-delta"), 10) || 0;
        if (zone === "drv") {
          state.ac.temp = Math.min(32, Math.max(16, state.ac.temp + delta));
          if (state.ac.sync) state.ac.passTemp = state.ac.temp;
        } else if (zone === "pas") {
          if (state.ac.sync) {
            state.ac.temp = Math.min(32, Math.max(16, state.ac.temp + delta));
            state.ac.passTemp = state.ac.temp;
          } else {
            state.ac.passTemp = Math.min(32, Math.max(16, state.ac.passTemp + delta));
          }
        }
        acRefresh();
        return;
      }

      var fanDeltaEl = tgt.closest("[data-ac-fan-delta]");
      if (fanDeltaEl) {
        var fd = parseInt(fanDeltaEl.getAttribute("data-ac-fan-delta"), 10) || 0;
        state.ac.fan = Math.min(5, Math.max(1, state.ac.fan + fd));
        acRefresh();
        return;
      }

      var fanSetEl = tgt.closest("[data-ac-fan-set]");
      if (fanSetEl) {
        var fs = parseInt(fanSetEl.getAttribute("data-ac-fan-set"), 10) || 1;
        state.ac.fan = Math.min(5, Math.max(1, fs));
        acRefresh();
        return;
      }

      var windEl = tgt.closest("[data-ac-wind]");
      if (windEl) {
        state.ac.wind = windEl.getAttribute("data-ac-wind") || state.ac.wind;
        acRefresh();
        return;
      }

      if (tgt.closest("#acBtnSync")) {
        state.ac.sync = !state.ac.sync;
        if (state.ac.sync) state.ac.passTemp = state.ac.temp;
        acRefresh();
        return;
      }
      if (tgt.closest("#acBtnCompressor")) {
        state.ac.compressor = !state.ac.compressor;
        acRefresh();
        return;
      }
      if (tgt.closest("#acBtnAuto")) {
        state.ac.auto = !state.ac.auto;
        acRefresh();
        return;
      }
      if (tgt.closest("#acBtnPower")) {
        state.ac.on = !state.ac.on;
        acRefresh();
      }
    });
  }

  function bindNavOverlay() {
    var inp = $("navSearchInput");
    if (inp) {
      inp.addEventListener("change", function () {
        var v = inp.value.trim();
        if (!v) return;
        handleIntent("nav_set_destination", { destination: v }, "");
      });
      inp.addEventListener("keydown", function (e) {
        var ke = /** @type {KeyboardEvent} */ (e);
        if (ke.key === "Enter") inp.blur();
      });
    }
    var qBtns = document.querySelectorAll("[data-nav-quick]");
    var qb;
    for (qb = 0; qb < qBtns.length; qb++) {
      qBtns[qb].addEventListener(
        "click",
        (function (el) {
          return function () {
            handleIntent(
              "nav_set_destination",
              { destination: el.getAttribute("data-nav-quick") || state.dest },
              ""
            );
          };
        })(qBtns[qb])
      );
    }
    $("btnNavPrefer") &&
      $("btnNavPrefer").addEventListener("click", function () {
        speakOrToast(
          "路线偏好：演示版默认智能避让拥堵；省电 / 少收费模式可后续接入。"
        );
      });
    if ($("btnNavFabVol")) {
      $("btnNavFabVol").addEventListener("click", function () {
        speakOrToast("导航播报音量已与系统媒体对齐（示意）。");
      });
    }
    if ($("btnNavFabNorth")) {
      $("btnNavFabNorth").addEventListener("click", function () {
        if (window.CockpitNavMap && window.CockpitNavMap.fitRoute)
          window.CockpitNavMap.fitRoute();
        speakOrToast("已复位路线视野（车头朝向示意）。");
      });
    }
    if ($("btnNavFabSet")) {
      $("btnNavFabSet").addEventListener("click", function () {
        speakOrToast("导航设置面板为占位演示。");
      });
    }

    var pickList = $("navPoiPickList");
    if (pickList) {
      pickList.addEventListener("click", function (e) {
        var li = /** @type {HTMLElement} */ (e.target).closest(".nav-poi-pick-item");
        if (!li) return;
        var ix = parseInt(li.getAttribute("data-poi-pick-index") || "", 10);
        if (!isFinite(ix)) return;
        finalizePoiChoice(ix, false);
      });
    }
    $("btnNavPoiPickCancel") &&
      $("btnNavPoiPickCancel").addEventListener("click", function () {
        handleIntent("nav_poi_candidate_cancel", {}, "");
      });

    $("btnNavStartDemo") &&
      $("btnNavStartDemo").addEventListener("click", function () {
        speakOrToast("已开始仿真导航，抬头显示与途经点照常联动。");
        handleIntent("nav_close", {}, "");
      });
  }

  function bindVideoPanel() {
    var c = $("cockpitVideo");
    var track = document.querySelector(".video-modal__track");
    var ov = $("videoPlayOverlay");
    if (c) {
      c.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!state.panels.video) return;
        handleIntent("video_toggle", {}, "");
      });
    }
    if (ov) {
      ov.addEventListener("click", function (e) {
        e.stopPropagation();
        handleIntent("video_toggle", {}, "");
      });
    }
    if (track) {
      track.addEventListener("click", function (e) {
        var el = $("cockpitVideo");
        if (!el || !el.duration || !state.panels.video) return;
        var rect = track.getBoundingClientRect();
        var x = e.clientX - rect.left;
        el.currentTime = Math.max(0, Math.min(1, x / rect.width)) * el.duration;
      });
    }
    $("btnVideoClose") &&
      $("btnVideoClose").addEventListener("click", function () {
        handleIntent("video_close", {}, "");
      });
    $("btnVideoPrev") &&
      $("btnVideoPrev").addEventListener("click", function () {
        handleIntent("video_prev", {}, "上一个");
      });
    $("btnVideoNext") &&
      $("btnVideoNext").addEventListener("click", function () {
        handleIntent("video_next", {}, "下一个");
      });
    $("btnVideoPlay") &&
      $("btnVideoPlay").addEventListener("click", function () {
        handleIntent("video_toggle", {}, "");
      });
    $("btnVideoVolDown") &&
      $("btnVideoVolDown").addEventListener("click", function () {
        handleIntent("video_volume_down", {}, "");
      });
    $("btnVideoVolUp") &&
      $("btnVideoVolUp").addEventListener("click", function () {
        handleIntent("video_volume_up", {}, "");
      });
    var vList = $("videoCatalogList");
    if (vList) {
      vList.addEventListener("click", function (e) {
        var btn = /** @type {HTMLElement} */ (e.target).closest(
          "[data-video-index]"
        );
        if (!btn) return;
        var idx = parseInt(btn.getAttribute("data-video-index") || "", 10);
        if (!isFinite(idx)) return;
        var cat = getVideoCatalog();
        if (!cat.length) return;
        var cur =
          ((state.video.index % cat.length) + cat.length) % cat.length;
        if (idx === cur) handleIntent("video_toggle", {}, "");
        else handleIntent("video_select", { clip_index: idx + 1 }, "");
      });
    }
  }

  function bindUi() {
    bindNavOverlay();
    $("btnMsgDemoSend") &&
      $("btnMsgDemoSend").addEventListener("click", function () {
        handleIntent(
          "msg_reply_send",
          {
            message_text: "好的，我大约二十分钟后到，到了给你发消息。",
          },
          ""
        );
      });
    $("btnMsgDemoChange") &&
      $("btnMsgDemoChange").addEventListener("click", function () {
        speakOrToast("可直接口述：回复阿杰，说……");
      });
    $("btnNavClose") &&
      $("btnNavClose").addEventListener("click", function () {
        handleIntent("nav_close", {}, "");
      });
    $("btnAcClose") &&
      $("btnAcClose").addEventListener("click", function () {
        handleIntent("ac_close", {}, "");
      });
    $("btnCoffeeClose") &&
      $("btnCoffeeClose").addEventListener("click", function () {
        handleIntent("coffee_close", {}, "");
      });
    var coffeeModal = document.querySelector(".coffee-modal");
    if (coffeeModal) {
      coffeeModal.addEventListener("click", function (e) {
        var tab = e.target.closest("[data-coffee-tab]");
        if (tab) {
          state.coffeeUi.tab =
            parseInt(tab.getAttribute("data-coffee-tab"), 10) || 0;
          var tabs = coffeeModal.querySelectorAll(".coffee-tab");
          var ti;
          for (ti = 0; ti < tabs.length; ti++) {
            tabs[ti].classList.toggle(
              "is-active",
              tabs[ti].getAttribute("data-coffee-tab") ===
                String(state.coffeeUi.tab)
            );
          }
          state.coffeeUi.catIdx = 0;
          syncChrome();
          return;
        }
        var cbtn = e.target.closest("[data-cat-idx]");
        if (cbtn) {
          state.coffeeUi.catIdx =
            parseInt(cbtn.getAttribute("data-cat-idx"), 10) || 0;
          syncChrome();
          return;
        }
        var addBtn = e.target.closest("[data-add-sku]");
        if (addBtn) {
          addCoffeeSku(addBtn.getAttribute("data-add-sku"));
          speakOrToast("已加入购物车");
          return;
        }
      });
    }
    $("btnCoffeeCheckout") &&
      $("btnCoffeeCheckout").addEventListener("click", function () {
        if (state.coffee.cart.length === 0) {
          speakOrToast("请先添加饮品");
          return;
        }
        handleIntent("coffee_confirm_pay", {}, "");
      });
    $("btnMusicExit") &&
      $("btnMusicExit").addEventListener("click", function () {
        handleIntent("music_stop_exit", {}, "");
      });
    $("btnMusicPrev") &&
      $("btnMusicPrev").addEventListener("click", function () {
        handleIntent("music_prev", {}, "上一首");
      });
    $("btnMusicNext") &&
      $("btnMusicNext").addEventListener("click", function () {
        handleIntent("music_next", {}, "下一首");
      });
    $("btnMusicPlay") &&
      $("btnMusicPlay").addEventListener("click", function () {
        handleIntent("music_toggle", {}, "");
      });
    $("volDown") &&
      $("volDown").addEventListener("click", function () {
        handleIntent("music_volume_down", {}, "");
      });
    $("volUp") &&
      $("volUp").addEventListener("click", function () {
        handleIntent("music_volume_up", {}, "");
      });
    bindVideoPanel();
  }

  window.Cockpit = {
    state: state,
    handleIntent: handleIntent,
    getVoiceContext: getVoiceContext,
    applyAdaptiveCruise: applyAdaptiveCruise,
    tryAutoOvertake: tryAutoOvertake,
  };
  window.TRACKS = TRACKS;

  document.addEventListener("DOMContentLoaded", function () {
    syncDmsToFatigueModule();
    syncChrome();
    setupCam();
    bindAcPanel();
    bindUi();
    tickClock();
    setInterval(tickClock, 1000);
    tickHandle = setInterval(tick, 100);
    if (window.CockpitRoad3D && window.CockpitRoad3D.resize)
      window.CockpitRoad3D.resize();
  });
})();
