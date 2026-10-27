/* =========================================================
 * tool.js — 末端模组管理器：喷涂枪 / 批刮刮刀 / 打磨砂盘
 * 负责 3D 模组挂载、快速切换与作业逻辑分发
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const C = SB.CONFIG;
  const U = SB.U;

  const Tools = SB.Tools = {
    app: null,
    robot: null,
    active: 'spray',
    groups: {},

    init(app) {
      this.app = app;
      this.robot = app.robot;
      this.buildModels();
      let saved = null;
      try { saved = localStorage.getItem(C.storageKeys.tool); } catch (e) { /* noop */ }
      const valid = C.endEffectors.some((t) => t.id === saved);
      this.active = valid ? saved : 'spray';
      this.applyVisibility();
      if (SB.UI) SB.UI.setTool(this.active);
      return this;
    },

    list() { return C.endEffectors; },

    get(id) {
      return C.endEffectors.filter((t) => t.id === id)[0] || C.endEffectors[0];
    },

    current() { return this.get(this.active); },
    usesMaterial() { return !!this.current().usesMaterial; },
    verb() { return this.current().verb; },
    name() { return this.current().name; },

    buildModels() {
      const robot = this.robot;
      const M = robot.materials;
      if (!robot.toolMount) return;
      this.groups.spray = robot.nozzleGroup;

      // 批刮刮刀：手柄 + 支架 + 宽幅刮刀片
      const trowel = new THREE.Group();
      trowel.name = 'Tool_Trowel';
      robot.addMesh(trowel, new THREE.CylinderGeometry(0.028, 0.034, 0.16, 16), M.dark, 'nozzle', [0, 0, 0.14], [Math.PI / 2, 0, 0]);
      robot.addMesh(trowel, new THREE.CylinderGeometry(0.038, 0.038, 0.03, 16), M.blue, 'nozzle', [0, 0, 0.235], [Math.PI / 2, 0, 0]);
      robot.addMesh(trowel, new THREE.BoxGeometry(0.13, 0.05, 0.06), M.steel, 'nozzle', [0, 0, 0.275]);
      robot.addMesh(trowel, new THREE.BoxGeometry(0.42, 0.014, 0.13), M.steel, 'nozzle', [0, 0, 0.325]);
      robot.addMesh(trowel, new THREE.BoxGeometry(0.42, 0.007, 0.022), M.rubber, 'nozzle', [0, 0, 0.392]);
      robot.addMesh(trowel, new THREE.CylinderGeometry(0.014, 0.014, 0.05, 12), M.orange, 'nozzle', [0.14, 0.045, 0.25], [0, 0, Math.PI / 2]);
      trowel.visible = false;
      robot.toolMount.add(trowel);
      this.groups.trowel = trowel;

      // 打磨砂盘：电机 + 偏心砂盘 + 防尘罩
      const sander = new THREE.Group();
      sander.name = 'Tool_Sander';
      robot.addMesh(sander, new THREE.CylinderGeometry(0.062, 0.052, 0.14, 20), M.dark, 'nozzle', [0, 0, 0.16], [Math.PI / 2, 0, 0]);
      robot.addMesh(sander, new THREE.CylinderGeometry(0.072, 0.072, 0.04, 20), M.blue, 'nozzle', [0, 0, 0.245], [Math.PI / 2, 0, 0]);
      robot.addMesh(sander, new THREE.CylinderGeometry(0.115, 0.115, 0.03, 28), M.orange, 'nozzle', [0, 0, 0.285], [Math.PI / 2, 0, 0]);
      robot.addMesh(sander, new THREE.CylinderGeometry(0.118, 0.118, 0.018, 28), M.rubber, 'nozzle', [0, 0, 0.312], [Math.PI / 2, 0, 0]);
      robot.addMesh(sander, new THREE.TorusGeometry(0.124, 0.009, 8, 28), M.steel, 'nozzle', [0, 0, 0.3]);
      robot.addMesh(sander, new THREE.SphereGeometry(0.012, 10, 8), M.led, 'nozzle', [0.055, 0.05, 0.2]);
      sander.visible = false;
      robot.toolMount.add(sander);
      this.groups.sander = sander;
    },

    applyVisibility(layerVisible) {
      if (!this.robot) return;
      const state = this.robot._layerState || { nozzle: true };
      const visible = layerVisible == null ? state.nozzle : layerVisible;
      Object.keys(this.groups).forEach((id) => {
        const g = this.groups[id];
        if (!g) return;
        g.visible = !!visible && !this.robot.custom && id === this.active;
      });
    },

    setActive(id, silent) {
      const cfg = this.get(id);
      if (!cfg) return;
      const app = this.app;
      if (!silent && this.active === cfg.id) {
        if (SB.UI) SB.UI.toast('当前已是「' + cfg.name + '」', 'info');
        return;
      }
      if (!silent && app && app.isBusy && app.isBusy()) {
        if (SB.UI) SB.UI.toast('作业进行中，请先停止后再切换末端模组', 'warn');
        return;
      }
      if (!silent && this.active !== cfg.id && app && app.sprayDesired) app.setSpray(false, true);
      if (!silent && this.active !== cfg.id && app && app.nozzleOn) app.setNozzleView(false);
      this.active = cfg.id;
      this.applyVisibility();
      try { localStorage.setItem(C.storageKeys.tool, cfg.id); } catch (e) { /* noop */ }
      if (SB.UI) SB.UI.setTool(cfg.id);
      if (app && !silent) {
        if (app.state === 'ready') SB.UI.setStatus('ready', '末端已切换：' + cfg.name);
        SB.UI.log('末端模组切换：' + cfg.name + ' · ' + cfg.desc, 'ok');
        SB.UI.toast('已切换末端模组：' + cfg.name, 'ok');
      }
    },

    operate(dt, tcp, direction, params) {
      if (this.active === 'trowel') return this.app.spray.trowelStep(dt, tcp, direction, params);
      if (this.active === 'sander') return this.app.spray.sandStep(dt, tcp, direction, params);
      return this.app.spray.sprayStep(dt, tcp, direction, params);
    }
  };
})();
