/* =========================================================
 * ui.js — DOM 构建、状态展示、日志、提示、弹窗、统计导出
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const C = SB.CONFIG;
  const U = SB.U;

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const MODE = {
    ready: { badge: '就绪', run: '系统就绪', canvas: '系统就绪', header: '系统就绪', cls: 'ready' },
    moving: { badge: '运动中', run: '机械臂运动中', canvas: '机械臂运动中', header: '运动执行中', cls: 'moving' },
    spraying: { badge: '喷涂中', run: '自动喷涂作业中', canvas: '喷涂作业中', header: '喷涂作业中', cls: 'spraying' },
    playback: { badge: '回放中', run: '示教轨迹回放', canvas: '轨迹回放中', header: '轨迹回放中', cls: 'moving' },
    fault: { badge: '故障', run: '碰撞保护已触发', canvas: '碰撞保护停机', header: '设备故障', cls: 'fault' },
    estop: { badge: '急停', run: '急停锁定', canvas: '急停锁定', header: '急停锁定', cls: 'estop' }
  };

  const UI = SB.UI = {
    jointSliders: [],
    poseButtons: [],
    paramEls: {},
    locked: false,
    currentStats: null,
    inventoryData: null,
    invFilter: 'all',
    _sprayOn: false,

    el: $,
    qsa: $$,

    init() {
      this.buildJoints();
      this.buildPoses();
      this.buildLibrary();
      this.buildParams();
      this.buildTemplates();
      this.buildLayers();
      this.buildTelemetry();
      this.buildInventory();
      this.bindTabs();
      this.bindModals();
      this.bindHeader();
      this.setMobileView('motion');
      if (U.isLandscape()) this.setMobileView('none');
      this._landscape = U.isLandscape();
      window.addEventListener('resize', () => {
        const land = U.isLandscape();
        if (land === this._landscape) return;
        this._landscape = land;
        this.setMobileView(land ? 'none' : 'motion');
      });
      this.syncParamFill();
    },

    on(id, event, handler) {
      const el = $(id);
      if (el) el.addEventListener(event, handler);
      return el;
    },

    buildJoints() {
      const list = $('jointList');
      if (!list) return;
      this.jointSliders = [];
      const frag = document.createDocumentFragment();
      C.robot.joints.forEach((j, i) => {
        const row = document.createElement('div');
        row.className = 'joint-row';
        row.innerHTML =
          '<span class="joint-label">' + j.name + '</span>' +
          '<input type="range" class="joint-slider" data-joint="' + i + '" min="' + j.min + '" max="' + j.max +
          '" step="0.5" value="0" aria-label="' + j.name + ' ' + j.label + '">' +
          '<span class="joint-value" data-joint-val="' + i + '">0.0°</span>';
        frag.appendChild(row);
        this.jointSliders.push(row.querySelector('input'));
      });
      list.appendChild(frag);
      this.jointSliders.forEach((input) => {
        input.addEventListener('input', () => {
          this.updateSliderFill(input);
          const out = document.querySelector('[data-joint-val="' + input.dataset.joint + '"]');
          if (out) out.textContent = Number(input.value).toFixed(1) + '°';
        });
        this.updateSliderFill(input);
      });
    },

    buildPoses() {
      const grid = $('poseGrid');
      if (!grid) return;
      this.poseButtons = [];
      C.poses.forEach((p) => {
        const b = document.createElement('button');
        b.className = 'pose-btn';
        b.dataset.pose = p.id;
        b.innerHTML = '<b>' + p.name + '</b><span>' + p.desc + '</span>';
        grid.appendChild(b);
        this.poseButtons.push(b);
      });
      $$('.pose-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.markPose(btn.dataset.pose));
      });
    },
    buildLibrary() {
      const tabs = $('catTabs');
      const list = $('coatingList');
      if (!tabs || !list) return;
      tabs.innerHTML = C.categories.map((c) =>
        '<button class="cat-tab" data-cat="' + c.id + '" role="tab">' + U.escapeHTML(c.short) + '</button>'
      ).join('');
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cat]');
        if (!btn) return;
        const cat = btn.dataset.cat;
        this.setCategory(cat);
        const app = SB.App;
        const cur = app && C.materials[app.materialId];
        if (app && (!cur || cur.category !== cat)) {
          const first = C.coatings.filter((c) => c.category === cat)[0];
          if (first) app.onMaterial(first.id);
        }
      });
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-coating]');
        if (btn && SB.App) SB.App.onMaterial(btn.dataset.coating);
      });
      const card = $('takeCard');
      if (card) {
        card.addEventListener('click', (e) => {
          if (!SB.App) return;
          if (e.target.closest('#takeApply')) SB.App.applyDefaults();
          else if (e.target.closest('#takeNozzle')) SB.App.setNozzleView(true);
        });
      }
      this.currentCategory = 'decor';
      this.setCategory('decor');
    },

    setCategory(catId) {
      this.currentCategory = catId;
      $$('.cat-tab').forEach((b) => b.classList.toggle('active', b.dataset.cat === catId));
      const list = $('coatingList');
      if (!list) return;
      const activeId = SB.App ? SB.App.materialId : 'putty';
      const items = C.coatings.filter((c) => c.category === catId);
      list.innerHTML = items.map((c) => {
        const film = c.spec && c.spec.filmText ? c.spec.filmText : '--';
        return '<button class="coating-btn' + (c.id === activeId ? ' active' : '') + '" data-coating="' + c.id + '">' +
          '<span class="cb-code">' + U.escapeHTML(c.code || '—') + '</span>' +
          '<span class="cb-name" title="' + U.escapeHTML(c.name) + '">' + U.escapeHTML(c.shortName || c.name) + '</span>' +
          '<span class="cb-film">' + U.escapeHTML(film) + '</span></button>';
      }).join('');
    },

    renderTakeCard(mat) {
      const card = $('takeCard');
      if (!card || !mat) return;
      const cat = C.categories.filter((c) => c.id === mat.category)[0];
      const spec = mat.spec || {};
      const props = mat.props || {};
      const propRows = C.propFields.map((f) => {
        const v = props[f.key];
        if (v == null) return '';
        return '<div><span>' + U.escapeHTML(f.label) + '</span><b>' + U.fmt(v, f.digits) + ' ' + f.unit + '</b></div>';
      }).join('');
      card.innerHTML =
        '<div class="take-head"><div>' +
        '<span class="take-code">' + U.escapeHTML(mat.code || '—') + '</span>' +
        '<h3>' + U.escapeHTML(mat.name) + '</h3></div>' +
        '<span class="take-cat">' + U.escapeHTML(cat ? cat.name : '') + '</span></div>' +
        '<div class="take-spec"><span>' + U.escapeHTML(spec.label || '') + '</span><b>' + U.escapeHTML(spec.value || '--') + '</b>' +
        '<span>目标干膜</span><b>' + U.escapeHTML(spec.filmText || '--') + '</b>' +
        '<span>稀释剂</span><b>' + U.escapeHTML(props.solvent || '--') + '</b></div>' +
        '<div class="take-grid">' + propRows + '</div>' +
        '<div class="take-live-title">取料参数 · 实时</div>' +
        '<div class="take-live">' +
        '<div><span>单道湿膜</span><b id="takePass">--</b></div>' +
        '<div><span>预计道数</span><b id="takePasses">--</b></div>' +
        '<div class="strong"><span>取料量</span><b id="takeLoad">--</b></div>' +
        '<div><span>作业时间</span><b id="takeTime">--</b></div>' +
        '<div><span>选区面积</span><b id="takeArea">--</b></div>' +
        '<div><span>料桶余量</span><b id="takeTank">--</b></div>' +
        '</div>' +
        '<div class="take-actions">' +
        '<button class="btn btn-outline btn-sm" id="takeApply">套用推荐参数</button>' +
        '<button class="btn btn-ghost btn-sm" id="takeNozzle">喷嘴特写</button>' +
        '</div>';
      this.updateTakeLive();
    },

    updateTakeLive(info) {
      const app = SB.App;
      if (!app) return;
      const mat = C.materials[app.materialId];
      if (!mat) return;
      const p = (info && info.params) || app.params;
      if (!p) return;
      const area = app.spray ? app.spray.targetArea : 0;
      const thickness = Number(p.thickness) || 0;
      const solid = (mat.props && mat.props.solid ? mat.props.solid : 100) / 100;
      const film = mat.spec ? mat.spec.film : thickness;
      const passes = Math.max(1, Math.ceil(film / Math.max(1, thickness * solid)));
      const load = area * thickness / 1000 * C.consumptionFactor;
      const rate = Math.max(0.05, Number(p.speed) || 0.5) * Math.max(0.1, Number(p.fanWidth) || 0.3);
      const seconds = passes * area / rate;
      const set = (id, text, isStrong) => {
        const el = $(id);
        if (!el) return;
        el.textContent = text;
        if (isStrong) el.classList.add('strong');
      };
      set('takePass', U.fmt(thickness, 0) + ' µm');
      set('takePasses', passes + ' 道');
      set('takeLoad', U.fmt(load, 2) + ' L');
      set('takeTime', U.fmtTime(seconds));
      set('takeArea', U.fmt(area, 2) + ' ㎡');
      set('takeTank', U.fmt(app.spray ? app.spray.tank : 100, 0) + ' %');
    },

    setAdaptiveUI(on) {
      const box = document.querySelector('.adaptive-box');
      if (box) box.classList.toggle('on', !!on);
      const chk = $('chkAdaptive');
      if (chk) chk.checked = !!on;
      const badge = $('nozAdaptiveBtn');
      if (badge) {
        badge.textContent = on ? '自适应已开启' : '手动参数';
        badge.classList.toggle('on', !!on);
      }
    },

    setAdaptiveHint(text) {
      const hint = $('adaptiveHint');
      if (hint) hint.textContent = text;
    },

    applyParamBounds(materialId) {
      const mat = C.materials[materialId];
      Object.keys(C.params).forEach((key) => {
        const p = this.paramEls[key];
        if (!p || !mat || !mat.range || !mat.range[key]) return;
        const meta = C.params[key];
        const r = mat.range[key];
        const pad = Math.max((r[1] - r[0]) * 0.35, meta.step * 2);
        p.input.min = Math.max(meta.min, +(r[0] - pad).toFixed(4));
        p.input.max = Math.min(meta.max, +(r[1] + pad).toFixed(4));
      });
    },

    syncNozzle(params, materialId) {
      if (SB.Nozzle && SB.Nozzle.setParams) SB.Nozzle.setParams(params, materialId);
    },

    buildInventory() {
      const box = $('invFilter');
      if (!box) return;
      const chips = [{ id: 'all', short: '全部' }].concat(C.categories);
      box.innerHTML = chips.map((c) =>
        '<button class="cat-tab' + (c.id === this.invFilter ? ' active' : '') + '" data-inv-cat="' + c.id + '">' +
        U.escapeHTML(c.short) + '</button>'
      ).join('');
      box.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-inv-cat]');
        if (!btn) return;
        this.invFilter = btn.dataset.invCat;
        $$('.cat-tab', box).forEach((b) => b.classList.toggle('active', b.dataset.invCat === this.invFilter));
        this.renderInventoryList();
      });
    },

    showInventory(data) {
      this.inventoryData = data;
      this.openModal('inventoryModal');
      this.renderInventory();
      this.renderInventoryList();
    },

    refreshInventory(data) {
      const modal = $('inventoryModal');
      if (!modal || modal.classList.contains('hidden')) return;
      this.inventoryData = data || this.inventoryData;
      this.renderInventory();
      this.renderInventoryList();
    },

    renderInventory() {
      const data = this.inventoryData;
      if (!data) return;
      const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
      const pct = U.clamp(data.totalPercent, 0, 100);
      const color = pct <= 15 ? '#e5484d' : pct <= 40 ? '#e7a100' : '#0066CC';
      const donut = $('invDonut');
      if (donut) {
        donut.style.setProperty('--p', pct.toFixed(1) + '%');
        donut.style.setProperty('--c', color);
      }
      set('invPercent', pct.toFixed(1) + '%');
      set('invRemainL', U.fmt(data.totalRemaining, 2) + ' L');
      set('invTotalL', U.fmt(data.totalCapacity, 0) + ' L');
      const cur = data.current;
      if (cur) {
        set('invCurrentL', U.fmt(cur.remaining, 2) + ' L');
        set('invArea', U.fmt(data.remainingArea, 1) + ' ㎡');
        set('invCount', String(data.items.length) + ' 种');
      }
      const card = $('invCurrentCard');
      if (card && cur) {
        const cpct = U.clamp(cur.percent, 0, 100);
        const cls = cpct <= 15 ? 'critical' : cpct <= 40 ? 'low' : '';
        card.innerHTML =
          '<div class="inv-cur-head">' +
          '<span class="take-code">' + U.escapeHTML(cur.code || '—') + '</span>' +
          '<b>' + U.escapeHTML(cur.name) + '</b>' +
          '<span class="inv-cur-tag">当前涂料</span></div>' +
          '<div class="inv-cur-grid">' +
          '<div><span>当前余量</span><b>' + U.fmt(cur.remaining, 2) + ' / ' + U.fmt(cur.capacity, 1) + ' L</b></div>' +
          '<div><span>本次消耗</span><b>' + U.fmt(data.taskConsumption, 2) + ' L</b></div>' +
          '<div><span>剩余比例</span><b>' + U.fmt(cur.percent, 1) + ' %</b></div>' +
          '<div><span>预计可喷</span><b>' + U.fmt(data.remainingArea, 1) + ' ㎡</b></div>' +
          '</div>' +
          '<div class="progress"><div class="progress-bar ' + cls + '" style="width:' + cpct.toFixed(1) + '%"></div></div>';
      }
    },

    renderInventoryList() {
      const data = this.inventoryData;
      const box = $('invList');
      if (!data || !box) return;
      const items = data.items.filter((i) => this.invFilter === 'all' || i.category === this.invFilter);
      const count = $('invCount');
      if (count) count.textContent = items.length + ' / ' + data.items.length + ' 种';
      box.innerHTML = items.map((i) => {
        const pct = U.clamp(i.percent, 0, 100);
        const cls = i.percent <= 15 ? 'critical' : i.percent <= 40 ? 'low' : '';
        const current = i.id === data.activeId ? ' current' : '';
        return '<div class="inv-item ' + cls + current + '" data-inv-id="' + i.id + '">' +
          '<div class="inv-item-top">' +
          '<span class="inv-code">' + U.escapeHTML(i.code || '—') + '</span>' +
          '<b title="' + U.escapeHTML(i.name) + '">' + U.escapeHTML(i.shortName) + '</b>' +
          '<span class="inv-pct">' + pct.toFixed(0) + '%</span></div>' +
          '<div class="inv-item-sub"><span>' + U.fmt(i.remaining, 2) + ' / ' + U.fmt(i.capacity, 1) + ' L</span>' +
          '<span>' + U.escapeHTML(i.categoryName) + '</span></div>' +
          '<div class="inv-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
          '</div>';
      }).join('');
    },

    buildParams() {
      const list = $('paramList');
      if (!list) return;
      const material = C.materials.putty;
      Object.keys(C.params).forEach((key) => {
        const p = C.params[key];
        const row = document.createElement('div');
        row.className = 'param-row';
        row.dataset.param = key;
        row.innerHTML =
          '<div class="param-head"><span class="param-name">' + p.label + '</span>' +
          '<span class="param-val"><span data-param-val="' + key + '">--</span><i>' + p.unit + '</i></span></div>' +
          '<input type="range" class="param-slider" data-param-slider="' + key + '" min="' + p.min + '" max="' + p.max +
          '" step="' + p.step + '" value="' + material.defaults[key] + '" aria-label="' + p.label + '">' +
          '<div class="param-warning" data-param-warning="' + key + '"></div>';
        list.appendChild(row);
        this.paramEls[key] = {
          row,
          input: row.querySelector('input'),
          val: row.querySelector('[data-param-val]'),
          warning: row.querySelector('[data-param-warning]')
        };
      });
      this.setParams(material.defaults, 'putty');
    },

    buildTemplates() {
      const list = $('templateList');
      if (!list) return;
      C.templates.forEach((t) => {
        const b = document.createElement('button');
        b.className = 'template-btn';
        b.dataset.template = t.id;
        b.innerHTML = '<b>' + t.name + '</b><span>' + t.desc + '</span>';
        list.appendChild(b);
      });
    },

    buildLayers() {
      const list = $('layerList');
      if (!list) return;
      C.layers.forEach((layer) => {
        const label = document.createElement('label');
        label.className = 'switch-row';
        label.innerHTML = '<span>' + layer.name + '</span>' +
          '<input type="checkbox" data-layer="' + layer.id + '" checked><i class="switch"></i>';
        list.appendChild(label);
      });
    },

    buildTelemetry() {
      const box = $('jointTelemetry');
      if (!box) return;
      box.innerHTML = C.robot.joints.map((j, i) =>
        '<div class="jt-cell"><span>' + j.name + '</span><b data-jt="' + i + '">0.0°</b></div>'
      ).join('');
    },

    bindTabs() {
      $$('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.setTab(btn.dataset.tab));
      });
      $$('.mobile-nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.setMobileView(btn.dataset.mview));
      });
    },

    bindModals() {
      $$('[data-close]').forEach((btn) => {
        btn.addEventListener('click', () => this.closeModal(btn.dataset.close));
      });
      $$('.modal-mask').forEach((mask) => {
        mask.addEventListener('click', (e) => {
          if (e.target === mask) this.closeModal(mask.id);
        });
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          $$('.modal-mask').forEach((m) => {
            if (!m.classList.contains('hidden')) this.closeModal(m.id);
          });
        }
      });
      this.on('btnExportCSV', 'click', () => this.exportCurrentStats());
    },

    bindHeader() {
      this.on('btnHelp', 'click', () => this.openModal('helpModal'));
      this.on('btnShare', 'click', () => this.openShare());
      this.on('btnCopyShare', 'click', () => this.copyShareLink());
      this.on('btnFullscreen', 'click', () => {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => this.toast('当前浏览器不支持全屏', 'warn'));
        }
      });
      this.on('btnClearLog', 'click', () => this.clearLog());
    },

    setTab(name) {
      const panel = $('leftPanel');
      if (!panel) return;
      const same = panel.dataset.tab === name;
      panel.dataset.tab = name;
      $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      if (U.isMobile() && !same) this.setMobileView(name);
    },

    setMobileView(view) {
      if (view === 'none') {
        document.body.dataset.mview = 'none';
        $$('.mobile-nav-btn').forEach((b) => b.classList.remove('active'));
        return;
      }
      // 横屏抽屉模式下，再次点击当前入口可收起面板
      if (document.body.dataset.mview === view && U.isLandscape()) {
        this.setMobileView('none');
        return;
      }
      document.body.dataset.mview = view;
      $$('.mobile-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.mview === view));
      if (view !== 'dashboard' && ['motion', 'craft', 'teach', 'display'].includes(view)) {
        const panel = $('leftPanel');
        if (panel) panel.dataset.tab = view;
      }
      const panel = view === 'dashboard' ? $('rightPanel') : $('leftPanel');
      const body = panel && panel.querySelector('.panel-body');
      if (body) body.scrollTop = 0;
    },
    setStatus(mode, detail) {
      const m = MODE[mode] || MODE.ready;
      const hs = $('headerStatus'), ht = $('headerStatusText');
      if (hs) {
        hs.classList.remove('warn', 'danger');
        if (mode === 'fault' || mode === 'estop') hs.classList.add('danger');
        else if (mode === 'spraying' || mode === 'playback') hs.classList.add('warn');
      }
      if (ht) ht.textContent = detail || m.header;
      const ds = $('deviceStatus');
      if (ds) {
        const tool = SB.Tools ? SB.Tools.current() : null;
        ds.className = 'status-badge ' + m.cls;
        ds.textContent = mode === 'spraying' && tool ? tool.verb + '中' : m.badge;
      }
      const rt = $('runStateText');
      if (rt) rt.textContent = detail || m.run;
      const cs = $('canvasState');
      if (cs) {
        const tool = SB.Tools ? SB.Tools.current() : null;
        cs.className = 'badge' + ((mode === 'fault' || mode === 'estop') ? ' fault' : (mode === 'moving' || mode === 'spraying' || mode === 'playback') ? ' running' : '');
        cs.textContent = mode === 'spraying' && tool ? tool.verb + '作业中' : m.canvas;
      }
      const fa = document.querySelector('.fault-actions');
      if (fa) fa.classList.toggle('show', mode === 'fault' || mode === 'estop');
      const eb = $('estopBtn');
      if (eb) eb.classList.toggle('estop-active', mode === 'estop');
      const me = $('mobileEstop');
      if (me) me.style.filter = mode === 'estop' ? 'brightness(.75)' : '';
    },

    setSprayOn(on) {
      this._sprayOn = !!on;
      const tool = SB.Tools ? SB.Tools.current() : null;
      const short = tool ? tool.short : '喷涂';
      const verb = tool ? tool.verb : '喷涂';
      const b = $('canvasSpray');
      if (b) {
        b.textContent = on ? verb + '进行中' : verb + '关闭';
        b.className = 'badge ghost ' + (on ? 'spray-on' : 'spray-off');
      }
      const toggle = $('btnSprayToggle');
      if (toggle) {
        toggle.textContent = on ? '暂停' + short : '开始' + short;
        toggle.classList.toggle('btn-outline', on);
        toggle.classList.toggle('btn-warning', !on);
      }
      const stop = $('btnSprayStop');
      if (stop) stop.disabled = !on;
    },

    setTool(id) {
      const cfg = (C.endEffectors || []).filter((t) => t.id === id)[0];
      if (!cfg) return;
      $$('#toolSwitch [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === id));
      const badge = $('canvasTool');
      if (badge) badge.textContent = cfg.badge;
      const run = $('btnRunPath');
      if (run) run.textContent = '执行' + cfg.short;
      this.setSprayOn(this._sprayOn);
    },

    setFollow(on) {
      const btn = $('btnFollow');
      if (btn) {
        btn.classList.toggle('active', !!on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (on) {
        $$('#viewSwitch button').forEach((b) => {
          if (b.id !== 'btnFollow') b.classList.remove('active');
        });
      }
    },

    setInterlock(locked, reason) {
      this.locked = !!locked;
      this.jointSliders.forEach((s) => { s.disabled = locked; });
      this.poseButtons.forEach((b) => { b.disabled = locked; });
      ['btnRecord', 'btnPlayback', 'btnSprayToggle', 'btnSprayStop', 'btnSelectArea', 'btnGenPath', 'btnRunPath'].forEach((id) => {
        const el = $(id);
        if (el) el.disabled = locked;
      });
      const tip = $('jointLockTip');
      if (tip) tip.textContent = locked ? (reason || '已锁定') : '角度限位保护';
      if (!locked) this.setSprayOn(this._sprayOn);
    },

    markPose(id) {
      this.poseButtons.forEach((b) => b.classList.toggle('active', b.dataset.pose === id));
    },

    syncJoints(angles, skipSlider) {
      if (!angles) return;
      angles.forEach((a, i) => {
        const s = this.jointSliders[i];
        if (s) {
          if (!skipSlider) s.value = U.clamp(a, Number(s.min), Number(s.max));
          this.updateSliderFill(s);
          const out = document.querySelector('[data-joint-val="' + i + '"]');
          if (out) out.textContent = U.fmt(a, 1) + '°';
        }
        const jt = document.querySelector('[data-jt="' + i + '"]');
        if (jt) jt.textContent = U.fmt(a, 1) + '°';
      });
    },

    updateSliderFill(input) {
      const min = Number(input.min), max = Number(input.max);
      const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 50;
      input.style.setProperty('--fill', pct + '%');
    },

    syncParamFill() {
      Object.values(this.paramEls).forEach((p) => this.updateSliderFill(p.input));
    },

    setMaterial(materialId) {
      const mat = C.materials[materialId];
      if (!mat) return;
      if (mat.category && this.currentCategory !== mat.category) this.setCategory(mat.category);
      const list = $('coatingList');
      if (list) {
        $$('[data-coating]', list).forEach((b) => b.classList.toggle('active', b.dataset.coating === materialId));
      }
      const cm = $('canvasMaterial');
      if (cm) cm.textContent = mat.shortName || mat.name;
      this.renderTakeCard(mat);
    },

    setParams(params, materialId) {
      this.applyParamBounds(materialId);
      Object.keys(C.params).forEach((key) => {
        const p = this.paramEls[key];
        if (!p) return;
        p.input.value = params[key];
        this.updateSliderFill(p.input);
        this.renderParamValue(key, params[key]);
        this.validateParam(key, params[key], materialId);
      });
      this.setMaterial(materialId);
      this.syncNozzle(params, materialId);
      this.updateTakeLive({ params: params });
    },

    renderParamValue(key, value) {
      const p = this.paramEls[key];
      if (!p) return;
      const meta = C.params[key];
      p.val.textContent = U.fmt(value, meta.digits);
    },

    validateParam(key, value, materialId) {
      const p = this.paramEls[key];
      if (!p) return true;
      const range = C.materials[materialId].range[key];
      const min = Number(p.input.min), max = Number(p.input.max);
      const pct = max > min ? ((value - min) / (max - min)) * 100 : 50;
      p.input.style.setProperty('--fill', pct + '%');
      const valid = value >= range[0] - 1e-9 && value <= range[1] + 1e-9;
      p.row.classList.toggle('invalid', !valid);
      p.input.classList.toggle('invalid', !valid);
      const meta = C.params[key];
      p.warning.textContent = '推荐范围 ' + range[0] + '–' + range[1] + ' ' + meta.unit + '，当前值可能影响喷涂质量';
      return valid;
    },

    getParamWarnings(materialId) {
      const bad = [];
      Object.keys(C.params).forEach((key) => {
        const input = this.paramEls[key] && this.paramEls[key].input;
        if (!input) return;
        const range = C.materials[materialId].range[key];
        const v = Number(input.value);
        if (v < range[0] || v > range[1]) bad.push(C.params[key].label);
      });
      return bad;
    },
    setTank(percent) {
      const pct = U.clamp(percent, 0, 100);
      const bar = $('tankBar'), val = $('tankValue');
      if (bar) {
        bar.style.width = pct + '%';
        bar.classList.toggle('low', pct <= 35 && pct > 15);
        bar.classList.toggle('critical', pct <= 15);
      }
      if (val) {
        val.textContent = pct.toFixed(0) + '%';
        val.style.color = pct <= 15 ? 'var(--danger)' : '';
      }
    },

    setTimer(seconds) {
      const el = $('taskTimer');
      if (el) el.textContent = U.fmtTime(seconds);
    },

    updateTelemetry(data) {
      if (!data) return;
      if (data.joints) {
        data.joints.forEach((a, i) => {
          const jt = document.querySelector('[data-jt="' + i + '"]');
          if (jt) jt.textContent = U.fmt(a, 1) + '°';
        });
      }
      if (data.tcp) {
        const fields = { tcpX: data.tcp.x, tcpY: data.tcp.y, tcpZ: data.tcp.z };
        Object.keys(fields).forEach((id) => {
          const el = $(id);
          if (el) el.textContent = (fields[id] >= 0 ? '+' : '') + U.fmt(fields[id], 3) + ' m';
        });
      }
      if (data.speed != null) $('speedValue').textContent = U.fmt(data.speed, 2) + ' m/s';
      if (data.area != null) $('areaValue').textContent = U.fmt(data.area, 2) + ' ㎡';
      if (data.coverage != null) $('coverageValue').textContent = U.fmt(data.coverage, 1) + '%';
      if (data.consumption != null) $('consumptionValue').textContent = U.fmt(data.consumption, 2) + ' L';
      if (data.distance != null) $('distanceValue').textContent = U.fmt(data.distance, 2) + ' m';
      const tt = $('telemetryTime');
      if (tt) tt.textContent = U.clock();
    },

    toast(message, type, duration) {
      const stack = $('toastStack');
      if (!stack) return;
      while (stack.children.length >= 3) stack.removeChild(stack.firstChild);
      const el = document.createElement('div');
      el.className = 'toast ' + (type || 'info');
      el.textContent = message;
      stack.appendChild(el);
      const ms = duration || (type === 'error' ? 3800 : 2600);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(-6px)';
        el.style.transition = 'opacity .2s, transform .2s';
        setTimeout(() => el.remove(), 220);
      }, ms);
    },

    confirm(title, message, danger) {
      if (window.ElementPlus && ElementPlus.ElMessageBox) {
        return ElementPlus.ElMessageBox.confirm(message, title, {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: danger ? 'warning' : 'info',
          customClass: 'spraybot-msgbox'
        }).then(() => true).catch(() => false);
      }
      return Promise.resolve(window.confirm(title + '\n\n' + message));
    },

    notice(title, message) {
      if (window.ElementPlus && ElementPlus.ElMessageBox) {
        return ElementPlus.ElMessageBox.alert(message, title, {
          confirmButtonText: '知道了',
          customClass: 'spraybot-msgbox'
        }).catch(() => {});
      }
      window.alert(title + '\n\n' + message);
      return Promise.resolve();
    },

    log(message, level) {
      const list = $('logList');
      if (!list) return;
      const empty = list.querySelector('.log-empty');
      if (empty) empty.remove();
      const row = document.createElement('div');
      row.className = 'log-item ' + (level || 'info');
      row.innerHTML = '<time>' + U.clock() + '</time><span class="msg">' + U.escapeHTML(message) + '</span>';
      list.appendChild(row);
      while (list.children.length > 120) list.removeChild(list.firstChild);
      list.scrollTop = list.scrollHeight;
    },

    clearLog() {
      const list = $('logList');
      if (!list) return;
      list.innerHTML = '<div class="log-empty">日志已清空</div>';
    },

    setTeachPoints(points) {
      const count = $('teachCount');
      if (count) count.textContent = points.length + ' 点';
      const list = $('teachList');
      if (!list) return;
      if (!points.length) {
        list.innerHTML = '<div class="teach-empty">暂无示教点，调整姿态后点击「记录点位」</div>';
        return;
      }
      list.innerHTML = points.map((p, i) =>
        '<div class="teach-item"><span class="teach-index">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="teach-angles">' + p.angles.map((a) => U.fmt(a, 1) + '°').join(' / ') + '</span>' +
        '<button class="teach-del" data-del-index="' + i + '" title="删除该点">×</button></div>'
      ).join('');
    },
    setSavedTrajectories(list, selectedId) {
      const sel = $('savedSelect');
      if (!sel) return;
      if (!list.length) {
        sel.innerHTML = '<option value="">暂无已保存轨迹</option>';
        return;
      }
      sel.innerHTML = list.map((t) =>
        '<option value="' + U.escapeHTML(t.id) + '"' + (t.id === selectedId ? ' selected' : '') + '>' +
        U.escapeHTML(t.name) + ' · ' + (t.points ? t.points.length : 0) + ' 点</option>'
      ).join('');
    },

    setSelectInfo(text) {
      const el = $('selectInfo');
      if (el) el.textContent = text;
    },

    showAlert(text) {
      const box = $('canvasAlert');
      if (!box) return;
      const t = $('alertText');
      if (t) t.textContent = text;
      box.classList.remove('hidden');
    },

    hideAlert() {
      const box = $('canvasAlert');
      if (box) box.classList.add('hidden');
    },

    setModelStatus(text, isError) {
      const el = $('modelStatus');
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('error', !!isError);
    },

    setViewButton(name) {
      $$('#viewSwitch button').forEach((b) => {
        if (b.id === 'btnFollow') return;
        b.classList.toggle('active', b.dataset.view === name);
      });
    },

    openShare() {
      const url = location.href;
      const box = $('shareQr');
      const urlEl = $('shareUrl');
      if (urlEl) urlEl.textContent = url;
      if (box) {
        box.innerHTML = '';
        if (typeof window.qrcode === 'function') {
          try {
            const qr = window.qrcode(0, 'M');
            qr.addData(url);
            qr.make();
            const img = document.createElement('img');
            img.src = qr.createDataURL(6, 4);
            img.alt = '访问二维码';
            box.appendChild(img);
          } catch (e) {
            box.innerHTML = '<span class="share-fallback">二维码生成失败</span>';
          }
        } else {
          box.innerHTML = '<span class="share-fallback">二维码组件未加载</span>';
        }
      }
      const tip = $('shareTip');
      if (tip) {
        const local = location.protocol === 'file:' ||
          /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
        tip.textContent = local
          ? '当前为本机地址，二维码仅本机可访问。部署到公网或局域网地址后，他人扫码即可打开系统。'
          : '手机扫码即可打开本系统，建议横屏使用以获得完整操作界面。';
      }
      this.openModal('shareModal');
      this.log('分享二维码已生成 · ' + url, 'info');
    },

    copyShareLink() {
      const url = location.href;
      const done = () => this.toast('访问链接已复制', 'ok');
      const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { this.toast('复制失败，请手动选择链接', 'warn'); }
        document.body.removeChild(ta);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(fallback);
      } else {
        fallback();
      }
    },

    setSelectionActive(active) {
      const btn = $('btnSelectArea');
      if (btn) {
        btn.classList.toggle('active', active);
        btn.textContent = active ? '拖拽框选中…' : '框选区域';
      }
    },

    setPathButtons(opts) {
      const run = $('btnRunPath');
      const clear = $('btnClearPath');
      if (run) run.disabled = !opts.hasPath || !!opts.running || this.locked;
      if (clear) clear.disabled = !opts.hasPath && !opts.hasSelection;
      if (opts.running) this.setResumeAvailable(false);
    },

    setResumeAvailable(on, state) {
      const btn = $('btnResumePath');
      if (!btn) return;
      btn.hidden = !on;
      btn.classList.toggle('hidden', !on);
      if (on && state && (state.taskTotalLength || state.pathLength) > 0) {
        const total = state.taskTotalLength || state.pathLength;
        const done = state.overallTravel != null ? state.overallTravel : (state.travel || 0);
        const pct = Math.round(U.clamp(done / total, 0, 1) * 100);
        btn.textContent = '继续作业 ' + pct + '%';
      } else if (on) {
        btn.textContent = '继续作业';
      }
    },

    openModal(id) {
      const el = $(id);
      if (el) el.classList.remove('hidden');
    },

    closeModal(id) {
      const el = $(id);
      if (el) el.classList.add('hidden');
    },

    showStats(data) {
      this.currentStats = data;
      const area = $('statsArea');
      if (area) area.textContent = U.fmt(data.area, 2) + ' ㎡';
      const table = $('statsTable');
      if (table) {
        table.innerHTML = data.rows.map((r) =>
          '<div class="stats-cell"><span>' + U.escapeHTML(r.label) + '</span><b>' + U.escapeHTML(r.value) + '</b></div>'
        ).join('');
      }
      this.openModal('statsModal');
    },

    exportCurrentStats() {
      if (!this.currentStats) return;
      const rows = this.currentStats.csv || this.currentStats.rows.map((r) => [r.label, r.value]);
      const lines = [['项目', '数值']].concat(rows).map((r) =>
        r.map((v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')
      );
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      const stamp = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
        '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
      a.href = url;
      a.download = '喷涂任务数据_' + stamp + '.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
      this.toast('任务数据已导出为 CSV', 'ok');
    },

    applyTheme(theme) {
      document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    },

    readSettings() {
      try {
        const raw = localStorage.getItem(C.storageKeys.settings);
        return raw ? Object.assign({}, C.defaults.settings, JSON.parse(raw)) : U.clone(C.defaults.settings);
      } catch (e) {
        return U.clone(C.defaults.settings);
      }
    },

    saveSettings(settings) {
      try { localStorage.setItem(C.storageKeys.settings, JSON.stringify(settings)); } catch (e) { /* noop */ }
    },

    readParams() {
      try {
        const raw = localStorage.getItem(C.storageKeys.params);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !C.materials[data.material] || !data.params) return null;
        const params = Object.assign({}, C.materials[data.material].defaults, data.params);
        // 兼容旧版本：厚度曾以 mm 存储，现统一为 µm
        if (params.thickness != null && params.thickness < 5) params.thickness = Math.round(params.thickness * 1000);
        return { material: data.material, params: params };
      } catch (e) { return null; }
    },

    saveParams(material, params) {
      try { localStorage.setItem(C.storageKeys.params, JSON.stringify({ material, params })); } catch (e) { /* noop */ }
    }
  };
})();