/* =========================================================
 * config.js — 全局配置 / 工具函数
 * 所有模块挂载到 window.SprayBot 命名空间，file:// 下可直接运行
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot = window.SprayBot || {};

  const U = SB.U = {
    clamp(v, min, max) { return Math.min(max, Math.max(min, v)); },
    lerp(a, b, t) { return a + (b - a) * t; },
    lerpAngle(a, b, t) {
      const d = U.norm180(Number(b) - Number(a));
      return U.norm180(Number(a) + d * t);
    },
    // 关节空间插值：J1/J4 走最短角，其余关节保持记录方向
    lerpJoints(from, to, t) {
      const out = new Array(from.length);
      for (let i = 0; i < from.length; i++) {
        out[i] = (i === 0 || i === 3) ? U.lerpAngle(from[i], to[i], t) : U.lerp(from[i], to[i], t);
      }
      return out;
    },
    deg(r) { return r * Math.PI / 180; },
    rad(d) { return d * 180 / Math.PI; },
    norm180(a) {
      let v = a % 360;
      if (v > 180) v -= 360;
      if (v <= -180) v += 360;
      return v;
    },
    fmt(v, digits) {
      const n = Number(v);
      if (!isFinite(n)) return '--';
      return n.toFixed(digits == null ? 2 : digits);
    },
    fmtTime(sec) {
      const s = Math.max(0, Math.floor(sec || 0));
      const m = Math.floor(s / 60);
      return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    },
    clock(date) {
      const d = date || new Date();
      const p = (n) => String(n).padStart(2, '0');
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    },
    clone(obj) { return JSON.parse(JSON.stringify(obj)); },
    uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },
    isMobile() { return window.matchMedia && window.matchMedia('(max-width: 900px)').matches; },
    isLandscape() {
      return window.matchMedia && window.matchMedia('(orientation: landscape) and (max-height: 600px) and (max-width: 1100px)').matches;
    },
    escapeHTML(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
  };

  /* 不同厂房场景使用不同尺寸与室内布置，切换时重建房间 */
  const SCENES = [
    {
      id: 'cleanroom', name: '电子洁净厂房', short: '洁净厂房',
      desc: '防静电自流平 + 洁净墙板',
      width: 12, depth: 9, height: 3.3, appearance: 'cleanroom',
      colors: { wall: '#f5f8fb', wall2: '#e9f1f8', floor: '#cfdde8', ceiling: '#f8fbfe', accent: '#2f8fe8' },
      start: { x: 0, z: 0.8, yaw: Math.PI },
      coating: 'qzds-001'
    },
    {
      id: 'steel', name: '钢结构防火厂房', short: '钢结构厂房',
      desc: '钢结构防火涂料 + 工业地坪',
      width: 13.5, depth: 9.5, height: 3.4, appearance: 'steel',
      colors: { wall: '#b9c3cd', wall2: '#a7b2be', floor: '#9aa0a6', ceiling: '#6f7c8b', accent: '#e7a100' },
      start: { x: 0, z: 0.8, yaw: Math.PI },
      coating: 'qzds-008'
    },
    {
      id: 'storage', name: '防爆储罐区', short: '储罐区',
      desc: '储罐抗爆涂层 + 防爆地坪',
      width: 13.5, depth: 9.5, height: 3.4, appearance: 'storage',
      colors: { wall: '#c8cdd2', wall2: '#b8bec5', floor: '#a8adb2', ceiling: '#aeb5bd', accent: '#d97706' },
      start: { x: 0, z: 0.8, yaw: Math.PI },
      coating: 'qzds-013'
    },
    {
      id: 'electrical', name: '绝缘配电房', short: '配电房',
      desc: '绝缘导热涂层 + 设备基础',
      width: 11, depth: 8.4, height: 3.2, appearance: 'electrical',
      colors: { wall: '#eef2f6', wall2: '#e2e8ef', floor: '#c4cbd4', ceiling: '#f2f5f8', accent: '#2f8fe8' },
      start: { x: 0, z: 0.5, yaw: Math.PI },
      coating: 'qzds-019'
    }
  ];

  function makeRoom(scene) {
    return {
      width: scene.width,
      depth: scene.depth,
      height: scene.height,
      wallWidth: scene.width,
      wallHeight: scene.height,
      wallZ: -scene.depth / 2,
      door: scene.door || null,
      window: scene.window || null,
      pilaster: scene.pilaster || null
    };
  }

  const scene0 = SCENES[0];
  const ROOM = makeRoom(scene0);

  SB.CONFIG = {
    version: '1.2.0',
    scenes: SCENES,
    getScene(id) {
      return SCENES.filter((s) => s.id === id)[0] || SCENES[0];
    },
    defaultScene: scene0.id,
    currentScene: scene0.id,
    applyScene(id) {
      const s = this.getScene(id);
      this.currentScene = s.id;
      this.room = makeRoom(s);
      this.robot.position = { x: s.start.x, y: 0, z: s.start.z };
      return s;
    },
    room: ROOM,
    /* 作业面：四面墙 + 天花板 + 地面，统一用局部 u/v 坐标描述 */
    wallOrder: ['wall', 'wall-left', 'wall-right', 'wall-front'],
    wallNames: { wall: '后墙', 'wall-left': '左墙', 'wall-right': '右墙', 'wall-front': '前墙' },
    isWallSurface(id) {
      return id === 'wall' || id === 'wall-left' || id === 'wall-right' || id === 'wall-front';
    },
    surfaceFrame(id) {
      const R = this.room;
      const W = R.width, D = R.depth, H = R.height;
      if (id === 'ceiling') {
        return { id: id, isWall: false, width: W, height: D, vMin: -D / 2, vMax: D / 2, anchor: [0, H, 0], uDir: [1, 0, 0], vDir: [0, 0, 1], normal: [0, -1, 0], rotY: 0 };
      }
      if (id === 'floor') {
        return { id: id, isWall: false, width: W, height: D, vMin: -D / 2, vMax: D / 2, anchor: [0, 0, 0], uDir: [1, 0, 0], vDir: [0, 0, 1], normal: [0, 1, 0], rotY: 0 };
      }
      if (id === 'wall-left') {
        return { id: id, isWall: true, width: D, height: H, vMin: 0, vMax: H, anchor: [-W / 2, 0, 0], uDir: [0, 0, -1], vDir: [0, 1, 0], normal: [1, 0, 0], rotY: Math.PI / 2 };
      }
      if (id === 'wall-right') {
        return { id: id, isWall: true, width: D, height: H, vMin: 0, vMax: H, anchor: [W / 2, 0, 0], uDir: [0, 0, 1], vDir: [0, 1, 0], normal: [-1, 0, 0], rotY: -Math.PI / 2 };
      }
      if (id === 'wall-front') {
        return { id: id, isWall: true, width: W, height: H, vMin: 0, vMax: H, anchor: [0, 0, D / 2], uDir: [-1, 0, 0], vDir: [0, 1, 0], normal: [0, 0, -1], rotY: Math.PI };
      }
      return { id: 'wall', isWall: true, width: W, height: H, vMin: 0, vMax: H, anchor: [0, 0, R.wallZ], uDir: [1, 0, 0], vDir: [0, 1, 0], normal: [0, 0, 1], rotY: 0 };
    },
    baseSpeed: 0.62,
    robot: {
      position: { x: scene0.start.x, y: 0, z: scene0.start.z },
      yawOffset: Math.PI,
      baseY: 0.86,
      shoulderY: 0.27,
      armOffsetZ: 0.30,
      lift: { min: 0, max: 0.62, home: 0, speed: 0.34 },
      L1: 1.05,
      L2: 0.90,
      L3: 0.56,
      home: { target: [0.45, 1.45, -0.95], direction: [0, 0, -1] },
      joints: [
        { name: 'J1', label: '底座回转', min: -180, max: 180, speed: 70 },
        { name: 'J2', label: '大臂俯仰', min: -100, max: 100, speed: 60 },
        { name: 'J3', label: '小臂俯仰', min: -160, max: 160, speed: 65 },
        { name: 'J4', label: '腕部回转', min: -180, max: 180, speed: 90 },
        { name: 'J5', label: '腕部摆动', min: -130, max: 130, speed: 85 },
        { name: 'J6', label: '夹爪自转', min: -360, max: 360, speed: 120 }
      ]
    },
    poses: [
      {
        id: 'home', name: '安全零位', desc: '折叠待机姿态',
        target: [0.45, 1.45, -0.95], direction: [0, 0, -1]
      },
      {
        id: 'wall', name: '垂直墙面', desc: '正对主墙 · 喷距 0.34m',
        target: [0, 1.55, -3.16], direction: [0, 0, -1]
      },
      {
        id: 'ceiling', name: '天花板', desc: '喷枪朝上 · 仰喷',
        target: [0.2, 2.86, -1.2], direction: [0, 1, 0]
      },
      {
        id: 'corner', name: '阴阳角', desc: '立柱内角 · 45° 斜喷',
        target: [2.10, 1.55, -2.95], direction: [0.7071, 0, -0.7071]
      }
    ],
    params: {
      pressure: { label: '喷涂压力', unit: 'MPa', min: 0.1, max: 0.9, step: 0.01, digits: 2 },
      speed: { label: '移动速度', unit: 'm/s', min: 0.1, max: 1.2, step: 0.05, digits: 2 },
      fanWidth: { label: '喷幅宽度', unit: 'm', min: 0.1, max: 0.6, step: 0.01, digits: 2 },
      distance: { label: '喷涂距离', unit: 'm', min: 0.15, max: 0.6, step: 0.01, digits: 2 },
      thickness: { label: '涂层厚度', unit: 'µm', min: 5, max: 20000, step: 1, digits: 0 }
    },
    materials: {
      putty: {
        name: '腻子', en: 'Putty', color: 0xf2ecdf, cssColor: '#F2ECDF',
        desc: '找平 / 厚涂', category: 'decor', code: 'DT-01', shortName: '腻子',
        spec: { film: 1800, label: '施工厚度', value: '1.8 mm' },
        props: { viscosity: 95, solid: 68, density: 1.55, flow: 2.20, transfer: 60, dilution: 5, solvent: '清水', potLife: 2, recoat: 4, cure: '常温 24h' },
        defaults: { pressure: 0.60, speed: 0.40, fanWidth: 0.35, distance: 0.35, thickness: 1800 },
        range: { pressure: [0.45, 0.75], speed: [0.25, 0.55], fanWidth: [0.25, 0.45], distance: [0.25, 0.45], thickness: [900, 3000] }
      },
      paint: {
        name: '乳胶漆', en: 'Latex Paint', color: 0xdde6ee, cssColor: '#DDE6EE',
        desc: '面漆 / 薄涂', category: 'decor', code: 'DT-02', shortName: '乳胶漆',
        spec: { film: 450, label: '施工厚度', value: '450 µm' },
        props: { viscosity: 65, solid: 55, density: 1.35, flow: 0.80, transfer: 62, dilution: 10, solvent: '清水', potLife: 4, recoat: 2, cure: '常温 4h' },
        defaults: { pressure: 0.35, speed: 0.60, fanWidth: 0.25, distance: 0.30, thickness: 450 },
        range: { pressure: [0.25, 0.48], speed: [0.40, 0.80], fanWidth: [0.15, 0.32], distance: [0.20, 0.38], thickness: [200, 900] }
      }
    },
    templates: [
      { id: 'primer', name: '底漆喷涂', desc: '薄涂封闭 · 低压力', material: 'paint', params: { pressure: 0.32, speed: 0.68, fanWidth: 0.24, distance: 0.30, thickness: 350 } },
      { id: 'putty-heavy', name: '腻子厚喷', desc: '找平厚涂 · 大扇幅', material: 'putty', params: { pressure: 0.66, speed: 0.33, fanWidth: 0.40, distance: 0.36, thickness: 2400 } },
      { id: 'finish', name: '面漆精喷', desc: '均匀细腻 · 中速', material: 'paint', params: { pressure: 0.40, speed: 0.52, fanWidth: 0.22, distance: 0.28, thickness: 450 } }
    ],
    layers: [
      { id: 'chassis', name: '移动底盘' },
      { id: 'arm', name: '六轴机械臂' },
      { id: 'nozzle', name: '末端模组' },
      { id: 'hose', name: '输料软管' }
    ],
    defaultSelection: { minX: -1.5, maxX: 1.5, minY: 0.8, maxY: 2.1 },
    defaultSelectionFlat: { minX: -0.9, maxX: 0.9, minY: -0.5, maxY: 0.5 },
    // 可快速切换的末端模组
    endEffectors: [
      {
        id: 'spray', name: '喷涂夹爪', short: '喷涂', badge: '夹爪', verb: '喷涂',
        desc: '雾化喷涂 · 平行夹爪末端', usesMaterial: true
      },
      {
        id: 'trowel', name: '批刮刮刀', short: '批刮', badge: '刮刀', verb: '批刮',
        desc: '宽幅批刮 · 腻子找平', usesMaterial: true
      },
      {
        id: 'sander', name: '打磨砂盘', short: '打磨', badge: '砂盘', verb: '打磨',
        desc: '偏心打磨 · 去除余料与毛刺', usesMaterial: false
      }
    ],
    tankCapacity: 20,
    coverageCell: 0.05,
    consumptionFactor: 1.15,
    sprayOriginOffset: 0.02,
    storageKeys: {
      settings: 'spraybot.settings.v1',
      params: 'spraybot.params.v1',
      trajectories: 'spraybot.trajectories.v1',
      inventory: 'spraybot.inventory.v1',
      tool: 'spraybot.tool.v1'
    },
    defaults: {
      settings: { particles: true, quality: 'high', theme: 'light', layers: { chassis: true, arm: true, nozzle: true, hose: true } }
    }
  };

  const C = SB.CONFIG;

  /* =========================================================
   * 涂料参数库 — 依据上传的行业喷涂数据参数库图示整理
   * 4 类功能涂层 × 6 组 = QZDS-001 … QZDS-024，另含基础装饰材料
   * 参数为工艺参考示例，可按现场标定修正
   * ========================================================= */
  const CATS = [
    { id: 'decor', name: '基础装饰', short: '基础装饰', property: '施工厚度' },
    { id: 'anti-static', name: '防静电涂层', short: '防静电', property: '表面电阻' },
    { id: 'fire', name: '防火阻燃涂层', short: '防火阻燃', property: '阻燃等级' },
    { id: 'blast', name: '防爆抗爆涂层', short: '防爆抗爆', property: '抗冲击' },
    { id: 'insulation', name: '绝缘导热涂层', short: '绝缘导热', property: '绝缘 / 导热' }
  ];
  C.categories = CATS;

  C.propFields = [
    { key: 'viscosity', label: '粘度 (涂-4)', unit: 's', digits: 0 },
    { key: 'solid', label: '体积固含', unit: '%', digits: 0 },
    { key: 'density', label: '密度', unit: 'kg/L', digits: 2 },
    { key: 'flow', label: '理论流量', unit: 'L/min', digits: 2 },
    { key: 'transfer', label: '传递效率', unit: '%', digits: 0 },
    { key: 'dilution', label: '稀释比例', unit: '%', digits: 0 },
    { key: 'potLife', label: '适用期', unit: 'h', digits: 1 },
    { key: 'recoat', label: '重涂间隔', unit: 'h', digits: 1 }
  ];

  const PRESET = {
    'anti-static': {
      name: '防静电涂层', color: '#E3E8EE',
      process: { pressure: 0.38, speed: 0.45, fanWidth: 0.28, distance: 0.28 },
      ranges: { pressure: [0.30, 0.48], speed: [0.35, 0.60], fanWidth: [0.22, 0.36], distance: [0.24, 0.36] },
      props: {
        viscosity: 28, solid: 58, density: 1.28, flow: 0.45, transfer: 66, dilution: 5,
        solvent: '专用稀释剂', potLife: 4, recoat: 6, cure: '常温 24h / 60℃ 30min'
      },
      specLabel: '表面电阻'
    },
    fire: {
      name: '防火阻燃涂层', color: '#DCE1E6',
      process: { pressure: 0.55, speed: 0.32, fanWidth: 0.34, distance: 0.35 },
      ranges: { pressure: [0.45, 0.68], speed: [0.25, 0.40], fanWidth: [0.28, 0.42], distance: [0.30, 0.42] },
      props: {
        viscosity: 85, solid: 66, density: 1.42, flow: 1.10, transfer: 60, dilution: 0,
        solvent: '不稀释', potLife: 3, recoat: 8, cure: '常温 24h'
      },
      specLabel: '阻燃等级'
    },
    blast: {
      name: '防爆抗爆涂层', color: '#D6DBE0',
      process: { pressure: 0.65, speed: 0.30, fanWidth: 0.36, distance: 0.38 },
      ranges: { pressure: [0.55, 0.80], speed: [0.22, 0.38], fanWidth: [0.30, 0.45], distance: [0.32, 0.45] },
      props: {
        viscosity: 110, solid: 96, density: 1.55, flow: 2.60, transfer: 68, dilution: 0,
        solvent: '专用稀释剂', potLife: 1.5, recoat: 2, cure: '常温 2h'
      },
      specLabel: '抗冲击'
    },
    insulation: {
      name: '绝缘导热涂层', color: '#E7EBF0',
      process: { pressure: 0.45, speed: 0.38, fanWidth: 0.24, distance: 0.28 },
      ranges: { pressure: [0.38, 0.55], speed: [0.30, 0.46], fanWidth: [0.20, 0.30], distance: [0.24, 0.34] },
      props: {
        viscosity: 42, solid: 72, density: 1.72, flow: 0.50, transfer: 64, dilution: 3,
        solvent: '专用稀释剂', potLife: 3, recoat: 5, cure: '常温 8h / 80℃ 1h'
      },
      specLabel: '绝缘 / 导热'
    }
  };

  const SEEDS = [
    { code: 'QZDS-001', category: 'anti-static', name: '电子洁净厂房', film: 80, spec: '10⁶ Ω' },
    { code: 'QZDS-002', category: 'anti-static', name: '半导体净化车间', film: 100, spec: '10⁶ Ω' },
    { code: 'QZDS-003', category: 'anti-static', name: '电源装配车间', film: 50, spec: '10⁶ Ω' },
    { code: 'QZDS-004', category: 'anti-static', name: '500㎡轻电场', film: 2000, spec: '10⁶ Ω' },
    { code: 'QZDS-005', category: 'anti-static', name: '芯片加工洁净室', film: 120, spec: '10⁶ Ω' },
    { code: 'QZDS-006', category: 'anti-static', name: 'SMT 贴片车间', film: 70, spec: '10⁶ Ω' },
    { code: 'QZDS-007', category: 'fire', name: '电缆桥架', film: 15, spec: 'UL 94 V-0' },
    { code: 'QZDS-008', category: 'fire', name: '钢结构防火涂料', film: 2000, spec: 'UL 94 V-0' },
    { code: 'QZDS-009', category: 'fire', name: '电缆防火漆', film: 3000, spec: 'UL 94 V-0' },
    { code: 'QZDS-010', category: 'fire', name: '装配式防火墙', film: 1000, spec: 'UL 94 V-0' },
    { code: 'QZDS-011', category: 'fire', name: '防火电缆桥架', film: 200, spec: 'UL 94 V-0' },
    { code: 'QZDS-012', category: 'fire', name: '电缆沟封堵', film: 15000, spec: 'UL 94 V-0' },
    { code: 'QZDS-013', category: 'blast', name: '氢氧化铝储罐', film: 3000, spec: '2000 kPa @ 3 mm' },
    { code: 'QZDS-014', category: 'blast', name: '化工区储罐', film: 3000, spec: '1800 kPa @ 3 mm' },
    { code: 'QZDS-015', category: 'blast', name: '液化气储罐', film: 2500, spec: '1500 kPa @ 2.5 mm' },
    { code: 'QZDS-016', category: 'blast', name: '化学品储罐', film: 3000, spec: '2000 kPa @ 3 mm' },
    { code: 'QZDS-017', category: 'blast', name: '储罐设备基础', film: 3500, spec: '2200 kPa @ 3.5 mm' },
    { code: 'QZDS-018', category: 'blast', name: '阻燃设备储罐', film: 2000, spec: '1600 kPa @ 2 mm' },
    { code: 'QZDS-019', category: 'insulation', name: '储能柜内壁', film: 120, spec: '10¹² Ω' },
    { code: 'QZDS-020', category: 'insulation', name: '绝缘地坪', film: 150, spec: '10¹² Ω' },
    { code: 'QZDS-021', category: 'insulation', name: '户外储能柜', film: 150, spec: '10¹² Ω' },
    { code: 'QZDS-022', category: 'insulation', name: '绝缘地坪（薄涂）', film: 80, spec: '10¹² Ω' },
    { code: 'QZDS-023', category: 'insulation', name: '导热导轨', film: 200, spec: '1.5 W/m·K', specLabel: '导热系数' },
    { code: 'QZDS-024', category: 'insulation', name: '户外集装箱', film: 160, spec: '10¹² Ω' }
  ];

  function filmText(um) {
    if (um >= 1000) return (um / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' mm';
    return um + ' µm';
  }

  C.coatings = [];
  ['putty', 'paint'].forEach((id) => {
    C.coatings.push(Object.assign({ id: id }, C.materials[id]));
  });
  SEEDS.forEach((seed) => {
    const preset = PRESET[seed.category];
    const pass = Math.round(U.clamp(seed.film / 4, 30, 600));
    const ranges = U.clone(preset.ranges);
    ranges.thickness = [Math.round(pass * 0.5), Math.round(pass * 2.5)];
    const id = seed.code.toLowerCase();
    const entry = {
      id: id,
      code: seed.code,
      name: preset.name + ' · ' + seed.name,
      shortName: seed.name,
      en: seed.code,
      category: seed.category,
      desc: seed.spec + ' · 膜厚 ' + filmText(seed.film),
      color: parseInt(preset.color.slice(1), 16),
      cssColor: preset.color,
      spec: {
        film: seed.film,
        filmText: filmText(seed.film),
        label: seed.specLabel || preset.specLabel,
        value: seed.spec
      },
      props: U.clone(preset.props),
      defaults: {
        pressure: preset.process.pressure,
        speed: preset.process.speed,
        fanWidth: preset.process.fanWidth,
        distance: preset.process.distance,
        thickness: pass
      },
      range: ranges
    };
    C.materials[id] = entry;
    C.coatings.push(entry);
  });
})();
