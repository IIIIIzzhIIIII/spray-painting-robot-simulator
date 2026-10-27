/* =========================================================
 * app.js — 应用装配、交互绑定、路径规划、动画主循环
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const C = SB.CONFIG;
  const U = SB.U;

  const $ = (id) => document.getElementById(id);

  const App = SB.App = {
    scene: null,
    robot: null,
    spray: null,
    teach: null,
    settings: null,
    materialId: 'putty',
    params: null,
    adaptive: false,
    nozzleOn: false,
    surface: 'wall',
    inventory: null,
    _invClock: 0,
    _invSaveClock: 0,
    _invDirty: false,
    state: 'ready',
    sprayDesired: false,
    motion: null,
    pathRun: null,
    baseDrive: null,
    pathBase: null,
    pathRoute: null,
    resumeState: null,
    roomTask: null,
    selection: null,
    selectionMode: false,
    drag: null,
    path: null,
    pathCum: null,
    pathLength: 0,
    lastSafeJoints: null,
    taskTime: 0,
    speed: 0,
    _prevTcp: null,
    _uiClock: 0,
    _last: 0,
    _raf: 0,
    _reportClock: 0,

    init() {
      const ui = SB.UI;
      const loaded = ui.readSettings();
      const def = U.clone(C.defaults.settings);
      this.settings = Object.assign(def, loaded);
      this.settings.layers = Object.assign({}, def.layers, (loaded && loaded.layers) || {});
      ui.applyTheme(this.settings.theme);
      ui.init();
      this.buildSceneSelect();
      this.loadInventory();
      this.surface = 'wall';

      this.scene = SB.Scene.init($('viewport'));
      this.robot = SB.Robot.init(this.scene);
      this.spray = SB.Spray.init(this.scene, this.robot);
      SB.Tools.init(this);
      this.scene.setFollow(true, true);
      SB.Nozzle.init(this);
      this.teach = SB.Teach.init(this.robot);
      this.applySettings();
      this.loadParams();
      this.bind();
      ui.setAdaptiveUI(false);
      ui.updateTakeLive({ params: this.params });

      this.lastSafeJoints = this.robot.getJoints();
      ui.syncJoints(this.lastSafeJoints);
      ui.setTank(this.spray.tank);
      ui.setTimer(0);
      ui.setSprayOn(false);
      ui.setStatus('ready', '系统就绪');
      ui.setPathButtons({ hasPath: false, hasSelection: false, running: false });
      ui.setSelectInfo(this.emptySelectionText());
      this.setSurfaceUI('wall');
      ui.markPose('home');
      ui.log('仿真系统初始化完成 · Three.js r' + THREE.REVISION, 'ok');

      const tests = this.robot.selfTest();
      const passed = tests.filter((t) => t.ok).length;
      ui.log('运动学自检 ' + passed + '/' + tests.length + ' 通过', passed === tests.length ? 'ok' : 'warn');
      if (passed !== tests.length) console.warn('[SprayBot] IK selfTest', tests);
      this.updateTelemetry(0);
      this._last = performance.now();
      this._raf = requestAnimationFrame((ts) => this.loop(ts));
      return this;
    },

    applySettings() {
      const s = this.settings;
      const ui = SB.UI;
      this.scene.setTheme(s.theme);
      this.scene.setQuality(s.quality);
      this.spray.setParticles(s.particles);
      $('chkTheme').checked = s.theme === 'dark';
      $('chkParticles').checked = !!s.particles;
      $('selQuality').value = s.quality;
      Object.keys(this.settings.layers).forEach((key) => {
        const on = !!this.settings.layers[key];
        this.robot.setLayer(key, on);
        const input = document.querySelector('[data-layer="' + key + '"]');
        if (input) input.checked = on;
      });
      ui.applyTheme(s.theme);
    },

    saveSettings() {
      this.settings.theme = $('chkTheme').checked ? 'dark' : 'light';
      this.settings.particles = !!$('chkParticles').checked;
      this.settings.quality = $('selQuality').value;
      SB.UI.saveSettings(this.settings);
    },

    loadParams() {
      const saved = SB.UI.readParams();
      this.materialId = saved ? saved.material : 'putty';
      this.params = saved ? saved.params : U.clone(C.materials[this.materialId].defaults);
      SB.UI.setParams(this.params, this.materialId);
      this.spray.setMaterial(this.materialId);
      this.setInventoryTank(this.materialId);
    },

    readParamsFromUI() {
      const p = {};
      Object.keys(C.params).forEach((key) => {
        const el = SB.UI.paramEls[key];
        if (el) p[key] = Number(el.input.value);
      });
      this.params = p;
      return p;
    },

    saveParams() {
      SB.UI.saveParams(this.materialId, this.params);
    },

    loadInventory() {
      let saved = null;
      try {
        const raw = localStorage.getItem(C.storageKeys.inventory);
        if (raw) saved = JSON.parse(raw);
      } catch (e) { saved = null; }
      this.inventory = {};
      C.coatings.forEach((c) => {
        const rec = saved ? saved[c.id] : null;
        const rem = typeof rec === 'number' && isFinite(rec) ? rec : C.tankCapacity;
        this.inventory[c.id] = { capacity: C.tankCapacity, remaining: U.clamp(rem, 0, C.tankCapacity) };
      });
    },

    saveInventory() {
      const out = {};
      Object.keys(this.inventory || {}).forEach((id) => {
        out[id] = Number(this.inventory[id].remaining.toFixed(3));
      });
      try { localStorage.setItem(C.storageKeys.inventory, JSON.stringify(out)); } catch (e) { /* noop */ }
      this._invDirty = false;
    },

    syncInventoryFromTank() {
      const inv = this.inventory && this.inventory[this.materialId];
      if (!inv || !this.spray) return;
      const rem = inv.capacity * (U.clamp(this.spray.tank, 0, 100) / 100);
      if (Math.abs(rem - inv.remaining) > 0.0005) {
        inv.remaining = rem;
        this._invDirty = true;
      }
    },

    inventoryPercent(id) {
      const inv = this.inventory && this.inventory[id];
      return inv && inv.capacity ? (inv.remaining / inv.capacity) * 100 : 100;
    },

    setInventoryTank(id) {
      if (!this.spray) return;
      this.spray.setTankLevel(this.inventoryPercent(id));
      SB.UI.setTank(this.spray.tank);
    },

    inventoryData() {
      const items = C.coatings.map((c) => {
        const inv = (this.inventory && this.inventory[c.id]) || { capacity: C.tankCapacity, remaining: C.tankCapacity };
        const cat = C.categories.filter((x) => x.id === c.category)[0];
        return {
          id: c.id,
          code: c.code || '',
          name: c.name,
          shortName: c.shortName || c.name,
          category: c.category,
          categoryName: cat ? cat.name : '',
          capacity: inv.capacity,
          remaining: inv.remaining,
          percent: inv.capacity ? (inv.remaining / inv.capacity) * 100 : 0
        };
      });
      const totalCapacity = items.reduce((s, i) => s + i.capacity, 0);
      const totalRemaining = items.reduce((s, i) => s + i.remaining, 0);
      const current = items.filter((i) => i.id === this.materialId)[0] || items[0];
      const p = this.params || C.materials[this.materialId].defaults;
      const perM2 = Math.max(0, (Number(p.thickness) || 0) / 1000 * C.consumptionFactor);
      return {
        items: items,
        activeId: this.materialId,
        totalCapacity: totalCapacity,
        totalRemaining: totalRemaining,
        totalPercent: totalCapacity ? (totalRemaining / totalCapacity) * 100 : 0,
        current: current,
        taskConsumption: this.spray ? this.spray.consumption : 0,
        remainingArea: perM2 > 0 && current ? current.remaining / perM2 : 0
      };
    },

    isInventoryOpen() {
      const modal = $('inventoryModal');
      return modal && !modal.classList.contains('hidden');
    },

    openInventory() {
      this.syncInventoryFromTank();
      SB.UI.showInventory(this.inventoryData());
    },

    refillCurrent() {
      const mat = C.materials[this.materialId];
      const inv = this.inventory[this.materialId];
      if (!mat || !inv) return;
      inv.remaining = inv.capacity;
      this.spray.refill();
      SB.UI.setTank(100);
      this.saveInventory();
      if (this.isInventoryOpen()) SB.UI.refreshInventory(this.inventoryData());
      SB.UI.updateTakeLive({ params: this.params });
      SB.UI.toast('已补充「' + (mat.shortName || mat.name) + '」至满桶', 'ok');
      SB.UI.log('补充涂料：' + mat.name + ' · ' + inv.capacity + ' L', 'ok');
    },

    isLocked() { return this.state === 'estop' || this.state === 'fault'; },
    isBusy() { return !!this.pathRun || !!this.baseDrive || this.motion || this.teach.playing; },

    bind() {
      const ui = SB.UI;
      const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

      ui.jointSliders.forEach((input) => {
        input.addEventListener('input', () => this.onJointInput(input));
      });
      ui.poseButtons.forEach((btn) => {
        btn.addEventListener('click', () => this.onPose(btn.dataset.pose));
      });

      on('btnSprayToggle', 'click', () => this.startAutoSpray());
      on('btnSprayStop', 'click', () => {
        if (this.baseDrive || this.pathRun) this.clearPlanning(false);
        this.setSpray(false);
      });

      Object.keys(ui.paramEls).forEach((key) => {
        ui.paramEls[key].input.addEventListener('input', () => this.onParam(key));
      });
      on('chkAdaptive', 'change', () => this.setAdaptive($('chkAdaptive').checked));
      on('btnNozzleStage', 'click', () => this.setNozzleView(true));
      on('nozClose', 'click', () => {
        this.setNozzleView(false);
        this.scene.setView(this.scene._view || 'overview');
      });
      on('nozAdaptiveBtn', 'click', () => this.setAdaptive(!this.adaptive));
      document.querySelectorAll('[data-noz-param]').forEach((el) => {
        el.addEventListener('input', () => {
          ui.updateSliderFill(el);
          this.setParamValue(el.dataset.nozParam, Number(el.value));
        });
      });
      const templateList = $('templateList');
      if (templateList) {
        templateList.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-template]');
          if (btn) this.onTemplate(btn.dataset.template);
        });
      }

      const layerList = $('layerList');
      if (layerList) {
        layerList.addEventListener('change', (e) => {
          const input = e.target.closest('[data-layer]');
          if (!input) return;
          this.settings.layers[input.dataset.layer] = input.checked;
          this.robot.setLayer(input.dataset.layer, input.checked);
          ui.saveSettings(this.settings);
          ui.log('图层「' + input.dataset.layer + '」' + (input.checked ? '已显示' : '已隐藏'), 'info');
        });
      }
      on('chkParticles', 'change', () => {
        this.spray.setParticles($('chkParticles').checked);
        this.saveSettings();
      });
      on('chkTheme', 'change', () => {
        this.saveSettings();
        ui.applyTheme(this.settings.theme);
        this.scene.setTheme(this.settings.theme);
      });
      on('selQuality', 'change', () => {
        this.saveSettings();
        this.scene.setQuality(this.settings.quality);
        ui.toast('渲染画质已切换为' + (this.settings.quality === 'high' ? '高清' : this.settings.quality === 'low' ? '流畅' : '均衡'), 'ok');
      });

      on('btnRefill', 'click', () => this.refillCurrent());
      on('btnInventory', 'click', () => this.openInventory());
      on('btnInventoryRefill', 'click', () => this.refillCurrent());
      const invModal = $('inventoryModal');
      if (invModal) {
        invModal.addEventListener('click', (e) => {
          if (e.target === invModal || e.target.closest('[data-close="inventoryModal"]')) {
            this.saveInventory();
          }
        });
      }
      on('btnClearWall', 'click', () => this.clearWall());
      on('btnResetAll', 'click', () => this.resetAll());
      on('btnClearPath', 'click', () => this.clearPlanning(true));
      on('btnSelectArea', 'click', () => this.toggleSelectionMode());
      on('btnGenPath', 'click', () => this.buildPath());
      on('btnRunPath', 'click', () => this.startPathRun());
      on('btnRoomSpray', 'click', () => this.startRoomSpray());
      on('btnResumePath', 'click', () => this.resumePathRun());

      const viewSwitch = $('viewSwitch');
      if (viewSwitch) {
        viewSwitch.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-view]');
          if (!btn) return;
          if (btn.id === 'btnFollow') {
            this.toggleFollow();
            return;
          }
          if (btn.dataset.view === 'nozzle') {
            this.setNozzleView(true);
            return;
          }
          this.setNozzleView(false);
          let view = btn.dataset.view;
          if (view === 'wall' && C.isWallSurface(this.surface)) view = this.surface;
          this.scene.setView(view);
        });
      }
      const toolSwitch = $('toolSwitch');
      if (toolSwitch) {
        toolSwitch.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-tool]');
          if (btn) this.setTool(btn.dataset.tool);
        });
      }
      const sceneSelect = $('sceneSelect');
      if (sceneSelect) {
        sceneSelect.addEventListener('change', () => this.switchScene(sceneSelect.value));
      }
      const surfaceSwitch = $('surfaceSwitch');
      if (surfaceSwitch) {
        surfaceSwitch.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-surface]');
          if (btn) this.setSurface(btn.dataset.surface);
        });
      }
      on('alertClose', 'click', () => ui.hideAlert());
      on('btnCanvasFull', 'click', () => {
        const panel = $('canvasPanel');
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else if (panel && panel.requestFullscreen) panel.requestFullscreen().catch(() => ui.toast('当前浏览器不支持全屏', 'warn'));
      });

      on('btnLoadGLB', 'click', () => { const f = $('glbFile'); if (f) f.click(); });
      on('glbFile', 'change', (e) => this.loadGLBFile(e.target.files && e.target.files[0]));
      on('btnResetModel', 'click', () => this.resetModel());

      on('estopBtn', 'click', () => this.emergencyStop());
      on('mobileEstop', 'click', () => this.emergencyStop());
      on('btnResetFault', 'click', () => this.resetFault());

      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.selectionMode) {
          this.toggleSelectionMode(false);
          ui.toast('已退出框选模式', 'info');
        }
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this.sprayDesired) {
          this.setSpray(false);
          ui.log('页面切至后台，喷涂已自动停止', 'warn');
        }
      });
      this.bindSelection();
      this.bindTeach();
    },
    bindSelection() {
      const el = this.scene.renderer.domElement;
      el.addEventListener('pointerdown', (e) => this.onPointerDown(e), true);
      window.addEventListener('pointermove', (e) => this.onPointerMove(e));
      window.addEventListener('pointerup', (e) => this.onPointerUp(e));
      window.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    },

    bindTeach() {
      const ui = SB.UI;
      const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
      on('btnRecord', 'click', () => this.recordPoint());
      on('btnPlayback', 'click', () => this.startPlayback());
      on('btnStopPlayback', 'click', () => this.stopPlayback());
      on('btnClearTeach', 'click', () => this.clearTeach());
      on('btnSaveTraj', 'click', () => this.saveTrajectory());
      on('btnLoadTraj', 'click', () => this.loadTrajectory());
      on('btnDeleteTraj', 'click', () => this.deleteTrajectory());
      const list = $('teachList');
      if (list) {
        list.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-del-index]');
          if (!btn) return;
          if (this.teach.playing) { ui.toast('回放中无法删除示教点', 'warn'); return; }
          const idx = Number(btn.dataset.delIndex);
          if (this.teach.removeAt(idx)) ui.log('已删除示教点 #' + (idx + 1), 'info');
        });
      }
      const stopBtn = $('btnStopPlayback');
      if (stopBtn) stopBtn.disabled = true;
    },

    onJointInput(input) {
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) {
        ui.syncJoints(this.robot.getJoints());
        return;
      }
      if (this.sprayDesired) {
        this.setSpray(false);
        ui.toast('检测到手动调整，喷涂已自动停止', 'warn');
      }
      const angles = ui.jointSliders.map((s) => U.clamp(Number(s.value), Number(s.min), Number(s.max)));
      this.robot.setJoints(angles);
      const tcp = this.robot.getTCP();
      const proj = this.spray.projectToSurface(tcp.position, tcp.direction, this.surface);
      ui.updateTelemetry({ joints: angles, tcp: tcp.position, distance: proj ? proj.distance : 0 });
      const hit = this.scene.checkCollision(this.robot.getSamplePoints(), 0.04);
      if (hit.hit) {
        this.robot.setJoints(this.lastSafeJoints);
        ui.syncJoints(this.lastSafeJoints);
        ui.toast('该姿态将触发' + hit.reason + '碰撞保护，已回退', 'error');
        return;
      }
      this.lastSafeJoints = angles.slice();
      ui.syncJoints(angles);
      ui.markPose('');
    },

    onPose(id) {
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) return;
      const pose = C.poses.filter((p) => p.id === id)[0];
      if (!pose) return;
      const target = pose.target.slice();
      let dir = pose.direction.slice();
      if (pose.id === 'wall') {
        if (C.isWallSurface(this.surface)) {
          const f = C.surfaceFrame(this.surface);
          const c = this.scene.surfacePoint(this.surface, 0, 1.55, 0);
          target[0] = c.x + f.normal[0] * 0.34;
          target[1] = 1.55;
          target[2] = c.z + f.normal[2] * 0.34;
          dir = [-f.normal[0], -f.normal[1], -f.normal[2]];
        } else {
          target[2] = C.room.wallZ + 0.34;
        }
      } else if (pose.id === 'ceiling') {
        target[1] = C.room.height - 0.34;
      } else if (pose.id === 'home') {
        const b = this.robot.getBasePose();
        target[0] = b.x + 0.4;
        target[2] = b.z - 1.15;
      } else if (pose.id === 'corner' && C.room.pilaster) {
        const pin = C.room.pilaster;
        target[0] = pin.x - pin.w / 2 - 0.5;
        target[1] = 1.55;
        target[2] = pin.z + pin.d / 2 + 0.5;
      }
      const sol = this.robot.solveIK(
        new THREE.Vector3(target[0], target[1], target[2]),
        new THREE.Vector3(dir[0], dir[1], dir[2]),
        this.robot.getJoints()
      );
      if (!sol) { ui.toast('该姿态无逆解', 'error'); return; }
      if (!sol.reachable) {
        ui.toast('目标位姿超出工作空间（位置误差 ' + (sol.posError * 1000).toFixed(0) + ' mm），已按可达位置规划', 'warn');
        ui.log('快捷姿态「' + pose.name + '」不可完全达，位置误差 ' + (sol.posError * 1000).toFixed(0) + ' mm', 'warn');
      }
      this.setSpray(false);
      const from = this.robot.getJoints();
      let max = 0;
      sol.angles.forEach((v, i) => { max = Math.max(max, Math.abs(U.norm180(v - from[i]))); });
      this.motion = {
        from, to: sol.angles.slice(), t: 0, dur: U.clamp(max / 55, 0.55, 2.8),
        pose: pose.id, name: pose.name, collisionClock: 0, syncClock: 0
      };
      this.state = 'moving';
      ui.setStatus('moving', '正在切换至「' + pose.name + '」');
      ui.setInterlock(true, '姿态切换中');
      ui.markPose(pose.id);
      ui.log('执行快捷姿态：' + pose.name, 'info');
    },

    updateMotion(dt) {
      const m = this.motion;
      if (!m) return;
      const ui = SB.UI;
      m.t += dt;
      const k = U.clamp(m.t / m.dur, 0, 1);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const angles = U.lerpJoints(m.from, m.to, e);
      this.robot.setJoints(angles);
      m.syncClock += dt;
      if (m.syncClock > 0.1) {
        m.syncClock = 0;
        ui.syncJoints(angles);
      }
      m.collisionClock += dt;
      if (m.collisionClock > 0.15) {
        m.collisionClock = 0;
        const hit = this.scene.checkCollision(this.robot.getSamplePoints(), 0.03);
        if (hit.hit && k < 0.98) {
          this.motion = null;
          this.robot.setJoints(this.lastSafeJoints);
          ui.syncJoints(this.lastSafeJoints);
          this.state = 'ready';
          ui.setStatus('ready', '姿态切换已中止');
          ui.setInterlock(false);
          ui.setPathButtons({ hasPath: !!this.path, hasSelection: !!this.selection, running: false });
          ui.toast('运动路径接近' + hit.reason + '，已中止', 'error');
          ui.markPose('');
          return;
        }
      }
      if (k >= 1) {
        const done = m.onDone;
        this.motion = null;
        this.lastSafeJoints = this.robot.getJoints();
        ui.syncJoints(this.lastSafeJoints);
        if (done) { done(); return; }
        this.state = 'ready';
        ui.setStatus('ready', '已到达「' + m.name + '」');
        ui.setInterlock(false);
        ui.setPathButtons({ hasPath: !!this.path, hasSelection: !!this.selection, running: false });
        ui.markPose(m.pose);
        ui.log('已到达快捷姿态：' + m.name, 'ok');
      }
    },
    setTool(id) {
      if (SB.Tools) SB.Tools.setActive(id);
    },

    toggleFollow() {
      if (this.scene) this.scene.setFollow(!this.scene.follow);
    },

    toolVerb() { return SB.Tools ? SB.Tools.verb() : '喷涂'; },
    toolName() { return SB.Tools ? SB.Tools.name() : '喷涂枪'; },
    toolUsesMaterial() { return SB.Tools ? SB.Tools.usesMaterial() : true; },

    setSpray(on, silent) {
      const ui = SB.UI;
      const want = !!on;
      const was = this.sprayDesired;
      if (want && this.isLocked()) return;
      if (want && this.toolUsesMaterial() && this.spray.tank <= 0.2) {
        ui.toast('料桶已空，请先补充涂料', 'warn');
        return;
      }
      this.sprayDesired = want;
      ui.setSprayOn(want);
      if (want) {
        if (this.state === 'ready') {
          this.state = 'spraying';
          ui.setStatus('spraying', this.toolVerb() + '作业中');
        }
        if (!silent && !was) ui.log(this.toolVerb() + '已开启 · ' + C.materials[this.materialId].name, 'ok');
      } else {
        this.spray.sprayOn = false;
        if (this.state === 'spraying') {
          this.state = 'ready';
          ui.setStatus('ready', this.toolVerb() + '已停止');
        }
        if (!silent && was) ui.log(this.toolVerb() + '已停止', 'info');
      }
    },

    onMaterial(id) {
      const mat = C.materials[id];
      if (!mat) return;
      if (this.resumeState && this.resumeState.materialId !== id) this.clearResume();
      this.materialId = id;
      this.params = U.clone(mat.defaults);
      SB.UI.setParams(this.params, id);
      this.spray.setMaterial(id);
      this.setInventoryTank(id);
      if (this.adaptive) this.applyAdaptive(true);
      else this.saveParams();
      this.saveInventory();
      if (this.isInventoryOpen()) SB.UI.refreshInventory(this.inventoryData());
      if (SB.Nozzle && this.nozzleOn) {
        SB.Nozzle.setParams(this.params, id);
        SB.Nozzle.setHud(this.adaptive, id, this.params);
        SB.Nozzle.resetFilm();
      }
      SB.UI.log('涂料切换为「' + (mat.code ? mat.code + ' ' : '') + mat.name + '」' +
        (this.adaptive ? '，已按自适应匹配参数' : '，已载入推荐参数'), 'info');
    },

    onParam(key) {
      const p = SB.UI.paramEls[key];
      if (!p) return;
      this.setParamValue(key, Number(p.input.value));
    },

    setParamValue(key, value) {
      const meta = C.params[key];
      if (!meta) return;
      const num = U.clamp(Number(value), meta.min, meta.max);
      this.params[key] = num;
      const p = SB.UI.paramEls[key];
      if (p) {
        p.input.value = num;
        SB.UI.updateSliderFill(p.input);
        SB.UI.renderParamValue(key, num);
        SB.UI.validateParam(key, num, this.materialId);
      }
      if (this.adaptive) this.setAdaptive(false, true);
      if (SB.Nozzle) SB.Nozzle.setParams(this.params, this.materialId);
      this.saveParams();
      SB.UI.updateTakeLive({ params: this.params });
    },

    setAdaptive(on, silent) {
      const ui = SB.UI;
      this.adaptive = !!on;
      ui.setAdaptiveUI(this.adaptive);
      if (this.adaptive) {
        this.applyAdaptive(true);
        if (!silent) {
          ui.toast('自适应工艺已开启，参数按涂层与选区自动匹配', 'ok');
          ui.log('自适应工艺已开启 · ' + C.materials[this.materialId].name, 'ok');
        }
      } else {
        ui.setAdaptiveHint('关闭时使用手动参数；开启后按涂层与选区自动匹配压力、扇幅、膜厚与走枪速度。');
        if (!silent) {
          ui.toast('已切换为手动参数', 'info');
          ui.log('已切换为手动工艺参数', 'info');
        }
      }
    },

    applyAdaptive(silent) {
      if (!this.adaptive) return;
      const mat = C.materials[this.materialId];
      if (!mat) return;
      const d = mat.defaults;
      const r = mat.range;
      const p = {
        pressure: d.pressure,
        speed: d.speed,
        fanWidth: d.fanWidth,
        distance: d.distance,
        thickness: d.thickness
      };
      const visc = mat.props && mat.props.viscosity ? mat.props.viscosity : 40;
      p.pressure = U.clamp(d.pressure * (1 + (visc - 40) * 0.0015), r.pressure[0], r.pressure[1]);
      const sel = this.selection;
      const area = sel ? (sel.maxX - sel.minX) * (sel.maxY - sel.minY) : this.spray.targetArea;
      if (sel) {
        const w = sel.maxX - sel.minX;
        const h = sel.maxY - sel.minY;
        const narrow = Math.min(w, h);
        p.fanWidth = U.clamp(Math.min(d.fanWidth, Math.max(0.12, narrow * 0.6)), r.fanWidth[0], r.fanWidth[1]);
        const k = U.clamp(Math.sqrt(area / 2.85), 0.92, 1.12);
        p.speed = U.clamp(d.speed * k, r.speed[0], r.speed[1]);
      }
      this.params = p;
      SB.UI.setParams(p, this.materialId);
      this.spray.setMaterial(this.materialId);
      if (SB.Nozzle) SB.Nozzle.setParams(p, this.materialId);
      this.saveParams();
      const hint = '已匹配 ' + (mat.code || '') + '：压力 ' + U.fmt(p.pressure, 2) + ' MPa · 扇幅 ' +
        U.fmt(p.fanWidth, 2) + ' m · 单道湿膜 ' + U.fmt(p.thickness, 0) + ' µm · 速度 ' +
        U.fmt(p.speed, 2) + ' m/s · 选区 ' + U.fmt(area, 2) + ' ㎡';
      SB.UI.setAdaptiveHint(hint);
      if (SB.Nozzle && this.nozzleOn) {
        SB.Nozzle.setHud(true, this.materialId, p);
        SB.Nozzle.resetFilm();
      }
      if (!silent) {
        SB.UI.toast('自适应参数已匹配 ' + (mat.code || mat.name), 'ok');
        SB.UI.log('自适应匹配：' + hint.replace(/^已匹配 [^：]*：/, ''), 'ok');
      }
    },

    applyDefaults() {
      const mat = C.materials[this.materialId];
      if (!mat) return;
      if (this.adaptive) this.setAdaptive(false, true);
      this.params = U.clone(mat.defaults);
      SB.UI.setParams(this.params, this.materialId);
      this.spray.setMaterial(this.materialId);
      if (SB.Nozzle) {
        SB.Nozzle.setParams(this.params, this.materialId);
        SB.Nozzle.setHud(false, this.materialId, this.params);
        SB.Nozzle.resetFilm();
      }
      this.saveParams();
      SB.UI.toast('已套用 ' + (mat.code || '') + ' 推荐参数', 'ok');
      SB.UI.log('套用推荐参数：' + mat.name, 'info');
    },

    buildSceneSelect() {
      const sel = $('sceneSelect');
      if (!sel) return;
      sel.innerHTML = C.scenes.map((s) =>
        '<option value="' + s.id + '">' + U.escapeHTML(s.name) + '</option>'
      ).join('');
      sel.value = C.currentScene;
    },

    surfaceName(s) {
      if (s === 'ceiling') return '天花板';
      if (s === 'floor') return '地面';
      return C.wallNames[s] || '墙面';
    },

    emptySelectionText() {
      return '未选择区域 · 请框选' + this.surfaceName(this.surface);
    },

    setSurfaceUI(s) {
      document.querySelectorAll('.surface-switch [data-surface]').forEach((b) => {
        b.classList.toggle('active', b.dataset.surface === s);
      });
    },

    setSurface(kind) {
      if (!kind || kind === this.surface) return;
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) {
        ui.toast('任务执行中，请先停止后再切换作业面', 'warn');
        return;
      }
      this.surface = kind;
      this.scene.surface = kind;
      this.selection = null;
      this.scene.clearPlanning(true);
      this.path = null;
      this.pathCum = null;
      this.pathDir = null;
      this.pathLength = 0;
      this.pathJointDur = null;
      this.pathBase = null;
      this.pathRoute = null;
      this.pathJobs = null;
      this.jobIndex = 0;
      this.jobOffset = 0;
      this.taskTotalLength = 0;
      this.roomTask = null;
      this._roomMode = false;
      this.spray.setSurface(kind);
      this.spray.setTargetRect(null, kind);
      this.scene.setView(kind);
      this.setSurfaceUI(kind);
      ui.setPathButtons({ hasPath: false, hasSelection: false, running: false });
      ui.setSelectInfo(this.emptySelectionText());
      if (this.adaptive) this.applyAdaptive(true);
      ui.log('作业面切换为「' + this.surfaceName(kind) + '」', 'info');
    },

    switchScene(id) {
      if (!id || id === C.currentScene) return;
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) {
        ui.toast('任务执行中，无法切换场景', 'warn');
        const sel = $('sceneSelect');
        if (sel) sel.value = C.currentScene;
        return;
      }
      if (this.nozzleOn) this.setNozzleView(false);
      this.selectionMode = false;
      ui.setSelectionActive(false);
      this.scene.controls.enabled = true;
      const scene = C.applyScene(id);
      this.scene.currentScene = id;
      this.scene.buildRoom();
      this.scene.setTheme(this.settings.theme);
      this.scene.clearPlanning(true);
      this.selection = null;
      this.path = null;
      this.pathCum = null;
      this.pathDir = null;
      this.pathLength = 0;
      this.pathJointDur = null;
      this.pathBase = null;
      this.pathRoute = null;
      this.pathJobs = null;
      this.jobIndex = 0;
      this.jobOffset = 0;
      this.taskTotalLength = 0;
      this.roomTask = null;
      this._roomMode = false;
      this.baseDrive = null;
      this.clearResume();
      this.spray.rebuild();
      this.syncInventoryFromTank();
      this.surface = 'wall';
      this.scene.surface = 'wall';
      this.spray.setSurface('wall');
      this.spray.setTargetRect(null, 'wall');
      this.robot.setBasePose(scene.start.x, scene.start.z, scene.start.yaw);
      this.robot.setJoints(this.robot.computeHomeJoints());
      this.lastSafeJoints = this.robot.getJoints();
      ui.syncJoints(this.lastSafeJoints);
      this.spray.resetTask();
      this.taskTime = 0;
      const keepFollow = this.scene.follow;
      this.scene.setView('overview', true);
      if (keepFollow) this.scene.setFollow(true, true);
      this.setSurfaceUI('wall');
      ui.setTank(100);
      ui.setTimer(0);
      ui.updateTelemetry({ area: 0, coverage: 0, consumption: 0, distance: 0 });
      ui.setPathButtons({ hasPath: false, hasSelection: false, running: false });
      ui.setSelectInfo(this.emptySelectionText());
      ui.hideAlert();
      ui.markPose('');
      this.onMaterial(scene.coating);
      ui.log('切换喷涂场景：' + scene.name + ' · ' + scene.desc, 'ok');
      ui.toast('已切换到「' + scene.name + '」', 'ok');
    },

    setNozzleView(on) {
      const want = !!on;
      if (want && SB.Tools && SB.Tools.active !== 'spray') {
        SB.Tools.setActive('spray');
        if (SB.Tools.active !== 'spray') return;
      }
      this.nozzleOn = want;
      const stage = $('nozzleStage');
      const panel = $('canvasPanel');
      if (stage) stage.classList.toggle('hidden', !want);
      if (panel) panel.classList.toggle('nozzle-mode', want);
      if (SB.Nozzle) {
        SB.Nozzle.setVisible(want);
        if (want) {
          SB.Nozzle.setParams(this.params, this.materialId);
          SB.Nozzle.setHud(this.adaptive, this.materialId, this.params);
          SB.Nozzle.resetFilm();
        }
      }
      if (want) {
        SB.UI.setAdaptiveUI(this.adaptive);
        SB.UI.log('已切换到喷嘴特写 · ' + C.materials[this.materialId].name, 'info');
      }
    },

    onTemplate(id) {
      const t = C.templates.filter((x) => x.id === id)[0];
      if (!t) return;
      if (this.adaptive) this.setAdaptive(false, true);
      this.syncInventoryFromTank();
      this.materialId = t.material;
      this.params = U.clone(t.params);
      SB.UI.setParams(this.params, t.material);
      this.spray.setMaterial(t.material);
      this.setInventoryTank(t.material);
      if (SB.Nozzle) {
        SB.Nozzle.setParams(this.params, this.materialId);
        SB.Nozzle.setHud(false, this.materialId, this.params);
        SB.Nozzle.resetFilm();
      }
      this.saveParams();
      this.saveInventory();
      if (this.isInventoryOpen()) SB.UI.refreshInventory(this.inventoryData());
      SB.UI.toast('已应用工艺模板「' + t.name + '」', 'ok');
      SB.UI.log('应用工艺模板：' + t.name + '（' + C.materials[t.material].name + '）', 'ok');
    },

    async loadGLBFile(file) {
      if (!file) return;
      const ui = SB.UI;
      ui.setModelStatus('正在载入 ' + file.name + ' …', false);
      try {
        const info = await this.robot.loadGLB(file);
        this.robot.custom.group.visible = this.settings.layers.arm;
        ui.setModelStatus('当前模型：' + info.fileName + '（J1–J6 匹配 ' + info.joints + '/6）', false);
        ui.toast('自定义 GLB 模型已载入', 'ok');
        ui.log('载入 GLB 模型：' + info.fileName + '，关节匹配 ' + info.joints + '/6', 'ok');
      } catch (err) {
        ui.setModelStatus('模型载入失败：' + (err.message || err), true);
        ui.toast('GLB 载入失败：' + (err.message || err), 'error');
        ui.log('GLB 载入失败：' + (err.message || err), 'error');
      }
      const input = $('glbFile');
      if (input) input.value = '';
    },

    resetModel() {
      this.robot.resetModel();
      SB.UI.setModelStatus('当前模型：内置六轴工业机械臂', false);
      SB.UI.log('已恢复内置六轴机械臂模型', 'info');
    },

    async clearWall() {
      const ui = SB.UI;
      const ok = await ui.confirm('清除表面涂层', '将清空墙面、天花板与地面的涂层及覆盖率统计，料桶余量保持不变。是否继续？', true);
      if (!ok) return;
      this.spray.clearWall();
      this.taskTime = 0;
      ui.setTimer(0);
      ui.updateTelemetry({ area: 0, coverage: 0, consumption: this.spray.consumption });
      ui.log('表面涂层已清除', 'info');
      ui.toast('表面涂层已清除', 'ok');
    },

    async resetAll() {
      const ui = SB.UI;
      const ok = await ui.confirm('恢复初始状态', '将停止所有动作，并清除涂层、选区、路径、示教点与工艺参数。是否继续？', true);
      if (!ok) return;
      this.stopAll();
      this.roomTask = null;
      this._roomMode = false;
      this.selectionMode = false;
      ui.setSelectionActive(false);
      this.scene.controls.enabled = true;
      this.scene.clearPlanning(true);
      this.clearResume();
      this.selection = null;
      this.path = null;
      this.pathCum = null;
      this.pathLength = 0;
      this.teach.clear();
      this.syncInventoryFromTank();
      this.spray.resetTask();
      const scene = C.getScene(C.currentScene);
      this.surface = 'wall';
      this.scene.surface = 'wall';
      this.spray.setSurface('wall');
      this.spray.setTargetRect(null, 'wall');
      this.setSurfaceUI('wall');
      this.robot.setBasePose(scene.start.x, scene.start.z, scene.start.yaw);
      this.robot.setJoints(this.robot.computeHomeJoints());
      this.lastSafeJoints = this.robot.getJoints();
      ui.syncJoints(this.lastSafeJoints);
      this.pathBase = null;
      this.pathRoute = null;
      this.taskTime = 0;
      this.materialId = scene.coating;
      this.params = U.clone(C.materials[scene.coating].defaults);
      ui.setParams(this.params, scene.coating);
      this.spray.setMaterial(scene.coating);
      this.setInventoryTank(scene.coating);
      this.setAdaptive(false, true);
      if (SB.Nozzle) {
        SB.Nozzle.setParams(this.params, this.materialId);
        SB.Nozzle.setHud(false, this.materialId, this.params);
        SB.Nozzle.resetFilm();
      }
      this.saveParams();
      ui.setTank(this.spray.tank);
      ui.setTimer(0);
      ui.setSelectInfo(this.emptySelectionText());
      ui.setStatus('ready', '系统就绪');
      ui.setInterlock(false);
      ui.setPathButtons({ hasPath: false, hasSelection: false, running: false });
      ui.hideAlert();
      ui.markPose('home');
      ui.log('系统已恢复初始状态', 'ok');
      ui.toast('已恢复初始状态', 'ok');
    },
    toggleSelectionMode(force) {
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) return;
      const want = force == null ? !this.selectionMode : !!force;
      this.selectionMode = want;
      this.scene.controls.enabled = !want;
      ui.setSelectionActive(want);
      if (want) {
        const name = this.surfaceName(this.surface);
        ui.setSelectInfo('按住左键在' + name + '上拖拽框选');
        ui.toast('框选模式：在' + name + '上拖拽出矩形区域', 'info');
      } else {
        ui.setSelectInfo(this.selection ? this.selectionInfo() : this.emptySelectionText());
      }
    },

    selectionInfo() {
      if (!this.selection) return '未选择区域';
      const w = this.selection.maxX - this.selection.minX;
      const h = this.selection.maxY - this.selection.minY;
      const name = this.surfaceName(this.selection.surface || this.surface);
      return name + '选区 ' + w.toFixed(2) + ' × ' + h.toFixed(2) + ' m · ' + (w * h).toFixed(2) + ' ㎡';
    },

    onPointerDown(e) {
      if (!this.selectionMode || this.isLocked() || e.button !== 0) return;
      const hit = this.scene.raycastSurface(e.clientX, e.clientY, this.surface);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      this.drag = { sx: hit.x, sy: hit.y, rect: null, pointerId: e.pointerId };
      this.scene.controls.enabled = false;
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      SB.UI.setSelectInfo('拖拽框选中…');
    },

    onPointerMove(e) {
      if (!this.drag) return;
      const hit = this.scene.raycastSurface(e.clientX, e.clientY, this.surface);
      if (!hit) return;
      const rect = {
        minX: Math.min(this.drag.sx, hit.x),
        maxX: Math.max(this.drag.sx, hit.x),
        minY: Math.min(this.drag.sy, hit.y),
        maxY: Math.max(this.drag.sy, hit.y)
      };
      this.drag.rect = rect;
      const set = this.scene.setSelection(rect, this.surface);
      if (set) {
        SB.UI.setSelectInfo((set.maxX - set.minX).toFixed(2) + ' × ' + (set.maxY - set.minY).toFixed(2) + ' m');
      }
    },

    onPointerUp() {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      this.scene.controls.enabled = true;
      this.selectionMode = false;
      SB.UI.setSelectionActive(false);
      const ui = SB.UI;
      const rect = d.rect;
      if (!rect || rect.maxX - rect.minX < 0.12 || rect.maxY - rect.minY < 0.12) {
        if (this.selection) this.scene.setSelection(this.selection, this.selection.surface);
        ui.setSelectInfo(this.selection ? this.selectionInfo() : this.emptySelectionText());
        ui.toast('框选区域过小，请重新拖拽', 'warn');
        return;
      }
      const final = this.scene.setSelection(rect, this.surface);
      if (!final) {
        ui.toast('框选区域无效，请重试', 'warn');
        return;
      }
      this.selection = final;
      this.spray.setTargetRect(final, this.surface);
      if (this.adaptive) this.applyAdaptive(true);
      else SB.UI.updateTakeLive({ params: this.params });
      this.path = null;
      this.pathCum = null;
      this.pathLength = 0;
      this.pathJobs = null;
      this.jobIndex = 0;
      this.jobOffset = 0;
      this.taskTotalLength = 0;
      this.scene.clearPlanning(false);
      ui.setPathButtons({ hasPath: false, hasSelection: true, running: false });
      ui.setSelectInfo(this.selectionInfo());
      ui.log('已框选作业面：' + this.selectionInfo(), 'ok');
      if (U.isMobile()) ui.setMobileView('motion');
    },
    baseYawFor(x, z, surface, cu, cv) {
      if (!C.isWallSurface(surface)) {
        // 天花板/地面：底盘朝向房间中心，避免转运时机械臂伸向最近的墙面
        const d = Math.hypot(x, z);
        if (d < 0.25) return C.robot.yawOffset;
        return Math.atan2(-x, -z);
      }
      const p = this.scene.surfacePoint(surface, cu, cv, 0);
      const dx = p.x - x, dz = p.z - z;
      if (Math.hypot(dx, dz) < 0.15) return C.robot.yawOffset;
      return Math.atan2(dx, dz);
    },

    baseCandidates(surface, sel) {
      const R = C.room;
      const cu = (sel.minX + sel.maxX) / 2;
      const cv = (sel.minY + sel.maxY) / 2;
      const cur = this.robot.getBasePose();
      const out = [];
      const push = (x, z) => {
        x = U.clamp(x, -R.width / 2 + 0.9, R.width / 2 - 0.9);
        z = U.clamp(z, -R.depth / 2 + 0.9, R.depth / 2 - 0.9);
        if (!this.scene.checkBaseAt(x, z, 0.66)) return;
        if (surface === 'floor' && x > sel.minX - 0.55 && x < sel.maxX + 0.55 &&
          z > sel.minY - 0.55 && z < sel.maxY + 0.55) return;
        const yaw = this.baseYawFor(x, z, surface, cu, cv);
        if (out.some((c) => Math.hypot(c.x - x, c.z - z) < 0.25)) return;
        out.push({ x: x, z: z, yaw: yaw });
      };
      const f = C.surfaceFrame(surface);
      if (f.isWall) {
        const c = this.scene.surfacePoint(surface, cu, cv, 0);
        const n = f.normal, u = f.uDir;
        push(c.x + n[0] * 1.25, c.z + n[2] * 1.25);
        push(c.x + n[0] * 1.65, c.z + n[2] * 1.65);
        push(c.x + n[0] * 2.25, c.z + n[2] * 2.25);
        push(c.x + n[0] * 1.85 + u[0] * 0.95, c.z + n[2] * 1.85 + u[2] * 0.95);
        push(c.x + n[0] * 1.85 - u[0] * 0.95, c.z + n[2] * 1.85 - u[2] * 0.95);
        push(cur.x, cur.z);
      } else if (surface === 'ceiling') {
        push(cu, cv);
        push(cu - 0.9, cv);
        push(cu + 0.9, cv);
        push(cu, cv - 0.9);
        push(cu, cv + 0.9);
      } else {
        push(cu, cv + 1.15);
        push(cu, cv - 1.15);
        push(cu + 1.15, cv);
        push(cu - 1.15, cv);
        push(cu, cv + 1.55);
        push(cu, cv - 1.55);
      }
      return out;
    },

    baseRoute(from, to) {
      const margin = 0.66;
      if (this.scene.checkBaseRoute(from, to, margin)) {
        return [{ x: from.x, z: from.z, yaw: from.yaw }, { x: to.x, z: to.z, yaw: to.yaw }];
      }
      const R = C.room;
      const vias = [{ x: 0, z: 0 }];
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          vias.push({ x: i * R.width * 0.24, z: j * R.depth * 0.24 });
        }
      }
      for (let i = 0; i < vias.length; i++) {
        const via = vias[i];
        if (Math.hypot(via.x - from.x, via.z - from.z) < 0.35) continue;
        if (Math.hypot(via.x - to.x, via.z - to.z) < 0.35) continue;
        if (!this.scene.checkBaseAt(via.x, via.z, margin)) continue;
        if (!this.scene.checkBaseRoute(from, via, margin)) continue;
        if (!this.scene.checkBaseRoute(via, to, margin)) continue;
        return [
          { x: from.x, z: from.z, yaw: from.yaw },
          { x: via.x, z: via.z, yaw: Math.atan2(to.x - via.x, to.z - via.z) },
          { x: to.x, z: to.z, yaw: to.yaw }
        ];
      }
      return null;
    },

    routeLength(route) {
      if (!route || route.length < 2) return 0;
      let len = 0;
      for (let i = 1; i < route.length; i++) {
        len += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
      }
      return len;
    },

    // 大选区拆分为多个可作业分区（墙面沿长度方向；天花板/地面同时按两个方向拆分）
    splitPanels(surface, sel, maxSpan) {
      const f = C.surfaceFrame(surface);
      const spanU = sel.maxX - sel.minX;
      const spanV = sel.maxY - sel.minY;
      const nU = Math.max(1, Math.ceil((spanU - 0.02) / maxSpan));
      const nV = f.isWall ? 1 : Math.max(1, Math.ceil((spanV - 0.02) / maxSpan));
      if (nU <= 1 && nV <= 1) return [sel];
      const ovU = Math.min(0.18, (spanU / nU) * 0.12);
      const ovV = Math.min(0.18, (spanV / nV) * 0.12);
      const panels = [];
      for (let j = 0; j < nV; j++) {
        let v0 = sel.minY + spanV * j / nV;
        let v1 = sel.minY + spanV * (j + 1) / nV;
        if (j > 0) v0 -= ovV;
        if (j < nV - 1) v1 += ovV;
        v0 = U.clamp(v0, f.vMin + 0.03, f.vMax - 0.03);
        v1 = U.clamp(v1, f.vMin + 0.03, f.vMax - 0.03);
        if (v1 - v0 < 0.2) continue;
        for (let i = 0; i < nU; i++) {
          let u0 = sel.minX + spanU * i / nU;
          let u1 = sel.minX + spanU * (i + 1) / nU;
          if (i > 0) u0 -= ovU;
          if (i < nU - 1) u1 += ovU;
          u0 = U.clamp(u0, -f.width / 2 + 0.03, f.width / 2 - 0.03);
          u1 = U.clamp(u1, -f.width / 2 + 0.03, f.width / 2 - 0.03);
          if (u1 - u0 < 0.2) continue;
          panels.push({ surface: surface, minX: u0, maxX: u1, minY: v0, maxY: v1 });
        }
      }
      return panels.length ? panels : [sel];
    },

    applyJob(index) {
      const jobs = this.pathJobs || [];
      const job = jobs[index];
      if (!job) return;
      this.jobIndex = index;
      this.path = job.path;
      this.pathCum = job.cum;
      this.pathJointDur = job.jointDur;
      this.pathLength = job.length;
      this.pathBase = job.base;
      this.pathRoute = job.route;
      this.pathBranch = job.branch;
      this.pathDir = this.scene.surfaceNormal(job.surface);
      let offset = 0;
      for (let i = 0; i < index; i++) offset += jobs[i].length;
      this.jobOffset = offset;
    },

    jobTime(job, speed) {
      if (!job || !job.path || job.path.length < 2) return 0;
      const v = Math.max(0.05, speed || 0.5);
      let total = 0;
      for (let i = 1; i < job.path.length; i++) {
        const segLen = Math.max(1e-4, job.cum[i] - job.cum[i - 1]);
        total += Math.max(1e-4, segLen / v, job.jointDur[i] || 0);
      }
      return total;
    },

    buildPath() {
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) return;
      if (!this.selection) {
        ui.toast('请先在' + this.surfaceName(this.surface) + '上框选作业区域', 'warn');
        return;
      }
      const p = this.params;
      const sel = this.selection;
      const surface = sel.surface || this.surface;
      const savedBase = this.robot.getBasePose();
      const startJoints = this.robot.getJoints().slice();
      // 规划期间会临时把底盘/关节移到各候选位姿，结束后必须恢复到用户当前位姿
      const restorePose = () => {
        this.robot.setBasePose(savedBase.x, savedBase.z, savedBase.yaw);
        this.robot.setJoints(startJoints);
        this.lastSafeJoints = startJoints.slice();
      };
      const single = this.planRect(surface, sel, savedBase, startJoints);
      let jobs = [];
      let panelized = false;
      if (single && single.unreachable <= 8) {
        jobs = [single];
      } else {
        // 选区超出单点作业范围时，沿墙面长度方向分成多个分区，
        // 每个分区由底盘重新定位后再用机械臂全伸喷涂
        const maxSpan = C.isWallSurface(surface)
          ? (this._roomMode ? 1.6 : 2.6)
          : (this._roomMode ? 2.0 : 2.4);
        const panels = this.splitPanels(surface, sel, maxSpan);
        if (panels.length > 1) {
          let from = savedBase;
          const list = [];
          panels.forEach((panel) => {
            const job = this.planRect(surface, panel, from, startJoints);
            if (!job) return;
            list.push(job);
            from = job.base;
          });
          if (list.length === panels.length) {
            const bad = list.reduce((s, j) => s + j.unreachable, 0);
            if (!single || bad < single.unreachable) {
              jobs = list;
              panelized = true;
            }
          }
        }
        if (!jobs.length && single) jobs = [single];
      }
      if (!jobs.length) {
        restorePose();
        ui.toast('无法生成有效路径，请扩大选区或调整喷涂距离', 'error');
        return;
      }
      this.pathJobs = jobs;
      this.taskTotalLength = jobs.reduce((s, j) => s + j.length, 0);
      this.applyJob(0);
      restorePose();
      this.scene.showPaths(jobs.map((j) => j.path));
      this.clearResume();
      ui.setPathButtons({ hasPath: true, hasSelection: true, running: false });
      const points = jobs.reduce((s, j) => s + j.path.length, 0);
      const driveDist = jobs.reduce((s, j) => s + this.routeLength(j.route), 0);
      let est = driveDist / C.baseSpeed;
      jobs.forEach((j) => { est += this.jobTime(j, p.speed); });
      ui.setSelectInfo('路径 ' + points + ' 点 · ' + this.taskTotalLength.toFixed(1) + ' m' +
        (panelized ? ' · ' + jobs.length + ' 分区' : '') + ' · 底盘 ' + driveDist.toFixed(1) +
        ' m · 预计 ' + U.fmtTime(est));
      ui.log('S 形路径生成：' + this.surfaceName(surface) + ' ' + points + ' 点，总长 ' +
        this.taskTotalLength.toFixed(2) + ' m，行距 ' + Math.max(0.05, (p.fanWidth || 0.3) * 0.5).toFixed(3) +
        ' m' + (panelized ? '，分 ' + jobs.length + ' 个分区' : ''), 'ok');
      const unreachable = jobs.reduce((s, j) => s + j.unreachable, 0);
      if (unreachable > 0) {
        if (this._roomMode) {
          ui.log('全屋喷涂 · ' + this.surfaceName(surface) + ' 有 ' + unreachable +
            ' 个路径点超出可达范围，将按最近可达位置作业', 'warn');
        } else {
          ui.toast('部分路径点超出可达范围（' + unreachable + '/' + points + '），可能影响覆盖', 'warn');
          ui.log('路径中有 ' + unreachable + ' 个点不可完全达', 'warn');
        }
      } else if (!this._roomMode) {
        ui.toast('路径已生成，点击「开始' + (SB.Tools ? SB.Tools.current().short : '喷涂') + '」底盘将自动前往作业面', 'ok');
      }
    },

    // 以给定底盘位姿为起点，为单个矩形选区规划 S 形路径
    planRect(surface, sel, fromBase, startJoints) {
      const p = this.params;
      const fan = U.clamp(p.fanWidth || 0.3, 0.1, 0.6);
      // 行距取半扇幅，相邻行程重叠 50%，避免行间出现漏喷条纹
      const gap = Math.max(0.05, fan * 0.5);
      // 路径仅外扩极小余量：喷枪中心贴近选区边界，四角可获得完整雾化覆盖，
      // 同时避免因外扩过多导致边界点超出机械臂可达范围
      const overshoot = Math.min(0.04, fan * 0.12);
      const sf = C.surfaceFrame(surface);
      const halfU = sf.width / 2;
      const vLimit = { min: sf.vMin + 0.08, max: sf.vMax - 0.08 };
      let minU = U.clamp(sel.minX - overshoot, -halfU + 0.02, halfU - 0.02);
      let maxU = U.clamp(sel.maxX + overshoot, -halfU + 0.02, halfU - 0.02);
      let minV = U.clamp(sel.minY - overshoot, vLimit.min, vLimit.max);
      let maxV = U.clamp(sel.maxY + overshoot, vLimit.min, vLimit.max);
      if (maxU - minU < 0.12) { minU = sel.minX; maxU = sel.maxX; }
      if (maxV - minV < 0.12) { minV = sel.minY; maxV = sel.maxY; }
      const distance = U.clamp(p.distance || 0.3, 0.14, 0.65);
      const rowCount = Math.max(1, Math.ceil((maxV - minV) / gap) + 1);
      const corners = [];
      for (let i = 0; i < rowCount; i++) {
        const v = rowCount === 1 ? (minV + maxV) / 2 : U.lerp(minV, maxV, i / (rowCount - 1));
        const ua = i % 2 === 0 ? minU : maxU;
        const ub = i % 2 === 0 ? maxU : minU;
        corners.push({ u: ua, v: v }, { u: ub, v: v });
      }
      const dense = [corners[0]];
      for (let i = 1; i < corners.length; i++) {
        const a = corners[i - 1], b = corners[i];
        const len = Math.hypot(b.u - a.u, b.v - a.v);
        const n = Math.max(1, Math.ceil(len / 0.02));
        const ts = [];
        for (let k = 1; k <= n; k++) ts.push(k / n);
        // 行线穿过中线 u=0 时腕部奇异区需要加密采样
        if (a.u * b.u < 0 && Math.abs(b.u - a.u) > 1e-6) {
          const t0 = (0 - a.u) / (b.u - a.u);
          const span = 0.05 / Math.max(1e-6, len);
          for (let d = -span; d <= span + 1e-9; d += Math.max(0.002, 0.004 / Math.max(1e-6, len))) {
            const t = t0 + d;
            if (t > 0 && t < 1) ts.push(t);
          }
        }
        ts.sort((p, q) => p - q);
        let last = 0;
        ts.forEach((t) => {
          if (t <= last + 1e-6) return;
          last = t;
          dense.push({ u: U.lerp(a.u, b.u, t), v: U.lerp(a.v, b.v, t) });
        });
      }

      const normal = this.scene.surfaceNormal(surface);
      if (this._roomMode && dense.length) {
        // 全屋任务在分区中心增加引入/引出点：从舒适位姿进入与退出，
        // 避免从房间角落或贴地位置开始/结束而引发接近碰撞
        const leadU = (minU + maxU) / 2;
        const leadV = sf.isWall
          ? U.clamp(1.5, minV, maxV)
          : U.clamp((minV + maxV) / 2 - 0.32, minV, maxV);
        const firstPt = dense[0];
        if (Math.hypot(firstPt.u - leadU, firstPt.v - leadV) > 0.12) dense.unshift({ u: leadU, v: leadV });
        const lastPt = dense[dense.length - 1];
        if (Math.hypot(lastPt.u - leadU, lastPt.v - leadV) > 0.12) dense.push({ u: leadU, v: leadV });
      }
      let candidates = this.baseCandidates(surface, sel);
      if (!candidates.length) candidates = [{ x: fromBase.x, z: fromBase.z, yaw: fromBase.yaw }];
      const jointJump = (a, b) => {
        let max = 0;
        for (let i = 0; i < 6; i++) max = Math.max(max, Math.abs(U.norm180(b[i] - a[i])));
        return max;
      };
      let bestOverall = null;
      const stats = [];

      candidates.forEach((cand) => {
        const route = this.baseRoute(fromBase, cand);
        if (!route) return;
        this.robot.setBasePose(cand.x, cand.z, cand.yaw);
        // 同一条连续路径固定肘部分支，分别求解后择优
        const buildForBranch = (branch) => {
          let preferred = startJoints;
          let unreachable = 0;
          let invalid = 0;
          let pathMax = 0;
          let pathSum = 0;
          let collisions = 0;
          const list = [];
          const collideStride = Math.max(1, Math.ceil(dense.length / 160));
          dense.forEach((q) => {
            const target = this.scene.surfacePoint(surface, q.u, q.v, distance);
            const sol = this.robot.solveIK(target, normal, preferred, branch);
            if (!sol) { invalid++; return; }
            if (!sol.reachable) unreachable++;
            if (list.length) {
              const jump = jointJump(preferred, sol.angles);
              pathMax = Math.max(pathMax, jump);
              pathSum += jump;
            }
            if (list.length % collideStride === 0) {
              this.robot.setJoints(sol.angles);
              if (this.scene.checkCollision(this.robot.getSamplePoints(), 0.04).hit) collisions++;
            }
            preferred = sol.angles;
            list.push({ u: q.u, v: q.v, surface: surface, angles: sol.angles });
          });
          this.robot.setJoints(startJoints);
          const cost = invalid * 1000 + unreachable * 50 + collisions * 20 + pathMax * 2 +
            (pathSum / Math.max(1, list.length - 1)) * 0.5;
          return { branch: branch, list: list, unreachable: unreachable + invalid, collisions: collisions, pathMax: pathMax, cost: cost };
        };
        const branches = [buildForBranch(1), buildForBranch(-1)]
          .filter((c) => c.list.length >= 2)
          .sort((a, b) => a.cost - b.cost);
        if (!branches.length) return;
        const best = branches[0];
        const total = best.cost + this.routeLength(route) * 5;
        stats.push({
          base: [Number(cand.x.toFixed(2)), Number(cand.z.toFixed(2))],
          branch: best.branch, points: best.list.length, unreachable: best.unreachable,
          collisions: best.collisions, cost: Number(total.toFixed(1))
        });
        if (!bestOverall || total < bestOverall.total) {
          bestOverall = { cand: cand, route: route, best: best, total: total };
        }
      });

      this.robot.setBasePose(fromBase.x, fromBase.z, fromBase.yaw);
      this.robot.setJoints(startJoints);
      this._lastBranchStats = stats;
      if (!bestOverall) return null;
      const list = bestOverall.best.list;
      const cum = [0];
      for (let i = 1; i < list.length; i++) {
        const du = list[i].u - list[i - 1].u;
        const dv = list[i].v - list[i - 1].v;
        cum.push(cum[i - 1] + Math.hypot(du, dv));
      }
      const jointDur = new Array(list.length).fill(0);
      for (let i = 1; i < list.length; i++) {
        let dur = 0;
        for (let k = 0; k < 6; k++) {
          const delta = Math.abs(U.norm180(list[i].angles[k] - list[i - 1].angles[k]));
          dur = Math.max(dur, delta / Math.max(1, C.robot.joints[k].speed || 90));
        }
        jointDur[i] = Math.min(2.5, dur);
      }
      return {
        surface: surface,
        path: list,
        cum: cum,
        jointDur: jointDur,
        length: cum[cum.length - 1],
        base: { x: bestOverall.cand.x, z: bestOverall.cand.z, yaw: bestOverall.cand.yaw },
        route: bestOverall.route,
        branch: bestOverall.best.branch,
        unreachable: bestOverall.best.unreachable,
        collisions: bestOverall.best.collisions
      };
    },

    estimatePathTime(speed) {
      if (!this.path || this.path.length < 2) return 0;
      const v = Math.max(0.05, speed || 0.5);
      let total = 0;
      for (let i = 1; i < this.path.length; i++) {
        const segLen = Math.max(1e-4, this.pathCum[i] - this.pathCum[i - 1]);
        const jointDur = (this.pathJointDur && this.pathJointDur[i]) || 0;
        total += Math.max(1e-4, segLen / v, jointDur);
      }
      return total;
    },

    clearPlanning(clearSelection) {
      const ui = SB.UI;
      if (this.roomTask) {
        this.roomTask = null;
        this._roomMode = false;
        ui.log('全屋喷涂任务已终止', 'warn');
      }
      if (this.baseDrive) {
        this.baseDrive = null;
      }
      if (this.pathRun) {
        if (!clearSelection) this.captureResumeState('手动停止');
        this.pathRun = null;
        this.setSpray(false, true);
        this.state = 'ready';
        ui.setStatus('ready', '作业任务已终止');
        ui.setInterlock(false);
      }
      if (clearSelection) this.clearResume();
      this.scene.clearPlanning(!!clearSelection);
      this.path = null;
      this.pathCum = null;
      this.pathDir = null;
      this.pathLength = 0;
      this.pathJointDur = null;
      this.pathBase = null;
      this.pathRoute = null;
      this.pathJobs = null;
      this.jobIndex = 0;
      this.jobOffset = 0;
      this.taskTotalLength = 0;
      if (clearSelection) {
        this.selection = null;
        this.spray.setTargetRect(null, this.surface);
        if (this.adaptive) this.applyAdaptive(true);
        ui.setSelectInfo(this.emptySelectionText());
      } else {
        ui.setSelectInfo(this.selection ? this.selectionInfo() : this.emptySelectionText());
      }
      ui.setPathButtons({ hasPath: false, hasSelection: !!this.selection, running: false });
      ui.log(clearSelection ? '已清除选区与路径' : '已清除路径', 'info');
    },
    // 检查一段关节空间直线运动是否全程无碰撞
    jointLineClear(from, to, steps) {
      const n = Math.max(2, steps || 24);
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        this.robot.setJoints(U.lerpJoints(from, to, u));
        if (this.scene.checkCollision(this.robot.getSamplePoints(), 0.03).hit) return false;
      }
      return true;
    },

    // 折叠/转运专用：同时检查环境碰撞与机械臂对机柜/底盘的自身碰撞
    foldLineClear(from, to, steps) {
      const n = Math.max(2, steps || 30);
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        this.robot.setJoints(U.lerpJoints(from, to, u));
        const pts = this.robot.getSamplePoints();
        if (this.scene.checkCollision(pts, 0.03).hit) return false;
        if (this.robot.bodyCollision(pts, 0.04).hit) return false;
      }
      return true;
    },

    // 从当前位形接近路径起点。直线接近若穿墙，则先沿法线退让再进入起点。
    planApproach(from, to) {
      const direct = [{ from: from.slice(), to: to.slice() }];
      if (this.jointLineClear(from, to, 26)) return direct;
      const start = this.path && this.path[0];
      if (!start) return direct;
      const dir = (this.pathDir || new THREE.Vector3(0, 0, -1)).clone().normalize();
      const surface = start.surface || this.surface;
      const pos = this.scene.surfacePoint(surface, start.u, start.v, U.clamp(this.params.distance || 0.3, 0.14, 0.65));
      const branches = [this.pathBranch];
      branches.push(this.pathBranch === 1 ? -1 : 1);
      const retracts = [0.3, 0.5, 0.8, 1.1, 1.45];
      const tryVia = (via) => {
        for (let b = 0; b < branches.length; b++) {
          const sol = this.robot.solveIK(via, dir, from, branches[b]);
          if (!sol || !sol.reachable) continue;
          if (!this.jointLineClear(from, sol.angles, 30)) continue;
          if (!this.jointLineClear(sol.angles, to, 30)) continue;
          this.robot.setJoints(from);
          return [
            { from: from.slice(), to: sol.angles.slice() },
            { from: sol.angles.slice(), to: to.slice() }
          ];
        }
        return null;
      };
      // 先在起点前方沿法线退让，尽量少绕路
      for (let i = 0; i < retracts.length; i++) {
        const found = tryVia(pos.clone().addScaledVector(dir, -retracts[i]));
        if (found) return found;
      }
      // 退让仍无法避障时，经房间中部的高位中转点绕行
      const R = C.room;
      const base = this.robot.getBasePose();
      const xs = [base.x, base.x - 0.55, base.x + 0.55, 0];
      const ys = [R.height * 0.5, R.height * 0.65, 1.4, 1.75];
      const zs = [base.z, base.z + 0.55, R.depth * 0.2, -R.depth * 0.1];
      for (let ix = 0; ix < xs.length; ix++) {
        for (let iy = 0; iy < ys.length; iy++) {
          for (let iz = 0; iz < zs.length; iz++) {
            const via = new THREE.Vector3(xs[ix], ys[iy], zs[iz]);
            if (via.distanceTo(pos) < 0.4) continue;
            const found = tryVia(via);
            if (found) return found;
          }
        }
      }
      this.robot.setJoints(from);
      return direct;
    },

    // 全屋喷涂：依次完成后墙、左墙、右墙、前墙、天花板
    roomSelection(surface) {
      const f = C.surfaceFrame(surface);
      if (f.isWall) {
        return { surface: surface, minX: -f.width / 2 + 0.12, maxX: f.width / 2 - 0.12, minY: 0.12, maxY: f.height - 0.12 };
      }
      return { surface: surface, minX: -f.width / 2 + 0.15, maxX: f.width / 2 - 0.15, minY: f.vMin + 0.15, maxY: f.vMax - 0.15 };
    },

    startRoomSpray() {
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) {
        ui.toast('作业进行中，请先停止后再开始全屋喷涂', 'warn');
        return;
      }
      if (SB.Tools && SB.Tools.active !== 'spray') {
        SB.Tools.setActive('spray', true);
        ui.log('全屋喷涂已切换为喷涂枪', 'info');
      }
      if (this.toolUsesMaterial() && this.spray.tank <= 1) {
        ui.toast('料桶余量不足，请先补充涂料', 'warn');
        return;
      }
      this.setSpray(false, true);
      this.clearPlanning(true);
      this.roomTask = {
        surfaces: C.wallOrder.concat(['ceiling']),
        index: -1, done: [], totalArea: 0, totalTarget: 0
      };
      this.taskTime = 0;
      ui.setTimer(0);
      ui.setInterlock(true, '全屋喷涂进行中');
      ui.log('全屋喷涂任务开始：后墙 → 左墙 → 右墙 → 前墙 → 天花板', 'ok');
      ui.toast('全屋喷涂开始，机器人将依次完成四面墙与天花板', 'ok');
      this.advanceRoomSurface();
    },

    advanceRoomSurface() {
      const ui = SB.UI;
      const task = this.roomTask;
      if (!task) return;
      task.index++;
      if (task.index >= task.surfaces.length) {
        this.finishRoomTask();
        return;
      }
      const surface = task.surfaces[task.index];
      const sel = this.roomSelection(surface);
      this.surface = surface;
      this.scene.surface = surface;
      this.spray.setSurface(surface);
      this.spray.setTargetRect(sel, surface);
      this.selection = sel;
      this.scene.setSelection(sel, surface);
      this.setSurfaceUI(surface);
      this.scene.setView(surface, true);
      ui.setStatus('moving', '全屋喷涂 · ' + this.surfaceName(surface));
      ui.setSelectInfo('全屋喷涂 · 规划' + this.surfaceName(surface) + '路径…');
      ui.setInterlock(true, '全屋喷涂进行中');
      ui.log('全屋喷涂 · 开始' + this.surfaceName(surface), 'info');
      this._roomMode = true;
      this.buildPath();
      this._roomMode = false;
      if (!this.path || !this.pathJobs || !this.pathJobs.length) {
        ui.log('全屋喷涂 · ' + this.surfaceName(surface) + ' 无有效路径，跳过', 'warn');
        this.advanceRoomSurface();
        return;
      }
      this.pathJobs.forEach((j) => { j.roomTarget = sel; });
      this.startPathRun();
    },

    finishRoomTask() {
      const ui = SB.UI;
      const task = this.roomTask;
      this.roomTask = null;
      this._roomMode = false;
      this.pathRun = null;
      this.baseDrive = null;
      this.setSpray(false, true);
      this.state = 'ready';
      ui.setStatus('ready', '全屋喷涂完成');
      ui.setInterlock(false);
      ui.setPathButtons({ hasPath: false, hasSelection: false, running: false });
      ui.syncJoints(this.robot.getJoints());
      const cov = task && task.totalTarget > 0 ? U.clamp((task.totalArea / task.totalTarget) * 100, 0, 100) : 0;
      ui.setSelectInfo('全屋喷涂完成 · 综合覆盖率 ' + cov.toFixed(1) + '%');
      ui.log('全屋喷涂完成 · ' + (task ? task.done.length : 0) + ' 个作业面 · 综合覆盖 ' + cov.toFixed(1) + '%', 'ok');
      ui.toast('全屋喷涂完成', 'ok');
      this.clearResume();
      this.selection = null;
      this.path = null;
      this.pathCum = null;
      this.pathDir = null;
      this.pathBase = null;
      this.pathRoute = null;
      this.pathJointDur = null;
      this.pathJobs = null;
      this.pathLength = 0;
      this.jobIndex = 0;
      this.jobOffset = 0;
      this.taskTotalLength = 0;
      this.scene.clearPlanning(true);
      this.spray.setTargetRect(null, this.surface);
    },

    startAutoSpray() {
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) return;
      if (!this.selection) {
        ui.toast('请先框选' + this.surfaceName(this.surface) + '作业区域', 'warn');
        if (!this.selectionMode) this.toggleSelectionMode(true);
        return;
      }
      if (!this.path || this.path.length < 2) {
        this.buildPath();
        if (!this.path || this.path.length < 2) return;
      }
      this.startPathRun();
    },

    startPathRun() {
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) return;
      if (!this.path || this.path.length < 2) {
        ui.toast('请先生成 S 形路径', 'warn');
        return;
      }
      if (this.toolUsesMaterial() && this.spray.tank <= 1) {
        ui.toast('料桶余量不足，请先补充涂料', 'warn');
        return;
      }
      if (this.pathJobs && this.pathJobs.length) this.applyJob(0);
      this.setSpray(false, true);
      this.scene.setFollow(true, true);
      this.clearResume();
      if (!this.roomTask) {
        this.taskTime = 0;
        ui.setTimer(0);
      } else {
        ui.setTimer(this.taskTime);
      }
      this.state = 'moving';
      ui.setStatus('moving', '自动作业准备中');
      ui.setInterlock(true, '自动作业进行中');
      ui.setPathButtons({ hasPath: true, hasSelection: !!this.selection, running: true });
      ui.setSelectInfo('机器臂折叠转运…');
      ui.log('开始自动作业 · ' + this.toolName() + ' · ' +
        this.surfaceName(this.selection.surface || this.surface) +
        ' / ' + this.path.length + ' 点', 'ok');
      this.foldToTransport(() => {
        const b = this.robot.getBasePose();
        const near = this.pathBase && Math.hypot(b.x - this.pathBase.x, b.z - this.pathBase.z) < 0.15;
        if (this.pathBase && this.pathRoute && !near) {
          this.beginBaseDrive();
        } else {
          this.beginPathMotion();
        }
      });
    },

    startFoldMotion(from, to, onDone) {
      const ui = SB.UI;
      let max = 0;
      for (let i = 0; i < 6; i++) max = Math.max(max, Math.abs(U.norm180(to[i] - from[i])));
      this.motion = {
        from: from.slice(), to: to.slice(), t: 0,
        dur: U.clamp(max / 60, 0.4, 1.8),
        name: '转运折叠', pose: '', collisionClock: 0, syncClock: 0,
        onDone: onDone
      };
      ui.setStatus('moving', '机器臂折叠转运');
      ui.markPose('');
    },

    foldToTransport(done) {
      const robot = this.robot;
      const from = robot.getJoints().slice();
      const home = robot.computeTransportJoints();
      let max = 0;
      for (let i = 0; i < 6; i++) max = Math.max(max, Math.abs(U.norm180(home[i] - from[i])));
      if (max < 8) { done(); return; }
      robot.setJoints(from);
      if (this.foldLineClear(from, home, 30)) {
        this.startFoldMotion(from, home, done);
        return;
      }
      // 先沿喷枪方向退离作业面，再折叠；避免关节直线插值扫过墙面
      const tcp = robot.getTCP();
      const baseNow = robot.getBasePose();
      const away = new THREE.Vector3(tcp.position.x - baseNow.x, 0, tcp.position.z - baseNow.z);
      const dir = away.lengthSq() > 0.04
        ? away.normalize()
        : (this.pathDir || new THREE.Vector3(0, 0, -1)).clone().normalize();
      const branches = this.pathBranch ? [this.pathBranch, -this.pathBranch] : [1, -1];
      const retracts = [0.4, 0.65, 0.9, 1.15];
      for (let i = 0; i < retracts.length; i++) {
        const viaPos = tcp.position.clone().addScaledVector(dir, -retracts[i]);
        for (let b = 0; b < branches.length; b++) {
          const sol = robot.solveIK(viaPos, dir, from, branches[b]);
          if (!sol || !sol.reachable) continue;
          if (!this.foldLineClear(from, sol.angles, 30)) continue;
          if (!this.foldLineClear(sol.angles, home, 30)) continue;
          robot.setJoints(from);
          this.startFoldMotion(from, sol.angles, () => this.startFoldMotion(sol.angles, home, done));
          return;
        }
      }
      const viaHome = robot.computeHomeJoints();
      if (this.foldLineClear(from, viaHome, 30) && this.foldLineClear(viaHome, home, 30)) {
        robot.setJoints(from);
        this.startFoldMotion(from, viaHome, () => this.startFoldMotion(viaHome, home, done));
        return;
      }
      robot.setJoints(from);
      this.startFoldMotion(from, home, done);
    },

    beginBaseDrive() {
      const ui = SB.UI;
      const route = this.pathRoute;
      if (!route || route.length < 2) { this.beginPathMotion(); return; }
      const cur = this.robot.getBasePose();
      const points = [{ x: cur.x, z: cur.z, yaw: cur.yaw }].concat(route.slice(1));
      const segments = [];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const dist = Math.hypot(b.x - a.x, b.z - a.z);
        const rot = Math.abs(U.norm180(b.yaw - a.yaw));
        segments.push({
          from: a, to: b,
          dur: Math.max(0.35, dist / C.baseSpeed, rot / 50)
        });
      }
      this.baseDrive = { segments: segments, index: 0, t: 0, dur: segments[0].dur, from: segments[0].from, to: segments[0].to };
      this.state = 'moving';
      ui.setStatus('moving', '底盘自主行驶至作业面');
      ui.setSelectInfo('底盘自主行驶中…');
      ui.log('底盘开始自主行驶 · 目标 (' + this.pathBase.x.toFixed(2) + ', ' +
        this.pathBase.z.toFixed(2) + ')，距离 ' + this.routeLength(route).toFixed(2) + ' m', 'ok');
    },

    updateBaseDrive(dt) {
      const d = this.baseDrive;
      if (!d) return;
      d.t += dt;
      const k = U.clamp(d.t / d.dur, 0, 1);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const x = U.lerp(d.from.x, d.to.x, e);
      const z = U.lerp(d.from.z, d.to.z, e);
      const yaw = U.lerpAngle(d.from.yaw, d.to.yaw, e);
      this.robot.setBasePose(x, z, yaw);
      if (k >= 1) {
        this.robot.setBasePose(d.to.x, d.to.z, d.to.yaw);
        if (d.index < d.segments.length - 1) {
          d.index++;
          d.t = 0;
          d.from = d.segments[d.index].from;
          d.to = d.segments[d.index].to;
          d.dur = d.segments[d.index].dur;
        } else {
          this.baseDrive = null;
          this.beginPathMotion();
        }
      }
    },

    // 关节空间接近路径：返回带时长的分段，供起始接近与断点返回复用
    approachSegments(from, to) {
      return this.planApproach(from, to).map((seg) => {
        let dur = 0;
        seg.from.forEach((v, i) => {
          const delta = Math.abs(U.norm180(seg.to[i] - v));
          dur = Math.max(dur, delta / Math.max(1, C.robot.joints[i].speed || 90));
        });
        return { from: seg.from, to: seg.to, dur: U.clamp(dur * 1.5, 0.35, 4) };
      });
    },

    beginPathMotion() {
      const ui = SB.UI;
      if (!this.path || this.path.length < 2) return;
      const from = this.robot.getJoints().slice();
      const to = this.path[0].angles.slice();
      const segments = this.approachSegments(from, to);
      const first = segments[0];
      this.pathRun = {
        phase: 'approach', approachIndex: 0, segments: segments,
        t: 0, dur: first.dur, from: first.from, to: first.to,
        index: 0, segT: 0, travel: 0,
        startIndex: 0, startFrac: 0, startTravel: 0,
        syncClock: 0, collisionClock: 0
      };
      this.state = 'moving';
      ui.setStatus('moving', '底盘已到位 · 正接近作业起始点');
      ui.setInterlock(true, '自动作业进行中');
      ui.setSelectInfo('机械臂伸展接近起始点…');
      ui.log('底盘已到达作业面，开始伸臂接近起始点', 'ok');
      if (segments.length > 1) ui.log('接近路径启用避障中转位姿', 'info');
    },

    updatePathRun(dt) {
      const pr = this.pathRun;
      if (!pr) return;
      const ui = SB.UI;
      if (pr.phase === 'approach') {
        pr.t += dt;
        const k = U.clamp(pr.t / pr.dur, 0, 1);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        this.robot.setJoints(U.lerpJoints(pr.from, pr.to, e));
        pr.syncClock += dt;
        if (pr.syncClock > 0.12) {
          pr.syncClock = 0;
          ui.syncJoints(this.robot.getJoints());
        }
        pr.collisionClock += dt;
        if (pr.collisionClock > 0.15) {
          pr.collisionClock = 0;
          const hit = this.scene.checkCollision(this.robot.getSamplePoints(), 0.03);
          if (hit.hit) {
            this.robot.setJoints(pr.from);
            this.lastSafeJoints = pr.from.slice();
            this.finishPathRun(true, hit.reason);
            return;
          }
        }
        if (k >= 1) {
          if (pr.approachIndex < pr.segments.length - 1) {
            pr.approachIndex++;
            const seg = pr.segments[pr.approachIndex];
            pr.t = 0;
            pr.dur = seg.dur;
            pr.from = seg.from;
            pr.to = seg.to;
            pr.collisionClock = 0;
            ui.setStatus('moving', '正在接近起始点（避障绕行）');
            return;
          }
          pr.phase = 'work';
          pr.index = U.clamp(pr.startIndex || 0, 0, this.path.length - 2);
          pr.segT = pr.startSegT || 0;
          pr.travel = pr.startTravel != null ? pr.startTravel : this.pathCum[pr.index];
          pr.collisionClock = 0;
          this.state = 'spraying';
          ui.setStatus('spraying', 'S 路径' + this.toolVerb() + '中');
          this.setSpray(true, true);
          ui.log('已到达' + (pr.resume ? '断点位姿，从断点继续' : '起始点') + this.toolName() + '开启', 'ok');
        }
        return;
      }

      const speed = U.clamp(this.params.speed || 0.5, 0.05, 1.2);
      let remain = dt;
      while (remain > 0 && this.pathRun === pr) {
        const i = pr.index;
        const j = i + 1;
        if (j >= this.path.length) {
          if (this.pathJobs && this.jobIndex < this.pathJobs.length - 1) {
            this.nextJob();
            return;
          }
          this.finishPathRun(false);
          return;
        }
        const segLen = Math.max(1e-4, this.pathCum[j] - this.pathCum[i]);
        const jointDur = (this.pathJointDur && this.pathJointDur[j]) || 0;
        const segDur = Math.max(1e-4, segLen / speed, jointDur);
        const left = segDur - pr.segT;
        if (remain < left) {
          pr.segT += remain;
          remain = 0;
        } else {
          remain -= left;
          pr.segT = segDur;
        }
        const k = U.clamp(pr.segT / segDur, 0, 1);
        const a = this.path[i].angles;
        const b = this.path[j].angles;
        this.robot.setJoints(U.lerpJoints(a, b, k));
        pr.travel = this.pathCum[i] + segLen * k;
        if (k >= 1) {
          pr.index = j;
          pr.segT = 0;
        }
      }

      if (!this.pathRun) return;
      pr.syncClock += dt;
      if (pr.syncClock > 0.18) {
        pr.syncClock = 0;
        ui.syncJoints(this.robot.getJoints());
        const done = (this.jobOffset || 0) + pr.travel;
        const total = this.taskTotalLength || this.pathLength;
        const pct = U.clamp(done / Math.max(0.001, total), 0, 1);
        ui.setSelectInfo(this.toolVerb() + '中 ' + Math.round(pct * 100) + '% · ' + done.toFixed(1) + ' / ' + total.toFixed(1) + ' m');
      }
      pr.collisionClock += dt;
      if (pr.collisionClock > 0.18) {
        pr.collisionClock = 0;
        const hit = this.scene.checkCollision(this.robot.getSamplePoints(), 0.03);
        if (hit.hit) {
          this.fault(hit.reason);
          return;
        }
      }
    },

    // 当前分区完成后折叠机械臂，底盘移动到下一分区并继续喷涂
    nextJob() {
      const ui = SB.UI;
      if (this.pathRun) {
        this.captureResumeState('分区切换');
        ui.setResumeAvailable(false);
      }
      this.setSpray(false, true);
      this.pathRun = null;
      this.state = 'moving';
      ui.setStatus('moving', '分区完成 · 前往下一分区');
      ui.setSelectInfo('分区完成 · 底盘重新定位');
      ui.setInterlock(true, '自动作业进行中');
      this.foldToTransport(() => {
        this.jobIndex++;
        this.applyJob(this.jobIndex);
        const target = this.pathBase;
        const base = this.robot.getBasePose();
        if (target && Math.hypot(base.x - target.x, base.z - target.z) > 0.15) this.beginBaseDrive();
        else this.beginPathMotion();
      });
    },

    finishPathRun(aborted, reason) {
      if (!this.pathRun) return;
      if (!aborted && this.roomTask) {
        const task = this.roomTask;
        const name = this.surfaceName(this.surface);
        task.done.push({
          surface: this.surface, name: name,
          area: this.spray.area, target: this.spray.targetArea,
          coverage: this.spray.coverage
        });
        task.totalArea += this.spray.area;
        task.totalTarget += this.spray.targetArea;
        this.pathRun = null;
        this.setSpray(false, true);
        this.state = 'moving';
        SB.UI.setStatus('moving', '全屋喷涂 · ' + name + '完成');
        SB.UI.setSelectInfo('全屋喷涂 · ' + name + ' 完成 · 前往下一作业面');
        SB.UI.setInterlock(true, '全屋喷涂进行中');
        SB.UI.log('全屋喷涂 · ' + name + ' 完成 · 覆盖 ' + this.spray.coverage.toFixed(1) + '%', 'ok');
        if (task.index >= task.surfaces.length - 1) {
          this.finishRoomTask();
          return;
        }
        this.foldToTransport(() => this.advanceRoomSurface());
        return;
      }
      const saved = aborted ? this.captureResumeState(reason) : false;
      this.pathRun = null;
      const ui = SB.UI;
      this.setSpray(false, true);
      this.state = 'ready';
      ui.setStatus('ready', aborted ? '已停止：' + (reason || '任务终止') : this.toolVerb() + '作业完成');
      ui.setInterlock(false);
      ui.setPathButtons({ hasPath: !!this.path, hasSelection: !!this.selection, running: false });
      ui.syncJoints(this.robot.getJoints());
      if (aborted) {
        if (!saved) this.clearResume();
        ui.setSelectInfo('任务已暂停 · 可继续未完成区域');
        ui.toast(this.toolVerb() + '任务已暂停：' + (reason || '任务终止') + (saved ? '，处理后点「继续作业」' : ''), 'warn');
        ui.log('S 路径' + this.toolVerb() + '中止：' + (reason || '任务终止') + (saved ? '，已保存断点' : ''), 'warn');
      } else {
        this.clearResume();
        ui.setSelectInfo(this.toolVerb() + '完成 · 覆盖率 ' + this.spray.coverage.toFixed(1) + '%');
        ui.log('S 路径' + this.toolVerb() + '完成 · 覆盖 ' + this.spray.area.toFixed(2) + ' ㎡，耗料 ' + this.spray.consumption.toFixed(2) + ' L', 'ok');
        ui.toast(this.toolVerb() + '任务完成', 'ok');
        this.showStats();
      }
    },

    clearResume() {
      this.resumeState = null;
      SB.UI.setResumeAvailable(false);
    },

    captureResumeState(reason) {
      const pr = this.pathRun;
      if (!pr || !this.path || !this.pathCum || this.path.length < 2) return false;
      const inWork = pr.phase === 'work';
      if (!inWork && pr.startIndex == null) return false;
      const index = U.clamp(inWork ? pr.index : pr.startIndex, 0, this.path.length - 2);
      const segLen = Math.max(1e-4, this.pathCum[index + 1] - this.pathCum[index]);
      const segDur = Math.max(1e-4, segLen / U.clamp(this.params.speed || 0.5, 0.05, 1.2),
        (this.pathJointDur && this.pathJointDur[index + 1]) || 0);
      // 记录当前段内的归一化进度，恢复时按新参数换算回段内时间
      const frac = inWork ? U.clamp((pr.segT || 0) / segDur, 0, 1) : U.clamp(pr.startFrac || 0, 0, 1);
      const travel = inWork
        ? U.clamp(pr.travel || this.pathCum[index], 0, this.pathLength)
        : U.clamp(pr.startTravel != null ? pr.startTravel : this.pathCum[index] + segLen * frac, 0, this.pathLength);
      this.resumeState = {
        reason: reason || '任务中止',
        path: this.path,
        pathCum: this.pathCum.slice(),
        pathJointDur: this.pathJointDur ? this.pathJointDur.slice() : null,
        pathDir: this.pathDir,
        pathLength: this.pathLength,
        pathBase: this.pathBase ? Object.assign({}, this.pathBase) : null,
        pathRoute: this.pathRoute ? this.pathRoute.slice() : null,
        jobs: this.pathJobs ? this.pathJobs.slice() : null,
        jobIndex: this.jobIndex || 0,
        jobOffset: this.jobOffset || 0,
        taskTotalLength: this.taskTotalLength || this.pathLength,
        index: index,
        frac: frac,
        travel: travel,
        overallTravel: (this.jobOffset || 0) + travel,
        selection: this.selection ? U.clone(this.selection) : null,
        surface: this.surface,
        params: U.clone(this.params),
        materialId: this.materialId,
        toolId: SB.Tools ? SB.Tools.active : 'spray',
        taskTime: this.taskTime || 0,
        roomTask: this.roomTask ? {
          surfaces: this.roomTask.surfaces.slice(),
          index: this.roomTask.index,
          done: this.roomTask.done.map((d) => Object.assign({}, d)),
          totalArea: this.roomTask.totalArea,
          totalTarget: this.roomTask.totalTarget
        } : null
      };
      SB.UI.setResumeAvailable(true, this.resumeState);
      return true;
    },

    resumePathRun() {
      const ui = SB.UI;
      const rs = this.resumeState;
      if (!rs) { ui.toast('没有可继续的作业', 'info'); return; }
      if (this.isLocked() || this.isBusy()) return;
      if (rs.materialId !== this.materialId) {
        this.clearResume();
        ui.toast('涂料已更换，断点已失效，请重新生成路径', 'warn');
        return;
      }
      if (rs.toolId && SB.Tools && SB.Tools.active !== rs.toolId) {
        this.clearResume();
        ui.toast('末端模组已更换，断点已失效，请重新生成路径', 'warn');
        return;
      }
      if (this.toolUsesMaterial() && this.spray.tank <= 1) {
        ui.toast('料桶余量不足，请先补充涂料再继续', 'warn');
        return;
      }
      this.selection = rs.selection ? U.clone(rs.selection) : null;
      this.surface = rs.surface || 'wall';
      this.scene.surface = this.surface;
      this.spray.setSurface(this.surface);
      this.spray.setTargetRect(this.selection, this.surface);
      this.path = rs.path;
      this.pathCum = rs.pathCum.slice();
      this.pathJointDur = rs.pathJointDur ? rs.pathJointDur.slice() : null;
      this.pathDir = rs.pathDir;
      this.pathLength = rs.pathLength;
      this.pathBase = rs.pathBase ? Object.assign({}, rs.pathBase) : null;
      this.pathRoute = rs.pathRoute ? rs.pathRoute.slice() : [];
      this.pathJobs = rs.jobs ? rs.jobs.slice() : null;
      this.jobIndex = rs.jobIndex || 0;
      this.taskTotalLength = rs.taskTotalLength || rs.pathLength;
      if (this.pathJobs && this.pathJobs[this.jobIndex]) this.applyJob(this.jobIndex);
      else this.jobOffset = rs.jobOffset || 0;
      this.taskTime = rs.taskTime || 0;
      this.roomTask = rs.roomTask ? {
        surfaces: rs.roomTask.surfaces.slice(),
        index: rs.roomTask.index,
        done: rs.roomTask.done.map((d) => Object.assign({}, d)),
        totalArea: rs.roomTask.totalArea,
        totalTarget: rs.roomTask.totalTarget
      } : null;
      this.setSurfaceUI(this.surface);
      if (this.selection) this.scene.setSelection(this.selection, this.surface);
      this.scene.showPaths(this.pathJobs ? this.pathJobs.map((j) => j.path) : [this.path]);
      if (this.pathBase) this.robot.setBasePose(this.pathBase.x, this.pathBase.z, this.pathBase.yaw);
      const index = U.clamp(rs.index, 0, this.path.length - 2);
      const frac = U.clamp(rs.frac || 0, 0, 1);
      const a = this.path[index].angles;
      const b = this.path[index + 1].angles;
      const targetPose = U.lerpJoints(a, b, frac);
      const segLen = Math.max(1e-4, this.pathCum[index + 1] - this.pathCum[index]);
      const segDur = Math.max(1e-4, segLen / U.clamp(this.params.speed || 0.5, 0.05, 1.2),
        (this.pathJointDur && this.pathJointDur[index + 1]) || 0);
      const travel = U.clamp(rs.travel != null ? rs.travel : this.pathCum[index] + segLen * frac, 0, this.pathLength);
      const overall = (this.jobOffset || 0) + travel;
      const pct = Math.round((overall / Math.max(0.001, this.taskTotalLength || this.pathLength)) * 100);
      const from = this.robot.getJoints().slice();
      let maxDelta = 0;
      for (let i = 0; i < 6; i++) maxDelta = Math.max(maxDelta, Math.abs(U.norm180(targetPose[i] - from[i])));

      this.setSpray(false, true);
      this.state = 'moving';
      this.scene.setFollow(true, true);
      ui.setTimer(this.taskTime);
      ui.setInterlock(true, '自动作业进行中');
      ui.setPathButtons({ hasPath: true, hasSelection: !!this.selection, running: true });
      this.lastSafeJoints = from.slice();

      // 若急停后已复位姿态，先沿安全路径返回断点位姿，再开启喷涂
      if (maxDelta > 6) {
        const segments = this.approachSegments(from, targetPose);
        if (segments.length && segments[0]) {
          const first = segments[0];
          this.pathRun = {
            phase: 'approach', approachIndex: 0, segments: segments,
            t: 0, dur: first.dur, from: first.from, to: first.to,
            index: index, segT: segDur * frac, travel: travel,
            startIndex: index, startFrac: frac, startSegT: segDur * frac, startTravel: travel,
            resume: true, syncClock: 0, collisionClock: 0
          };
          ui.setStatus('moving', '正在返回断点位姿');
          ui.setSelectInfo('返回断点 · ' + pct + '%');
          ui.log('系统复位完成，机械臂正返回断点位姿 · ' + pct + '%', 'ok');
          ui.toast('正在返回断点位姿，到达后自动继续作业', 'info');
          this.resumeState = null;
          ui.setResumeAvailable(false);
          return;
        }
      }

      this.robot.setJoints(targetPose);
      this.lastSafeJoints = targetPose.slice();
      ui.syncJoints(this.lastSafeJoints);
      this.pathRun = {
        phase: 'work', index: index, segT: segDur * frac,
        travel: travel, startIndex: index, startFrac: frac,
        startSegT: segDur * frac, startTravel: travel,
        syncClock: 0, collisionClock: 0
      };
      this.state = 'spraying';
      ui.setStatus('spraying', '从断点继续' + this.toolVerb() + '中');
      ui.setSelectInfo('从断点继续 · ' + pct + '%');
      this.setSpray(true, true);
      ui.log('从断点继续作业 · ' + travel.toFixed(2) + ' / ' + this.pathLength.toFixed(2) + ' m', 'ok');
      ui.toast('已从断点继续作业', 'ok');
      this.resumeState = null;
      ui.setResumeAvailable(false);
    },

    recordPoint() {
      const ui = SB.UI;
      if (this.isLocked()) return;
      if (this.pathRun) { ui.toast('自动作业中无法记录示教点', 'warn'); return; }
      const p = this.teach.record();
      if (!p) return;
      ui.toast('已记录示教点 #' + this.teach.points.length, 'ok');
      ui.log('记录示教点 #' + this.teach.points.length + ' · J1–J6 ' +
        p.angles.map((a) => a.toFixed(1)).join(' / ') + '°', 'ok');
    },

    startPlayback() {
      const ui = SB.UI;
      if (this.isLocked() || this.pathRun || this.motion) return;
      if (this.teach.points.length < 2) {
        ui.toast('至少记录 2 个示教点才能回放', 'warn');
        return;
      }
      this.setSpray(false, true);
      this.taskTime = 0;
      ui.setTimer(0);
      const started = this.teach.startPlayback({
        speed: 55,
        onDone: () => this.finishPlayback(false),
        onStop: () => this.finishPlayback(true)
      });
      if (!started) { ui.toast('轨迹回放启动失败', 'error'); return; }
      this.state = 'playback';
      ui.setStatus('playback', '轨迹回放中');
      ui.setInterlock(true, '轨迹回放中');
      const stopBtn = $('btnStopPlayback');
      if (stopBtn) stopBtn.disabled = false;
      this.setSpray(true, true);
      ui.log('轨迹回放开始 · ' + this.teach.points.length + ' 个示教点', 'ok');
    },

    finishPlayback(stopped) {
      if (this.state !== 'playback') return;
      const ui = SB.UI;
      this.setSpray(false, true);
      this.state = 'ready';
      ui.setStatus('ready', stopped ? '轨迹回放已停止' : '轨迹回放完成');
      ui.setInterlock(false);
      ui.setPathButtons({ hasPath: !!this.path, hasSelection: !!this.selection, running: false });
      const stopBtn = $('btnStopPlayback');
      if (stopBtn) stopBtn.disabled = true;
      ui.syncJoints(this.robot.getJoints());
      if (stopped) {
        ui.log('轨迹回放已手动停止', 'warn');
        ui.toast('轨迹回放已停止', 'warn');
      } else {
        ui.log('轨迹回放完成', 'ok');
        ui.toast('轨迹回放完成', 'ok');
      }
    },

    stopPlayback() {
      if (this.state !== 'playback') return;
      this.teach.stopPlayback(true);
    },

    clearTeach() {
      const ui = SB.UI;
      if (this.isBusy()) { ui.toast('运动中无法清空示教点', 'warn'); return; }
      if (!this.teach.points.length) return;
      this.teach.clear();
      ui.log('已清空示教点列表', 'info');
      ui.toast('示教点已清空', 'ok');
    },

    saveTrajectory() {
      const ui = SB.UI;
      if (!this.teach.points.length) {
        ui.toast('当前没有可保存的示教点', 'warn');
        return;
      }
      const nameEl = $('trajName');
      const rec = this.teach.save(nameEl ? nameEl.value : '', {
        material: this.materialId,
        params: this.params
      });
      if (!rec) {
        ui.toast('轨迹保存失败，本地存储可能已满', 'error');
        ui.log('轨迹保存失败（localStorage 写入异常）', 'error');
        return;
      }
      if (nameEl) nameEl.value = '';
      ui.log('保存轨迹「' + rec.name + '」· ' + rec.points.length + ' 点', 'ok');
      ui.toast('轨迹已保存到浏览器本地库', 'ok');
    },

    loadTrajectory() {
      const ui = SB.UI;
      if (this.isLocked() || this.isBusy()) return;
      const sel = $('savedSelect');
      const id = sel ? sel.value : '';
      if (!id) { ui.toast('请先选择已保存的轨迹', 'warn'); return; }
      const rec = this.teach.load(id);
      if (!rec) { ui.toast('轨迹不存在或已损坏', 'error'); return; }
      if (this.adaptive) this.setAdaptive(false, true);
      if (rec.material && C.materials[rec.material]) {
        this.syncInventoryFromTank();
        this.materialId = rec.material;
        this.params = rec.params ? U.clone(rec.params) : U.clone(C.materials[rec.material].defaults);
        ui.setParams(this.params, rec.material);
        this.spray.setMaterial(rec.material);
        this.setInventoryTank(rec.material);
        this.saveParams();
        this.saveInventory();
        if (this.isInventoryOpen()) SB.UI.refreshInventory(this.inventoryData());
      } else if (rec.params) {
        this.params = U.clone(rec.params);
        ui.setParams(this.params, this.materialId);
        this.saveParams();
      }
      ui.log('载入轨迹「' + rec.name + '」· ' + rec.points.length + ' 点', 'ok');
      ui.toast('已载入轨迹「' + rec.name + '」', 'ok');
    },

    deleteTrajectory() {
      const ui = SB.UI;
      const sel = $('savedSelect');
      const id = sel ? sel.value : '';
      if (!id) { ui.toast('请先选择要删除的轨迹', 'warn'); return; }
      const rec = this.teach.saved.filter((t) => t.id === id)[0];
      if (!rec) return;
      if (!window.confirm('确定删除轨迹「' + rec.name + '」吗？')) return;
      this.teach.removeSaved(id);
      ui.log('已删除轨迹「' + rec.name + '」', 'info');
      ui.toast('轨迹已删除', 'ok');
    },

    showStats() {
      const data = this.spray.stats({
        params: this.params,
        duration: this.taskTime,
        teachPoints: this.teach.points.length
      });
      SB.UI.showStats(data);
      return data;
    },
    stopAll() {
      if (this.pathRun) this.captureResumeState('急停/故障');
      if (!this.pathRun && this.roomTask) {
        this.roomTask = null;
        this._roomMode = false;
        SB.UI.log('全屋喷涂任务已终止', 'warn');
      }
      this.motion = null;
      this.pathRun = null;
      this.baseDrive = null;
      this.drag = null;
      if (this.teach) this.teach.stopPlayback(false);
      this.sprayDesired = false;
      if (this.spray) this.spray.sprayOn = false;
      SB.UI.setSprayOn(false);
      if (!this.isLocked()) this.state = 'ready';
      this.selectionMode = false;
      if (this.scene) this.scene.controls.enabled = true;
      if (this.resumeState) SB.UI.setResumeAvailable(true, this.resumeState);
    },

    emergencyStop() {
      const ui = SB.UI;
      if (this.state === 'estop') return;
      this.stopAll();
      this.state = 'estop';
      ui.setSelectionActive(false);
      ui.setStatus('estop', '急停锁定');
      ui.setInterlock(true, '急停锁定 · 请检查现场后复位');
      ui.showAlert('急停已触发：关节锁死、喷涂立即停止。排除风险后点击「解除急停」。');
      ui.log('急停按钮按下：关节锁死、喷涂停止', 'error');
      ui.toast('急停已触发，系统锁定', 'error');
    },

    fault(reason) {
      const ui = SB.UI;
      if (this.isLocked()) return;
      this.stopAll();
      this.state = 'fault';
      ui.setSelectionActive(false);
      ui.setStatus('fault', '安全保护触发');
      ui.setInterlock(true, '安全保护锁定 · 请复位');
      ui.showAlert('检测到' + reason + '碰撞风险：机器人已停止，请检查姿态后解除锁定。');
      ui.log('安全保护触发：' + reason + '碰撞风险，运动已停止', 'error');
      ui.toast('安全保护触发：' + reason + '碰撞', 'error');
    },

    resetFault() {
      const ui = SB.UI;
      if (!this.isLocked()) {
        ui.toast('当前系统未处于锁定状态', 'info');
        return;
      }
      const wasEstop = this.state === 'estop';
      this.state = 'ready';
      this.lastSafeJoints = this.robot.getJoints();
      this.sprayDesired = false;
      ui.hideAlert();
      ui.setInterlock(false);
      ui.setSprayOn(false);
      ui.setStatus('ready', '系统就绪');
      ui.setPathButtons({ hasPath: !!this.path, hasSelection: !!this.selection, running: false });
      ui.setSelectInfo(this.selection ? this.selectionInfo() : this.emptySelectionText());
      ui.syncJoints(this.lastSafeJoints);
      ui.log(wasEstop ? '急停已解除，系统恢复就绪' : '安全保护已复位，系统恢复就绪', 'ok');
      ui.toast('系统已复位', 'ok');
    },

    updateTelemetry(dt) {
      const ui = SB.UI;
      const tcp = this.robot.getTCP();
      if (dt > 0 && this._prevTcp) {
        const inst = this._prevTcp.distanceTo(tcp.position) / dt;
        this.speed = U.lerp(this.speed, inst, 0.28);
      } else if (this.isLocked()) {
        this.speed = 0;
      }
      this._prevTcp = tcp.position.clone();
      this._uiClock += dt;
      if (this._uiClock < 0.1) return;
      this._uiClock = 0;
      const hit = this.spray.projectToSurface(tcp.position, tcp.direction, this.surface);
      const distance = hit ? hit.distance : (this.surface === 'ceiling'
        ? Math.max(0, C.room.height - tcp.position.y)
        : this.surface === 'floor'
          ? Math.max(0, tcp.position.y)
          : Math.max(0, tcp.position.z - C.room.wallZ));
      ui.updateTelemetry({
        joints: this.robot.getJoints(),
        tcp: tcp.position,
        speed: this.speed,
        distance,
        area: this.spray.area,
        coverage: this.spray.coverage,
        consumption: this.spray.consumption
      });
      ui.setTank(this.spray.tank);
      ui.setTimer(this.taskTime);
      ui.updateTakeLive({ params: this.params });
      this.syncInventoryFromTank();
      this._invClock += 0.1;
      if (this._invClock > 0.5) {
        this._invClock = 0;
        if (this.isInventoryOpen()) SB.UI.refreshInventory(this.inventoryData());
      }
      this._invSaveClock += 0.1;
      if (this._invDirty && this._invSaveClock > 2) {
        this._invSaveClock = 0;
        this.saveInventory();
      }
    },

    loop(ts) {
      this._raf = requestAnimationFrame((t) => this.loop(t));
      const now = ts || performance.now();
      let dt = (now - this._last) / 1000;
      this._last = now;
      if (!isFinite(dt) || dt < 0) dt = 0;
      dt = Math.min(dt, 0.05);
      const ui = SB.UI;

      if (!this.isLocked()) {
        if (this.motion) this.updateMotion(dt);
        if (this.baseDrive) this.updateBaseDrive(dt);
        if (this.pathRun) this.updatePathRun(dt);
        if (this.teach.playing) this.teach.update(dt);
        if (this.sprayDesired) {
          const tcp = this.robot.getTCP();
          SB.Tools.operate(dt, tcp.position, tcp.direction, this.params);
          this.taskTime += dt;
          if (this.toolUsesMaterial() && this.spray.tank <= 0.05) {
            this.setSpray(false);
            ui.toast('料桶已空，作业自动停止，请补充涂料', 'warn');
            ui.log('料桶耗尽，作业自动停止', 'warn');
            if (this.pathRun) this.finishPathRun(true, '料桶已空');
          }
        } else {
          this.spray.sprayOn = false;
        }
      } else {
        this.spray.sprayOn = false;
      }

      this.robot.update(dt);
      this.spray.update(dt);
      this.scene.update(dt);
      this.updateTelemetry(dt);
      if (this.nozzleOn && SB.Nozzle) SB.Nozzle.update(dt);
      if (!this.nozzleOn) this.scene.render();
    }
  };

  function boot() {
    try {
      App.init();
    } catch (err) {
      console.error('[SprayBot] 初始化失败', err);
      const box = document.getElementById('viewport');
      if (box) {
        box.innerHTML = '<div style="padding:40px;font:13px/1.7 monospace;color:#c0392b;">' +
          '仿真初始化失败：' + (err && err.message ? err.message : err) +
          '<br>请使用支持 WebGL2 的现代浏览器（Chrome / Edge）打开 index.html。</div>';
      }
      if (window.SprayBot && SprayBot.UI && SprayBot.UI.toast) {
        SprayBot.UI.toast('初始化失败：' + (err && err.message ? err.message : err), 'error');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();