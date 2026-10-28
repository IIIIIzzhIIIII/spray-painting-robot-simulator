/* =========================================================
 * robot.js — 程序化六轴喷涂机器人、解析 IK/FK、碰撞采样、GLB 替换
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const C = SB.CONFIG;
  const U = SB.U;
  const R = C.robot;

  function RobotRig(sceneMgr) {
    this.sceneMgr = sceneMgr;
    this.scene = sceneMgr.scene;
    this.root = new THREE.Group();
    this.root.name = 'SprayRobotRoot';
    this.basePos = new THREE.Vector3(R.position.x, 0, R.position.z);
    this.baseYaw = R.yawOffset;
    this.root.position.set(this.basePos.x, 0, this.basePos.z);
    this.root.rotation.y = this.baseYaw;
    sceneMgr.scene.add(this.root);

    this.armMeshes = [];
    this.chassisMeshes = [];
    this.nozzleMeshes = [];
    this.jointGroups = [];
    this.custom = null;
    this.currentJoints = [0, 0, 0, 0, 0, 0];
    this._hoseClock = 0;
    this._hoseLastEnd = null;
    this._layerState = { chassis: true, arm: true, nozzle: true, hose: true };

    this.materials = {
      blue: new THREE.MeshStandardMaterial({ color: 0x0066cc, metalness: 0.42, roughness: 0.34 }),
      blueDark: new THREE.MeshStandardMaterial({ color: 0x0a4a88, metalness: 0.5, roughness: 0.32 }),
      blueLight: new THREE.MeshStandardMaterial({ color: 0x2b8ce6, metalness: 0.35, roughness: 0.38 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x28313d, metalness: 0.55, roughness: 0.42 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x98a4b3, metalness: 0.82, roughness: 0.28 }),
      yellow: new THREE.MeshStandardMaterial({ color: 0xffcc00, metalness: 0.25, roughness: 0.42 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x171b22, metalness: 0.05, roughness: 0.92 }),
      white: new THREE.MeshStandardMaterial({ color: 0xe9eef4, metalness: 0.15, roughness: 0.5 }),
      bodyBlue: new THREE.MeshStandardMaterial({ color: 0x3d9fdd, metalness: 0.28, roughness: 0.42 }),
      bodyBlueDark: new THREE.MeshStandardMaterial({ color: 0x1f7cb8, metalness: 0.34, roughness: 0.40 }),
      silver: new THREE.MeshStandardMaterial({ color: 0xd9e0e8, metalness: 0.45, roughness: 0.36 }),
      violet: new THREE.MeshStandardMaterial({ color: 0x8b7bd6, metalness: 0.35, roughness: 0.38 }),
      red: new THREE.MeshStandardMaterial({ color: 0xd23c2f, metalness: 0.2, roughness: 0.55 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xcbe7f7, metalness: 0.1, roughness: 0.08, transparent: true, opacity: 0.42 }),
      led: new THREE.MeshStandardMaterial({ color: 0x22d37a, emissive: 0x22d37a, emissiveIntensity: 2.0 }),
      orange: new THREE.MeshStandardMaterial({ color: 0xff8a1e, metalness: 0.2, roughness: 0.45 }),
      amber: new THREE.MeshStandardMaterial({ color: 0xffa31a, emissive: 0xff8a00, emissiveIntensity: 0.85, roughness: 0.32 }),
      laser: new THREE.MeshStandardMaterial({ color: 0xff2b2b, emissive: 0xff2b2b, emissiveIntensity: 2.2 })
    };

    const noise = this.makeSurfaceNoise();
    [['steel', 0.0025], ['silver', 0.0018], ['white', 0.0016], ['bodyBlue', 0.0014], ['bodyBlueDark', 0.0014], ['rubber', 0.003]].forEach(([key, scale]) => {
      const m = this.materials[key];
      if (!m) return;
      m.bumpMap = noise;
      m.bumpScale = scale;
      m.needsUpdate = true;
    });
    this.buildChassis();
    this.buildArm();
    this.buildHose();
    this.setJoints(this.computeHomeJoints());
  }

  RobotRig.prototype.addMesh = function (parent, geo, mat, layer, pos, rot) {
    const m = new THREE.Mesh(geo, mat);
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.layer = layer || 'arm';
    parent.add(m);
    if (m.userData.layer === 'chassis') this.chassisMeshes.push(m);
    else if (m.userData.layer === 'nozzle') this.nozzleMeshes.push(m);
    else if (m.userData.layer === 'arm') this.armMeshes.push(m);
    return m;
  };

  RobotRig.prototype.labelTexture = function (text, sub) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0b4f8f';
    ctx.fillRect(0, 0, 512, 128);
    const g = ctx.createLinearGradient(0, 0, 512, 0);
    g.addColorStop(0, 'rgba(255,255,255,.18)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,.12)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 55px "Segoe UI", Arial';
    ctx.textAlign = 'center';
    ctx.fillText(text, 256, 66);
    if (sub) {
      ctx.fillStyle = '#ffcc00';
      ctx.font = '600 22px "Microsoft YaHei", Arial';
      ctx.fillText(sub, 256, 101);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  RobotRig.prototype.makeSurfaceNoise = function () {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 150 + Math.floor(Math.random() * 95);
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    return tex;
  };

  RobotRig.prototype.makeWarningTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f2c200';
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = '#1b1f26';
    ctx.lineWidth = 16;
    for (let x = -64; x < 320; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 64); ctx.lineTo(x + 64, 0);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  RobotRig.prototype.makeScreenTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 160;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#081521';
    ctx.fillRect(0, 0, 256, 160);
    const g = ctx.createLinearGradient(0, 0, 0, 54);
    g.addColorStop(0, '#0d6fb5');
    g.addColorStop(1, '#084a7d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 54);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px "Microsoft YaHei", Arial';
    ctx.fillText('QZ-1', 14, 34);
    ctx.fillStyle = '#bfe2ff';
    ctx.font = '13px "Microsoft YaHei", Arial';
    ctx.fillText('功能性涂层施工机器人', 14, 50);
    const rows = [['运行状态', '正常'], ['系统压力', '0.42 MPa'], ['涂料余量', '86 %'], ['作业模式', '自动']];
    ctx.font = '14px "Microsoft YaHei", Arial';
    rows.forEach((row, i) => {
      const y = 82 + i * 20;
      ctx.fillStyle = '#9fb4c6';
      ctx.fillText(row[0], 16, y);
      ctx.fillStyle = i === 0 ? '#3ade8a' : '#e8f1f8';
      ctx.textAlign = 'right';
      ctx.fillText(row[1], 200, y);
      ctx.textAlign = 'left';
    });
    ctx.fillStyle = '#3ade8a';
    ctx.beginPath(); ctx.arc(222, 30, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1b3b52';
    ctx.lineWidth = 1;
    for (let y = 0; y < 160; y += 8) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  RobotRig.prototype.makeEstopTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 34;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f2c200';
    ctx.fillRect(0, 0, 128, 34);
    ctx.strokeStyle = '#161a20';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, 124, 30);
    ctx.fillStyle = '#161a20';
    ctx.font = 'bold 16px "Microsoft YaHei", Arial';
    ctx.textAlign = 'center';
    ctx.fillText('急停 E-STOP', 64, 23);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  RobotRig.prototype.buildChassis = function () {
    const M = this.materials;
    this.chassisGroup = new THREE.Group();
    this.chassisGroup.name = 'Chassis';
    this.root.add(this.chassisGroup);

    /* 低矮型蓝色 AGV 底盘：前后方向为 +z，车身纵向布置 */
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.90, 0.07, 1.24), M.dark, 'chassis', [0, 0.135, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.92, 0.24, 1.26), M.bodyBlue, 'chassis', [0, 0.29, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.94, 0.05, 1.28), M.bodyBlueDark, 'chassis', [0, 0.17, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.98, 0.035, 1.32), M.steel, 'chassis', [0, 0.425, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.90, 0.026, 1.22), M.silver, 'chassis', [0, 0.452, -0.02]);

    // 中部驱动轮 + 四角万向轮：轮毂、胎面细节，可滚动/转向
    this.driveWheels = [];
    this.casters = [];
    [-1, 1].forEach((s) => {
      const spin = new THREE.Group();
      spin.position.set(s * 0.445, 0.175, -0.10);
      this.chassisGroup.add(spin);
      this.addMesh(spin, new THREE.CylinderGeometry(0.17, 0.17, 0.13, 28), M.rubber, 'chassis', [0, 0, 0], [0, 0, Math.PI / 2]);
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2;
        this.addMesh(spin, new THREE.BoxGeometry(0.132, 0.02, 0.03), M.dark, 'chassis', [0, Math.cos(a) * 0.168, Math.sin(a) * 0.168], [a, 0, 0]);
      }
      this.addMesh(spin, new THREE.CylinderGeometry(0.085, 0.085, 0.145, 24), M.steel, 'chassis', [0, 0, 0], [0, 0, Math.PI / 2]);
      this.addMesh(spin, new THREE.CylinderGeometry(0.055, 0.055, 0.018, 20), M.silver, 'chassis', [s * 0.078, 0, 0], [0, 0, Math.PI / 2]);
      this.addMesh(spin, new THREE.CylinderGeometry(0.018, 0.018, 0.03, 12), M.dark, 'chassis', [s * 0.09, 0, 0], [0, 0, Math.PI / 2]);
      for (let i = 0; i < 5; i++) {
        const a = i / 5 * Math.PI * 2 + 0.25;
        this.addMesh(spin, new THREE.CylinderGeometry(0.01, 0.01, 0.014, 8), M.dark, 'chassis',
          [s * 0.078, Math.cos(a) * 0.045, Math.sin(a) * 0.045], [0, 0, Math.PI / 2]);
      }
      this.driveWheels.push({ spin: spin, x: s * 0.445, radius: 0.17 });
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.03, 0.21, 0.13), M.dark, 'chassis', [s * 0.375, 0.175, -0.10]);
      for (let i = 0; i < 4; i++) {
        const a = Math.PI * (0.22 + i * 0.18);
        this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.02, 0.018, 0.06), M.bodyBlueDark, 'chassis',
          [s * 0.478, 0.175 + Math.sin(a) * 0.205, -0.10 + Math.cos(a) * 0.205], [a, 0, 0]);
      }
    });
    [[-0.34, 0.46], [0.34, 0.46], [-0.34, -0.50], [0.34, -0.50]].forEach(([x, z]) => {
      const steer = new THREE.Group();
      steer.position.set(x, 0, z);
      this.chassisGroup.add(steer);
      const spin = new THREE.Group();
      spin.position.y = 0.09;
      steer.add(spin);
      this.addMesh(spin, new THREE.CylinderGeometry(0.09, 0.09, 0.07, 20), M.red, 'chassis', [0, 0, 0], [0, 0, Math.PI / 2]);
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2;
        this.addMesh(spin, new THREE.BoxGeometry(0.072, 0.012, 0.02), M.dark, 'chassis', [0, Math.cos(a) * 0.088, Math.sin(a) * 0.088], [a, 0, 0]);
      }
      this.addMesh(spin, new THREE.CylinderGeometry(0.042, 0.042, 0.075, 16), M.steel, 'chassis', [0, 0, 0], [0, 0, Math.PI / 2]);
      [-1, 1].forEach((ss) => {
        this.addMesh(spin, new THREE.CylinderGeometry(0.015, 0.015, 0.012, 10), M.dark, 'chassis', [ss * 0.041, 0, 0], [0, 0, Math.PI / 2]);
        for (let i = 0; i < 3; i++) {
          const a = i / 3 * Math.PI * 2;
          this.addMesh(spin, new THREE.CylinderGeometry(0.008, 0.008, 0.012, 8), M.dark, 'chassis',
            [ss * 0.038, Math.cos(a) * 0.025, Math.sin(a) * 0.025], [0, 0, Math.PI / 2]);
        }
      });
      // 转向叉架与回转轴承
      [-1, 1].forEach((ss) => {
        this.addMesh(steer, new THREE.BoxGeometry(0.012, 0.13, 0.07), M.dark, 'chassis', [ss * 0.046, 0.145, 0]);
      });
      this.addMesh(steer, new THREE.BoxGeometry(0.11, 0.035, 0.075), M.dark, 'chassis', [0, 0.21, 0]);
      this.addMesh(steer, new THREE.CylinderGeometry(0.045, 0.045, 0.03, 14), M.steel, 'chassis', [0, 0.235, 0]);
      this.casters.push({ steer: steer, spin: spin, x: x, z: z, radius: 0.09, angle: 0 });
    });

    // 侧检修板、斜向散热格栅、螺栓
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.008, 0.11, 0.24), M.bodyBlueDark, 'chassis', [s * 0.462, 0.29, 0.15]);
      for (let i = 0; i < 5; i++) {
        this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.006, 0.085, 0.016), M.silver, 'chassis', [s * 0.464, 0.245, 0.44 + i * 0.040], [Math.PI / 4, 0, 0]);
      }
      [0.25, 0.37].forEach((z) => [0.24, 0.34].forEach((y) => {
        this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.007, 0.007, 0.006, 8), M.dark, 'chassis', [s * 0.467, y, z], [0, 0, Math.PI / 2]);
      }));
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.012, 0.05, 1.26), M.silver, 'chassis', [s * 0.458, 0.175, 0]);
    });

    /* 车身机柜：高柜式蓝色箱体，白色骨架，正面黑色屏幕 */
    const cabY0 = 0.44, cabH = 1.28, cabZ = -0.36, cabD = 0.52;
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.88, cabH, cabD), M.bodyBlue, 'chassis', [0, cabY0 + cabH / 2, cabZ]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.92, 0.05, cabD + 0.04), M.silver, 'chassis', [0, cabY0 + cabH + 0.005, cabZ]);
    [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.022, cabH, 0.022), M.silver, 'chassis', [sx * 0.442, cabY0 + cabH / 2, cabZ + sz * (cabD / 2)]);
    }));
    [-1, 1].forEach((s) => {
      const fx = s * 0.443;
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.016, 0.022, cabD), M.silver, 'chassis', [fx, cabY0 + cabH - 0.018, cabZ]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.016, 0.022, cabD), M.silver, 'chassis', [fx, cabY0 + 0.018, cabZ]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.016, cabH, 0.022), M.silver, 'chassis', [fx, cabY0 + cabH / 2, cabZ + cabD / 2]);
    });
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.006, 0.014, cabD - 0.04), M.bodyBlueDark, 'chassis', [s * 0.443, cabY0 + cabH * 0.52, cabZ]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.004, 0.012, cabD - 0.06), M.bodyBlueDark, 'chassis', [s * 0.443, cabY0 + 0.17, cabZ]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.012, 0.22, 0.024), M.dark, 'chassis', [s * 0.447, cabY0 + cabH * 0.45, cabZ + 0.19]);
    });
    const fz = cabZ + cabD / 2 + 0.002;
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.36, 0.30, 0.03), M.dark, 'chassis', [0.10, cabY0 + 0.98, fz]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.30, 0.24, 0.012), M.glass, 'chassis', [0.10, cabY0 + 0.99, fz + 0.014]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.024, 0.024, 0.018, 16), M.red, 'chassis', [0.175, cabY0 + 0.76, fz + 0.014], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.021, 0.021, 0.018, 16), M.white, 'chassis', [0.10, cabY0 + 0.76, fz + 0.014], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.34, 0.008, 0.012), M.bodyBlueDark, 'chassis', [0.10, cabY0 + 0.62, fz]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.012, 0.20, 0.028), M.dark, 'chassis', [0.35, cabY0 + 0.34, fz + 0.01]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.16, 0.035, 0.12), M.dark, 'chassis', [0.20, cabY0 + cabH + 0.045, cabZ - 0.10]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8), M.steel, 'chassis', [-0.26, cabY0 + cabH + 0.10, cabZ - 0.14]);

    /* 背部细节：后门、检修口、散热栅与把手 */
    const rz = cabZ - cabD / 2 - 0.004;
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.72, 1.05, 0.012), M.bodyBlueDark, 'chassis', [0, cabY0 + 0.66, rz]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.76, 0.02, 0.018), M.silver, 'chassis', [0, cabY0 + 1.185, rz]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.76, 0.02, 0.018), M.silver, 'chassis', [0, cabY0 + 0.135, rz]);
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.02, 1.05, 0.018), M.silver, 'chassis', [s * 0.37, cabY0 + 0.66, rz]);
    });
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.006, 1.02, 0.008), M.bodyBlue, 'chassis', [0.21, cabY0 + 0.66, rz - 0.006]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.012, 0.20, 0.022), M.dark, 'chassis', [0.325, cabY0 + 0.62, rz - 0.012]);
    // 后背下部检修口 + 螺栓
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.26, 0.14, 0.012), M.bodyBlue, 'chassis', [-0.20, cabY0 + 0.34, rz - 0.004]);
    [-1, 1].forEach((sx) => [-1, 1].forEach((sy) => {
      this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.007, 0.007, 0.006, 8), M.dark, 'chassis', [-0.20 + sx * 0.10, cabY0 + 0.34 + sy * 0.05, rz - 0.012], [Math.PI / 2, 0, 0]);
    }));
    // 底部白色斜撑与后部插座
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.035, 0.30, 0.03), M.white, 'chassis', [s * 0.40, 0.56, -0.58], [0.5 * s, 0, 0]);
    });
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.09, 0.10, 0.02), M.dark, 'chassis', [0.28, 0.66, rz - 0.006]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.022, 0.022, 0.03, 12), M.steel, 'chassis', [0.28, 0.68, rz - 0.022], [Math.PI / 2, 0, 0]);
    // 底盘后部检修板、散热栅与红色接口
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.26, 0.13, 0.012), M.bodyBlueDark, 'chassis', [-0.18, 0.27, -0.636]);
    [-1, 1].forEach((sx) => [-1, 1].forEach((sy) => {
      this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.007, 0.007, 0.006, 8), M.dark, 'chassis', [-0.18 + sx * 0.10, 0.27 + sy * 0.045, -0.645], [Math.PI / 2, 0, 0]);
    }));
    for (let i = 0; i < 5; i++) {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.016, 0.085, 0.006), M.silver, 'chassis', [0.20 + i * 0.032, 0.25, -0.638], [0, 0, Math.PI / 4]);
    }
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.06, 0.08, 0.02), M.red, 'chassis', [0.35, 0.20, -0.638]);

    /* 细节：铭牌、顶部警示灯、拉手、防撞条与散热栅 */
    const brandTex = this.labelTexture('QZ-1', 'FUNCTIONAL COATING ROBOT');
    const brandMat = new THREE.MeshStandardMaterial({ map: brandTex, roughness: 0.55, metalness: 0.12 });
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.PlaneGeometry(0.42, 0.105), brandMat, 'chassis',
        [s * 0.447, cabY0 + 0.62, cabZ], [0, s * Math.PI / 2, 0]);
    });
    this.addMesh(this.chassisGroup, new THREE.PlaneGeometry(0.34, 0.085), brandMat, 'chassis',
      [0, cabY0 + 0.95, rz - 0.009], [0, Math.PI, 0]);
    // 侧出管口
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 16), M.steel, 'chassis', [0.455, 0.78, -0.30], [0, 0, Math.PI / 2]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.017, 0.017, 0.018, 12), M.dark, 'chassis', [0.485, 0.78, -0.30], [0, 0, Math.PI / 2]);
    // 门铰链、锁扣与尾部警示条
    [-1, 1].forEach((s) => {
      [cabY0 + 0.15, cabY0 + 1.13].forEach((y) => {
        this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.02, 0.075, 0.05), M.steel, 'chassis', [s * 0.447, y, cabZ + 0.19]);
        this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.011, 0.011, 0.03, 8), M.steel, 'chassis', [s * 0.457, y, cabZ + 0.19], [0, 0, Math.PI / 2]);
      });
    });
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.055, 0.10, 0.03), M.steel, 'chassis', [0.40, cabY0 + 0.62, cabZ + 0.21]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.03, 0.04, 0.02), M.dark, 'chassis', [0.40, cabY0 + 0.62, cabZ + 0.23]);
    const warnMat = new THREE.MeshStandardMaterial({ map: this.makeWarningTexture(), roughness: 0.55, metalness: 0.05 });
    this.addMesh(this.chassisGroup, new THREE.PlaneGeometry(0.54, 0.11), warnMat, 'chassis', [0, 0.34, -0.636], [0, Math.PI, 0]);
    // 后部显示屏、状态灯与急停按钮
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.40, 0.26, 0.03), M.dark, 'chassis', [0, cabY0 + 0.72, rz - 0.014]);
    const screenMat = new THREE.MeshBasicMaterial({ map: this.makeScreenTexture() });
    this.addMesh(this.chassisGroup, new THREE.PlaneGeometry(0.355, 0.215), screenMat, 'chassis', [0, cabY0 + 0.72, rz - 0.031], [0, Math.PI, 0]);
    [-0.13, 0, 0.13].forEach((x, i) => {
      this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.012, 0.012, 0.012, 10), [M.led, M.amber, M.red][i], 'chassis', [x, cabY0 + 0.54, rz - 0.026], [Math.PI / 2, 0, 0]);
    });
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.072, 0.072, 0.022, 20), M.yellow, 'chassis', [0.30, cabY0 + 0.48, rz - 0.028], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.055, 0.055, 0.038, 20), M.dark, 'chassis', [0.30, cabY0 + 0.48, rz - 0.050], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.054, 0.058, 0.03, 20), M.red, 'chassis', [0.30, cabY0 + 0.48, rz - 0.072], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.SphereGeometry(0.056, 20, 12), M.red, 'chassis', [0.30, cabY0 + 0.48, rz - 0.087]);
    const estopMat = new THREE.MeshBasicMaterial({ map: this.makeEstopTexture() });
    this.addMesh(this.chassisGroup, new THREE.PlaneGeometry(0.19, 0.05), estopMat, 'chassis', [0.30, cabY0 + 0.38, rz - 0.017], [0, Math.PI, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.024, 0.024, 0.02, 16), M.steel, 'chassis', [-0.32, cabY0 + 0.48, rz - 0.028], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.018, 0.018, 0.022, 16), M.led, 'chassis', [-0.32, cabY0 + 0.48, rz - 0.046], [Math.PI / 2, 0, 0]);
    // 顶部橙色警示灯
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.052, 0.058, 0.028, 18), M.steel, 'chassis', [0.30, cabY0 + cabH + 0.014, cabZ]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.045, 0.045, 0.065, 18), M.amber, 'chassis', [0.30, cabY0 + cabH + 0.058, cabZ]);
    this.addMesh(this.chassisGroup, new THREE.SphereGeometry(0.045, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.amber, 'chassis', [0.30, cabY0 + cabH + 0.09, cabZ]);
    // 顶部拉手
    [-0.24, 0.24].forEach((x) => {
      [-0.07, 0.07].forEach((dz) => {
        this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.018, 0.055, 0.018), M.steel, 'chassis', [x, cabY0 + cabH + 0.028, cabZ + dz]);
      });
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.018, 0.018, 0.16), M.steel, 'chassis', [x, cabY0 + cabH + 0.055, cabZ]);
    });
    // 顶部散热栅
    for (let i = 0; i < 5; i++) {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.5, 0.005, 0.012), M.dark, 'chassis', [0, cabY0 + cabH + 0.009, cabZ - 0.14 + i * 0.045]);
    }
    // 四角橡胶防撞块 + 黄色反光条
    [[-0.462, 0.61], [0.462, 0.61], [-0.462, -0.61], [0.462, -0.61]].forEach(([x, z]) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.03, 0.16, 0.05), M.rubber, 'chassis', [x, 0.29, z]);
    });
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.006, 0.028, 1.02), M.yellow, 'chassis', [s * 0.467, 0.225, 0]);
    });
    // 后部盘绕电缆与接头
    this.addMesh(this.chassisGroup, new THREE.TorusGeometry(0.07, 0.012, 6, 18), M.rubber, 'chassis', [0.22, 0.82, rz - 0.02]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.028, 0.028, 0.05, 14), M.steel, 'chassis', [0.22, 0.72, rz - 0.03], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.034, 0.034, 0.012, 14), M.red, 'chassis', [0.22, 0.70, rz - 0.03], [Math.PI / 2, 0, 0]);

    /* 前立柱升降导轨（视觉结构，不新增运动轴） */
    const railZ = cabZ + cabD / 2 + 0.012;
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.075, 1.10, 0.028), M.dark, 'chassis', [-0.33, 1.02, railZ]);
    for (let i = 0; i < 14; i++) {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.057, 0.012, 0.014), M.steel, 'chassis', [-0.33, 0.52 + i * 0.075, railZ + 0.018]);
    }
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.13, 0.13, 0.09), M.bodyBlue, 'chassis', [-0.33, 0.90, railZ + 0.05]);
  };
  RobotRig.prototype.buildArm = function () {
    const M = this.materials;
    const L1 = R.L1, L2 = R.L2;
    this.armBase = new THREE.Group();
    this.armBase.name = 'ArmBase';
    this.root.add(this.armBase);

    /* 机身前伸托板 + 白色立柱 + 蓝色回转法兰 */
    this.addMesh(this.armBase, new THREE.BoxGeometry(0.66, 0.055, 0.50), M.bodyBlue, 'arm', [0, 0.465, 0.16]);
    this.addMesh(this.armBase, new THREE.BoxGeometry(0.66, 0.022, 0.03), M.silver, 'arm', [0, 0.44, 0.405]);
    this.addMesh(this.armBase, new THREE.BoxGeometry(0.34, 0.30, 0.34), M.white, 'arm', [0, 0.625, 0.02]);
    this.addMesh(this.armBase, new THREE.BoxGeometry(0.36, 0.028, 0.36), M.steel, 'arm', [0, 0.485, 0.02]);
    this.addMesh(this.armBase, new THREE.CylinderGeometry(0.27, 0.30, 0.10, 32), M.bodyBlue, 'arm', [0, 0.765, 0.02]);
    this.addMesh(this.armBase, new THREE.CylinderGeometry(0.245, 0.245, 0.03, 32), M.dark, 'arm', [0, 0.822, 0.02]);

    const j1 = new THREE.Group(); j1.name = 'J1'; j1.position.set(0, R.baseY, 0); this.armBase.add(j1);
    this.addMesh(j1, new THREE.CylinderGeometry(0.235, 0.25, 0.14, 32), M.bodyBlue, 'arm', [0, 0.05, 0]);
    this.addMesh(j1, new THREE.CylinderGeometry(0.18, 0.18, 0.20, 24), M.white, 'arm', [0, 0.12, 0]);
    [-1, 1].forEach((s) => {
      this.addMesh(j1, new THREE.BoxGeometry(0.05, 0.20, 0.17), M.white, 'arm', [s * 0.115, 0.17, 0]);
    });
    this.addMesh(j1, new THREE.BoxGeometry(0.28, 0.16, 0.11), M.bodyBlueDark, 'arm', [0, 0.16, -0.10]);

    const j2 = new THREE.Group(); j2.name = 'J2'; j2.position.set(0, R.shoulderY, 0); j1.add(j2);
    this.addMesh(j2, new THREE.CylinderGeometry(0.195, 0.195, 0.34, 30), M.dark, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j2, new THREE.CylinderGeometry(0.185, 0.185, 0.38, 30), M.bodyBlue, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j2, new THREE.CylinderGeometry(0.10, 0.10, 0.40, 20), M.steel, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);

    // 大臂：白色主连杆、黑色侧板、银色端盖与走线管
    this.addMesh(j2, new THREE.BoxGeometry(0.17, 0.21, 0.70), M.white, 'arm', [0, 0, 0.47]);
    this.addMesh(j2, new THREE.BoxGeometry(0.145, 0.175, 0.28), M.white, 'arm', [0, 0, 0.94]);
    this.addMesh(j2, new THREE.BoxGeometry(0.022, 0.235, 0.62), M.dark, 'arm', [0.088, 0, 0.46]);
    this.addMesh(j2, new THREE.BoxGeometry(0.022, 0.235, 0.62), M.dark, 'arm', [-0.088, 0, 0.46]);
    this.addMesh(j2, new THREE.BoxGeometry(0.08, 0.02, 0.66), M.silver, 'arm', [0, 0.112, 0.48]);
    this.addMesh(j2, new THREE.BoxGeometry(0.175, 0.215, 0.05), M.bodyBlue, 'arm', [0, 0, 0.20]);
    this.addMesh(j2, new THREE.CylinderGeometry(0.018, 0.018, 0.80, 12), M.dark, 'arm', [0, -0.115, 0.50], [Math.PI / 2, 0, 0]);

    const j3 = new THREE.Group(); j3.name = 'J3'; j3.position.set(0, 0, L1); j2.add(j3);
    this.jointGroups.push(j1, j2, j3);
    this.addMesh(j3, new THREE.CylinderGeometry(0.165, 0.165, 0.30, 28), M.dark, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j3, new THREE.CylinderGeometry(0.15, 0.15, 0.32, 28), M.bodyBlue, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j3, new THREE.CylinderGeometry(0.085, 0.085, 0.34, 20), M.steel, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);

    // 小臂：白色细长圆管 + 蓝色卡箍 + 走线
    this.addMesh(j3, new THREE.CylinderGeometry(0.072, 0.078, 0.72, 24), M.white, 'arm', [0, 0, 0.45], [Math.PI / 2, 0, 0]);
    this.addMesh(j3, new THREE.CylinderGeometry(0.082, 0.082, 0.05, 24), M.bodyBlue, 'arm', [0, 0, 0.10], [Math.PI / 2, 0, 0]);
    this.addMesh(j3, new THREE.BoxGeometry(0.03, 0.012, 0.64), M.dark, 'arm', [0, 0.062, 0.45]);
    this.addMesh(j3, new THREE.CylinderGeometry(0.028, 0.028, 0.64, 12), M.dark, 'arm', [0, -0.085, 0.45], [Math.PI / 2, 0, 0]);
    this.addMesh(j3, new THREE.CylinderGeometry(0.085, 0.08, 0.06, 24), M.steel, 'arm', [0, 0, 0.83], [Math.PI / 2, 0, 0]);

    const j4 = new THREE.Group(); j4.name = 'J4'; j4.position.set(0, 0, L2); j3.add(j4);
    this.addMesh(j4, new THREE.CylinderGeometry(0.12, 0.12, 0.20, 24), M.white, 'arm', [0, 0, 0.02], [Math.PI / 2, 0, 0]);
    this.addMesh(j4, new THREE.CylinderGeometry(0.088, 0.088, 0.225, 24), M.bodyBlue, 'arm', [0, 0, 0.02], [Math.PI / 2, 0, 0]);
    this.addMesh(j4, new THREE.BoxGeometry(0.14, 0.13, 0.10), M.white, 'arm', [0, 0, 0.11]);

    const j5 = new THREE.Group(); j5.name = 'J5'; j5.position.set(0, 0, 0); j4.add(j5);
    this.addMesh(j5, new THREE.CylinderGeometry(0.085, 0.085, 0.18, 22), M.bodyBlue, 'arm', [0, 0, 0.06], [0, 0, Math.PI / 2]);
    this.addMesh(j5, new THREE.CylinderGeometry(0.055, 0.055, 0.19, 18), M.steel, 'arm', [0, 0, 0.06], [0, 0, Math.PI / 2]);
    this.addMesh(j5, new THREE.BoxGeometry(0.11, 0.10, 0.10), M.white, 'arm', [0, 0, 0.10]);

    const j6 = new THREE.Group(); j6.name = 'J6'; j6.position.set(0, 0, 0.14); j5.add(j6);
    this.jointGroups.push(j4, j5, j6);
    this.addMesh(j6, new THREE.CylinderGeometry(0.09, 0.09, 0.06, 22), M.steel, 'arm', [0, 0, 0.03], [Math.PI / 2, 0, 0]);
    this.addMesh(j6, new THREE.BoxGeometry(0.13, 0.115, 0.14), M.white, 'arm', [0, 0, 0.10]);
    this.addMesh(j6, new THREE.BoxGeometry(0.135, 0.02, 0.14), M.bodyBlue, 'arm', [0, 0.055, 0.10]);

    /* 关节细节：伺服电机罩、紧固螺栓、走线卡箍与腕部护套 */
    this.addMesh(j2, new THREE.CylinderGeometry(0.115, 0.115, 0.15, 20), M.dark, 'arm', [-0.235, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j2, new THREE.CylinderGeometry(0.10, 0.10, 0.03, 20), M.steel, 'arm', [-0.32, 0, 0], [0, 0, Math.PI / 2]);
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2;
      this.addMesh(j2, new THREE.CylinderGeometry(0.012, 0.012, 0.012, 8), M.steel, 'arm',
        [0.176, Math.cos(a) * 0.13, Math.sin(a) * 0.13], [0, 0, Math.PI / 2]);
    }
    [0.30, 0.58, 0.82].forEach((z, i) => {
      this.addMesh(j2, new THREE.BoxGeometry(0.2, 0.028, 0.03), i % 2 ? M.steel : M.dark, 'arm', [0, 0.122, z]);
    });
    this.addMesh(j2, new THREE.CylinderGeometry(0.012, 0.012, 0.72, 8), M.steel, 'arm', [0.075, 0.132, 0.48], [Math.PI / 2, 0, 0]);
    this.addMesh(j3, new THREE.CylinderGeometry(0.10, 0.10, 0.13, 20), M.dark, 'arm', [-0.20, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j3, new THREE.CylinderGeometry(0.088, 0.088, 0.03, 20), M.steel, 'arm', [-0.27, 0, 0], [0, 0, Math.PI / 2]);
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2;
      this.addMesh(j3, new THREE.CylinderGeometry(0.011, 0.011, 0.012, 8), M.steel, 'arm',
        [0.166, Math.cos(a) * 0.11, Math.sin(a) * 0.11], [0, 0, Math.PI / 2]);
    }
    [0.24, 0.49, 0.73].forEach((z, i) => {
      this.addMesh(j3, new THREE.TorusGeometry(0.086, 0.011, 6, 18), i % 2 ? M.bodyBlue : M.dark, 'arm', [0, 0, z]);
    });
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2;
      this.addMesh(j4, new THREE.CylinderGeometry(0.01, 0.01, 0.01, 8), M.steel, 'arm',
        [Math.cos(a) * 0.07, Math.sin(a) * 0.07, 0.128], [Math.PI / 2, 0, 0]);
    }

    // 末端工具安装座（喷涂枪 / 刮刀 / 砂盘共用）
    this.toolMount = new THREE.Group();
    this.toolMount.name = 'ToolMount';
    j6.add(this.toolMount);

    // 喷枪组件（单独图层）：白色枪身 + 紫色喷嘴
    this.nozzleGroup = new THREE.Group();
    this.nozzleGroup.name = 'Tool_Spray';
    this.toolMount.add(this.nozzleGroup);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.085, 0.085, 0.03, 20), M.steel, 'nozzle', [0, 0, 0.175], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.16, 0.11, 0.12), M.white, 'nozzle', [0, 0, 0.245]);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.165, 0.02, 0.12), M.violet, 'nozzle', [0, 0.058, 0.245]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.05, 0.062, 0.04, 20), M.dark, 'nozzle', [0, 0, 0.315], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.014, 0.048, 0.045, 20), M.violet, 'nozzle', [0, 0, 0.328], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.02, 0.02, 0.06, 12), M.bodyBlue, 'nozzle', [0, 0.072, 0.215], [0, 0, Math.PI / 2]);

    /* 喷枪细节：气帽锁环、压力表、气液接头与激光定位 */
    this.addMesh(this.nozzleGroup, new THREE.TorusGeometry(0.05, 0.011, 8, 20), M.steel, 'nozzle', [0, 0, 0.334]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.058, 0.058, 0.018, 6), M.dark, 'nozzle', [0, 0, 0.306], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.032, 0.032, 0.02, 16), M.silver, 'nozzle', [0.075, 0.05, 0.245], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.026, 0.026, 0.006, 16), M.white, 'nozzle', [0.075, 0.05, 0.257], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.002, 0.019, 0.002), M.red, 'nozzle', [0.075, 0.058, 0.261]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), M.steel, 'nozzle', [0.06, -0.055, 0.19], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.023, 0.023, 0.008, 12), M.bodyBlue, 'nozzle', [0.06, -0.055, 0.215], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.015, 0.015, 0.045, 10), M.steel, 'nozzle', [-0.05, -0.06, 0.19], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.02, 0.02, 0.008, 12), M.red, 'nozzle', [-0.05, -0.06, 0.212], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.036, 0.028, 0.05), M.dark, 'nozzle', [0.045, 0.056, 0.195]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.008, 0.008, 0.012, 10), M.laser, 'nozzle', [0.045, 0.056, 0.226], [Math.PI / 2, 0, 0]);

    /* 喷枪精细件：调节旋钮、扳机、气帽孔、流体针、接料口与标识 */
    [-0.055, 0.055].forEach((x) => {
      this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.016, 0.016, 0.026, 12), M.dark, 'nozzle', [x, 0.063, 0.205]);
      this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.010, 0.010, 0.032, 10), M.silver, 'nozzle', [x, 0.078, 0.205]);
    });
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.021, 0.021, 0.026, 16), M.dark, 'nozzle', [0.089, 0.012, 0.222], [0, 0, Math.PI / 2]);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.024, 0.06, 0.05), M.dark, 'nozzle', [0, -0.075, 0.225], [0.25, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.07, 0.012, 0.05), M.dark, 'nozzle', [0, -0.102, 0.225]);
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2;
      this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.0045, 0.0045, 0.012, 6), M.dark, 'nozzle',
        [Math.cos(a) * 0.035, Math.sin(a) * 0.035, 0.338], [Math.PI / 2, 0, 0]);
    }
    this.addMesh(this.nozzleGroup, new THREE.ConeGeometry(0.008, 0.02, 12), M.silver, 'nozzle', [0, 0, 0.34], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.016, 0.016, 0.032, 12), M.steel, 'nozzle', [0, -0.085, 0.17], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.022, 0.022, 0.008, 12), M.bodyBlue, 'nozzle', [0, -0.085, 0.188], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.07, 0.012, 0.032), M.violet, 'nozzle', [0, 0.058, 0.202]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.006, 0.006, 0.008, 8), M.led, 'nozzle', [0.072, 0.032, 0.205], [0, 0, Math.PI / 2]);
    [-1, 1].forEach((s) => {
      [0.21, 0.275].forEach((z) => {
        this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.005, 0.005, 0.008, 8), M.dark, 'nozzle', [s * 0.074, 0.032, z], [0, 0, Math.PI / 2]);
      });
    });

    this.tcp = new THREE.Object3D();
    this.tcp.name = 'TCP';
    this.tcp.position.set(0, 0, 0.35);
    j6.add(this.tcp);
    this.tcpRef = this.tcp;
    this.root.updateMatrixWorld(true);
  };
  RobotRig.prototype.buildHose = function () {
    this.hoseGroup = new THREE.Group();
    this.hoseGroup.name = 'Hose';
    this.scene.add(this.hoseGroup);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.makeHoseTexture(), roughness: 0.72, metalness: 0.06 });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.hoseMesh = mesh;
    this.hoseGroup.add(mesh);
    this._hoseStartLocal = new THREE.Vector3(0.49, 0.78, -0.30);
    this._hosePts = null;
    this._hoseVel = null;
    this._hoseLastTarget = null;
    this.updateHose(true, 0.016);
  };

  RobotRig.prototype.makeHoseTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 32;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#20262f';
    ctx.fillRect(0, 0, 64, 32);
    for (let x = 0; x < 64; x += 8) {
      ctx.fillStyle = '#2c3541';
      ctx.fillRect(x, 0, 3, 32);
      ctx.fillStyle = '#151a21';
      ctx.fillRect(x + 4, 0, 2, 32);
    }
    for (let i = 0; i < 90; i++) {
      const g = 30 + Math.floor(Math.random() * 24);
      ctx.fillStyle = 'rgba(' + g + ',' + (g + 6) + ',' + (g + 12) + ',.35)';
      ctx.fillRect(Math.random() * 64, Math.random() * 32, 1, 1);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(20, 1);
    return tex;
  };

  // 输料管目标控制点：底盘出管口 → 大臂 → 小臂 → 腕部 → 喷枪接料口
  RobotRig.prototype.hoseTargets = function () {
    const g = this.jointGroups;
    const start = this.root.localToWorld(this._hoseStartLocal.clone());
    if (g.length !== 6) return [start, this.getTCP().position.clone()];
    const toW = (obj, p) => obj.localToWorld(p);
    const pts = [
      start,
      toW(g[1], new THREE.Vector3(0, 0.165, 0.32)),
      toW(g[1], new THREE.Vector3(0, 0.165, 0.72)),
      toW(g[2], new THREE.Vector3(0, 0.12, 0.28)),
      toW(g[2], new THREE.Vector3(0, 0.10, 0.64)),
      toW(g[4], new THREE.Vector3(0, -0.055, 0.03))
    ];
    const endParent = this.toolMount || this.nozzleGroup || this.tcp;
    const endLocal = new THREE.Vector3(0, -0.085, 0.17);
    pts.push(endParent.localToWorld(endLocal));
    return pts;
  };

  RobotRig.prototype.updateHose = function (force, dt) {
    if (!this.hoseMesh) return;
    this.root.updateMatrixWorld(true);
    const targets = this.hoseTargets();
    const n = targets.length;
    const endJump = this._hoseLastTarget ? targets[n - 1].distanceTo(this._hoseLastTarget) : 0;
    if (force || !this._hosePts || this._hosePts.length !== n || endJump > 0.55) {
      this._hosePts = targets.map((p) => p.clone());
      this._hoseVel = targets.map(() => new THREE.Vector3());
    } else {
      const h = Math.max(0.016, Math.min(0.12, dt || 0.09));
      const stiffness = 34, damping = 9, maxV = 5.5;
      for (let i = 1; i < n - 1; i++) {
        const p = this._hosePts[i], v = this._hoseVel[i], t = targets[i];
        const ty = t.y - 0.018 * Math.sin(Math.PI * i / (n - 1));
        v.x += ((t.x - p.x) * stiffness - v.x * damping) * h;
        v.y += ((ty - p.y) * stiffness - v.y * damping) * h;
        v.z += ((t.z - p.z) * stiffness - v.z * damping) * h;
        v.clampLength(0, maxV);
        p.addScaledVector(v, h);
      }
      this._hosePts[0].copy(targets[0]);
      this._hosePts[n - 1].copy(targets[n - 1]);
    }
    this._hoseLastTarget = targets[n - 1].clone();
    const curve = new THREE.CatmullRomCurve3(this._hosePts, false, 'catmullrom', 0.35);
    const geo = new THREE.TubeGeometry(curve, 54, 0.015, 8, false);
    this.hoseMesh.geometry.dispose();
    this.hoseMesh.geometry = geo;
  };

  RobotRig.prototype.setJoints = function (angles) {
    const arr = angles.map((v, i) => U.clamp(Number(v) || 0, R.joints[i].min, R.joints[i].max));
    this.currentJoints = arr;
    const [j1, j2, j3, j4, j5, j6] = arr.map(U.deg);
    if (this.jointGroups.length === 6) {
      this.jointGroups[0].rotation.y = j1;
      this.jointGroups[1].rotation.x = j2;
      this.jointGroups[2].rotation.x = j3;
      this.jointGroups[3].rotation.z = j4;
      this.jointGroups[4].rotation.x = j5;
      this.jointGroups[5].rotation.z = j6;
    }
    this.root.updateMatrixWorld(true);
    if (this.custom) this.syncCustomJoints(arr);
  };

  RobotRig.prototype.getJoints = function () { return this.currentJoints.slice(); };

  RobotRig.prototype.setBasePose = function (x, z, yaw) {
    if (typeof x === 'number') this.basePos.x = x;
    if (typeof z === 'number') this.basePos.z = z;
    if (typeof yaw === 'number') this.baseYaw = U.norm180(yaw);
    this.root.position.set(this.basePos.x, 0, this.basePos.z);
    this.root.rotation.y = this.baseYaw;
    this.root.updateMatrixWorld(true);
  };

  RobotRig.prototype.getBasePose = function () {
    return { x: this.basePos.x, z: this.basePos.z, yaw: this.baseYaw };
  };

  RobotRig.prototype.getTCP = function () {
    const ref = this.tcpRef || this.tcp;
    this.root.updateMatrixWorld(true);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    ref.getWorldPosition(position);
    ref.getWorldQuaternion(quaternion);
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
    return { position, direction, quaternion };
  };

  RobotRig.prototype.getSamplePoints = function () {
    this.root.updateMatrixWorld(true);
    const pts = [];
    const add = (obj) => {
      if (!obj) return;
      const p = new THREE.Vector3();
      obj.getWorldPosition(p);
      pts.push(p);
    };
    if (this.jointGroups.length === 6) {
      add(this.jointGroups[0]);
      add(this.jointGroups[1]);
      add(this.jointGroups[2]);
      add(this.jointGroups[3]);
      add(this.jointGroups[4]);
      add(this.jointGroups[5]);
      add(this.tcpRef || this.tcp);
      // 沿大臂、小臂、腕部加密采样，避免长连杆中段穿墙/穿机体被漏检
      const linkSample = (a, b, ts) => {
        const p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
        a.getWorldPosition(p1);
        b.getWorldPosition(p2);
        ts.forEach((t) => pts.push(p1.clone().lerp(p2, t)));
      };
      linkSample(this.jointGroups[1], this.jointGroups[2], [0.2, 0.4, 0.6, 0.8]);
      linkSample(this.jointGroups[2], this.jointGroups[3], [0.25, 0.5, 0.75]);
      linkSample(this.jointGroups[3], this.jointGroups[4], [0.5]);
      linkSample(this.jointGroups[4], this.jointGroups[5], [0.5]);
      linkSample(this.jointGroups[5], this.tcpRef || this.tcp, [0.5]);
    }
    return pts;
  };

  // 机体自身碰撞：机柜、底盘、前托板（局部坐标包围盒）
  RobotRig.prototype.bodyCollision = function (points, margin) {
    if (!this.bodyBoxes) {
      this.bodyBoxes = [
        { name: '机柜', min: [-0.44, 0.44, -0.63], max: [0.44, 1.72, -0.10] },
        { name: '底盘', min: [-0.47, 0.05, -0.66], max: [0.47, 0.455, 0.66] },
        { name: '前托板', min: [-0.33, 0.43, -0.09], max: [0.33, 0.49, 0.42] }
      ];
    }
    const m = margin == null ? 0.04 : margin;
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < points.length; i++) {
      const q = this.root.worldToLocal(points[i].clone());
      for (let b = 0; b < this.bodyBoxes.length; b++) {
        const box = this.bodyBoxes[b];
        if (q.x > box.min[0] - m && q.x < box.max[0] + m &&
          q.y > box.min[1] - m && q.y < box.max[1] + m &&
          q.z > box.min[2] - m && q.z < box.max[2] + m) {
          return { hit: true, reason: box.name, point: points[i] };
        }
      }
    }
    return { hit: false };
  };

  RobotRig.prototype.setLayer = function (name, visible) {
    this._layerState[name] = !!visible;
    if (name === 'chassis') {
      this.chassisMeshes.forEach((m) => { m.visible = visible; });
    } else if (name === 'arm') {
      this.armMeshes.forEach((m) => { m.visible = visible && !this.custom; });
      if (this.custom && this.custom.group) this.custom.group.visible = !!visible;
    } else if (name === 'nozzle') {
      this.nozzleMeshes.forEach((m) => { m.visible = visible && !this.custom; });
      if (this.toolMount) this.toolMount.visible = visible && !this.custom;
      if (SB.Tools && SB.Tools.applyVisibility) SB.Tools.applyVisibility(visible);
    } else if (name === 'hose' && this.hoseGroup) {
      this.hoseGroup.visible = visible;
    }
  };

  RobotRig.prototype.updateWheels = function (dt) {
    if (!this.driveWheels || !this.casters) return;
    if (!this._wheelLast) {
      this._wheelLast = { x: this.basePos.x, z: this.basePos.z, yaw: this.baseYaw };
      return;
    }
    const last = this._wheelLast;
    const dx = this.basePos.x - last.x;
    const dz = this.basePos.z - last.z;
    const dyaw = U.norm180(this.baseYaw - last.yaw);
    if (Math.hypot(dx, dz) > 0.6 || Math.abs(dyaw) > 0.8) {
      this._wheelLast = { x: this.basePos.x, z: this.basePos.z, yaw: this.baseYaw };
      return;
    }
    if (Math.hypot(dx, dz) < 1e-5 && Math.abs(dyaw) < 1e-5) return;
    const cos = Math.cos(last.yaw), sin = Math.sin(last.yaw);
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    const omega = dt > 1e-4 ? dyaw / dt : 0;
    // 驱动轮随行进/差速转动
    this.driveWheels.forEach((w) => {
      w.spin.rotation.x += (lz - omega * w.x) / w.radius;
    });
    // 万向轮：按该轮处的合成速度转向，并沿滚动方向自转
    this.casters.forEach((c) => {
      const vx = lx + omega * c.z;
      const vz = lz - omega * c.x;
      const speed = Math.hypot(vx, vz);
      if (speed < 0.004) return;
      const target = Math.atan2(vx, vz);
      const diff = U.norm180(target - c.angle);
      const step = Math.min(Math.abs(diff), (2.2 + speed * 2.5) * dt);
      c.angle = U.norm180(c.angle + Math.sign(diff) * step);
      c.steer.rotation.y = c.angle;
      const along = vx * Math.sin(c.angle) + vz * Math.cos(c.angle);
      c.spin.rotation.x += along / c.radius;
    });
    this._wheelLast = { x: this.basePos.x, z: this.basePos.z, yaw: this.baseYaw };
  };

  RobotRig.prototype.update = function (dt) {
    this._hoseClock += dt;
    if (this._hoseClock > 0.09) {
      this._hoseClock = 0;
      this.updateHose(false, 0.09);
    }
    this.updateWheels(dt);
  };
  RobotRig.prototype.computeHomeJoints = function () {
    // 目标点按底盘当前朝向转换到世界坐标，侧墙作业时也保持在机器人正前方
    const yaw = this.baseYaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const target = new THREE.Vector3(
      this.basePos.x + fx * 1.15 + rx * -0.4,
      1.45,
      this.basePos.z + fz * 1.15 + rz * -0.4
    );
    const sol = this.solveIK(target, new THREE.Vector3(fx, 0, fz));
    if (sol && sol.angles.every((v) => isFinite(v))) return sol.angles;
    return [0, -35, 70, 0, -35, 0];
  };

  // 转运姿态：机械臂收拢在设备前方，避免从机柜顶部翻越造成穿模
  RobotRig.prototype.computeTransportJoints = function () {
    const yaw = this.baseYaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const target = new THREE.Vector3(this.basePos.x + fx * 0.9, 1.4, this.basePos.z + fz * 0.9);
    const sol = this.solveIK(target, new THREE.Vector3(0, -1, 0), this.currentJoints);
    if (sol && sol.angles.every((v) => isFinite(v))) return sol.angles;
    return this.computeHomeJoints();
  };

  /**
   * 解析逆解。
   * @param {THREE.Vector3} target 喷枪 TCP 目标
   * @param {THREE.Vector3} direction 喷枪方向
   * @param {number[]} [preferred] 连续性参考关节角
   * @param {number} [branch] 指定肘部分支（1 / -1），省略时自动选择
   */
  RobotRig.prototype.solveIK = function (target, direction, preferred, branch) {
    const P = target.clone ? target.clone() : new THREE.Vector3(target[0], target[1], target[2]);
    const D = direction.clone ? direction.clone() : new THREE.Vector3(direction[0], direction[1], direction[2]);
    if (D.lengthSq() < 1e-9) return null;
    D.normalize();
    const base = new THREE.Vector3(this.basePos.x, 0, this.basePos.z);
    const shoulder = new THREE.Vector3(base.x, R.baseY + R.shoulderY, base.z);
    const L1 = R.L1, L2 = R.L2, L3 = R.L3;

    const wrist = P.clone().addScaledVector(D, -L3);
    const dx = wrist.x - base.x;
    const dz = wrist.z - base.z;
    const thetaW = Math.atan2(dx, dz);
    const j1 = U.norm180(U.rad(thetaW - this.baseYaw));
    const r = Math.hypot(dx, dz);
    const wy = wrist.y - shoulder.y;
    let rw = r, wyw = wy;
    const reach = L1 + L2;
    const minReach = Math.abs(L1 - L2) + 0.02;
    const R0 = Math.hypot(rw, wyw);
    let scaled = false;
    if (R0 > reach - 0.008) {
      const k = (reach - 0.008) / Math.max(R0, 1e-6);
      rw *= k; wyw *= k; scaled = true;
    } else if (R0 < minReach) {
      const k = minReach / Math.max(R0, 1e-6);
      rw *= k; wyw *= k; scaled = true;
    }
    const R2 = Math.hypot(rw, wyw);
    if (R2 < 1e-6) return null;
    const phi = Math.atan2(wyw, rw);
    const cosAlpha = U.clamp((L1 * L1 + R2 * R2 - L2 * L2) / (2 * L1 * R2), -1, 1);
    const alpha = Math.acos(cosAlpha);
    const c = Math.cos(thetaW), s = Math.sin(thetaW);
    const Dlx = D.x * c - D.z * s;
    const Dly = D.y;
    const Dlz = D.x * s + D.z * c;

    let candidates = [];
    [1, -1].forEach((sign) => {
      const beta1 = phi + sign * alpha;
      const er = L1 * Math.cos(beta1);
      const ey = L1 * Math.sin(beta1);
      const beta2 = Math.atan2(wyw - ey, rw - er);
      const j2 = U.rad(-beta1);
      const j3 = U.rad(-(beta2 - beta1));
      const a = U.deg(j2 + j3);
      const sinA = Math.sin(a), cosA = Math.cos(a);
      const dot = -Dly * sinA + Dlz * cosA;
      const perp = Math.sqrt(Math.max(0, 1 - dot * dot));
      let j4 = U.rad(Math.atan2(Dlx, -(Dly * Math.cos(a) + Dlz * Math.sin(a))));
      let j5 = U.rad(Math.atan2(perp, dot));
      if (Math.abs(j5) > 130) { j4 = U.norm180(j4 + 180); j5 = -j5; }
      if (Math.abs(j5) > 130) { j4 = U.norm180(j4 + 180); j5 = -j5; }
      candidates.push({ angles: [j1, j2, j3, U.norm180(j4), j5, 0], sign });
      // 腕部翻转等价解：J4+180、J5 取反。经过 J5=0 的奇异位形时，
      // 该解可避免 J4 突跳约 180°，由连续性评分自动择优。
      if (Math.abs(j5) <= 130) {
        candidates.push({ angles: [j1, j2, j3, U.norm180(j4 + 180), -j5, 0], sign });
      }
    });

    const scoreCandidate = (cand) => {
      const angles = cand.angles;
      let violation = 0, out = 0;
      for (let i = 0; i < 6; i++) {
        const jt = R.joints[i];
        if (angles[i] < jt.min || angles[i] > jt.max) {
          out++;
          violation += angles[i] < jt.min ? jt.min - angles[i] : angles[i] - jt.max;
        }
      }
      let continuity = 0;
      if (preferred && preferred.length === 6) {
        for (let i = 0; i < 6; i++) continuity += Math.abs(U.norm180(angles[i] - preferred[i]));
      }
      return out * 1000 + violation * 60 + continuity * 0.35 + (cand.sign > 0 ? 0 : 45) +
        Math.abs(angles[3]) * 0.03 + Math.abs(angles[4]) * 0.06;
    };
    if (branch === 1 || branch === -1) {
      candidates = candidates.filter((cand) => cand.sign === branch);
      if (!candidates.length) return null;
    }
    candidates.sort((A, B) => scoreCandidate(A) - scoreCandidate(B));
    const best = candidates[0];
    const angles = best.angles.map((v, i) => U.clamp(v, R.joints[i].min, R.joints[i].max));
    const fk = this.forward(angles);
    const posErr = fk.position.distanceTo(P);
    const dirErr = U.rad(Math.acos(U.clamp(fk.direction.dot(D), -1, 1)));
    const limitOK = angles.every((v, i) => v >= R.joints[i].min - 1e-6 && v <= R.joints[i].max + 1e-6);
    return {
      angles, reachable: !scaled && limitOK && posErr < 0.02 && dirErr < 2,
      scaled, limitOK, posError: posErr, dirError: dirErr, fk, branch: best.sign
    };
  };
  RobotRig.prototype.forward = function (angles) {
    const a2 = U.deg(angles[1]);
    const a3 = U.deg(angles[2]);
    const a = a2 + a3;
    const rW = R.L1 * Math.cos(a2) + R.L2 * Math.cos(a);
    const yW = -R.L1 * Math.sin(a2) - R.L2 * Math.sin(a);
    const j4 = U.deg(angles[3]);
    const j5 = U.deg(angles[4]);
    const sinA = Math.sin(a), cosA = Math.cos(a);
    const dirLocal = new THREE.Vector3(
      Math.sin(j5) * Math.sin(j4),
      -Math.sin(j5) * Math.cos(j4) * cosA - Math.cos(j5) * sinA,
      -Math.sin(j5) * Math.cos(j4) * sinA + Math.cos(j5) * cosA
    ).normalize();
    const local = new THREE.Vector3(0, yW, rW).addScaledVector(dirLocal, R.L3);
    const theta = this.baseYaw + U.deg(angles[0]);
    const c = Math.cos(theta), s = Math.sin(theta);
    const shoulder = new THREE.Vector3(this.basePos.x, R.baseY + R.shoulderY, this.basePos.z);
    const position = new THREE.Vector3(
      shoulder.x + local.x * c + local.z * s,
      shoulder.y + local.y,
      shoulder.z - local.x * s + local.z * c
    );
    const direction = new THREE.Vector3(
      dirLocal.x * c + dirLocal.z * s,
      dirLocal.y,
      -dirLocal.x * s + dirLocal.z * c
    ).normalize();
    return { position, direction };
  };

  RobotRig.prototype.selfTest = function () {
    const Rm = C.room;
    const saved = this.getBasePose();
    const tests = [];
    const run = (name, base, p, d) => {
      this.setBasePose(base[0], base[1], base[2]);
      const sol = this.solveIK(new THREE.Vector3(...p), new THREE.Vector3(...d));
      if (!sol) {
        tests.push({ name: name, ok: false, error: '无解' });
        return;
      }
      tests.push({
        name: name,
        ok: sol.posError < 0.02 && sol.dirError < 2,
        posError: Number((sol.posError * 1000).toFixed(3)),
        dirError: Number(sol.dirError.toFixed(3)),
        angles: sol.angles.map((v) => Number(v.toFixed(2)))
      });
    };
    run('墙面中心', [0, Rm.wallZ + 1.9, R.yawOffset], [0, 1.55, Rm.wallZ + 0.34], [0, 0, -1]);
    run('墙面向右', [0, Rm.wallZ + 1.9, R.yawOffset], [1.2, 1.7, Rm.wallZ + 0.34], [0, 0, -1]);
    run('天花板', [0, 0, R.yawOffset], [0, Rm.height - 0.34, -0.6], [0, 1, 0]);
    run('地面', [0, 0, R.yawOffset], [0, 0.34, -1.1], [0, -1, 0]);
    this.setBasePose(saved.x, saved.z, saved.yaw);
    return tests;
  };
  RobotRig.prototype.loadGLB = function (file) {
    const self = this;
    return new Promise((resolve, reject) => {
      if (!file) { reject(new Error('未选择文件')); return; }
      if (!window.THREE.GLTFLoader) { reject(new Error('GLTFLoader 未加载')); return; }
      const url = URL.createObjectURL(file);
      const loader = new THREE.GLTFLoader();
      loader.load(url, (gltf) => {
        URL.revokeObjectURL(url);
        try {
          const info = self.applyCustomModel(gltf, file.name);
          resolve(info);
        } catch (e) {
          reject(e);
        }
      }, undefined, (err) => {
        URL.revokeObjectURL(url);
        reject(new Error('GLB 解析失败：' + (err && err.message ? err.message : '格式不支持')));
      });
    });
  };

  RobotRig.prototype.applyCustomModel = function (gltf, fileName) {
    const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (!scene) throw new Error('GLB 中未找到场景');
    const wanted = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'];
    const found = {};
    scene.traverse((obj) => {
      if (!obj.name) return;
      const n = obj.name.toLowerCase();
      const hit = wanted.find((w) => n === w.toLowerCase() || n.startsWith(w.toLowerCase() + '_') || n.startsWith(w.toLowerCase() + '-'));
      if (hit && !found[hit]) found[hit] = obj;
    });
    const missing = wanted.filter((w) => !found[w]);
    if (missing.length) throw new Error('GLB 缺少关节节点：' + missing.join(', ') + '（需命名为 J1–J6）');

    if (this.custom && this.custom.group) {
      this.root.remove(this.custom.group);
    }
    scene.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.userData.layer = 'custom';
      }
    });
    this.root.add(scene);

    const baseQuats = {};
    wanted.forEach((name) => {
      baseQuats[name] = found[name].quaternion.clone();
    });
    let tip = null;
    scene.traverse((obj) => {
      if (tip) return;
      const n = (obj.name || '').toLowerCase();
      if (n === 'tip' || n === 'tcp' || n === 'nozzle' || n.includes('nozzletip')) tip = obj;
    });
    if (!tip) {
      tip = new THREE.Object3D();
      tip.name = 'TIP_AUTO';
      tip.position.set(0, 0, 0.35);
      found.J6.add(tip);
    }

    this.custom = { group: scene, nodes: found, baseQuats, tip, fileName: fileName || 'custom.glb' };
    scene.visible = !!this._layerState.arm;
    this.armMeshes.forEach((m) => { m.visible = false; });
    this.nozzleMeshes.forEach((m) => { m.visible = false; });
    if (this.toolMount) this.toolMount.visible = false;
    this.tcpRef = tip;
    this.syncCustomJoints(this.currentJoints);
    this.root.updateMatrixWorld(true);
    this.updateHose(true);
    return { joints: wanted.length, fileName: this.custom.fileName };
  };

  RobotRig.prototype.syncCustomJoints = function (angles) {
    if (!this.custom) return;
    const axes = ['y', 'x', 'x', 'z', 'x', 'z'];
    const names = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'];
    for (let i = 0; i < 6; i++) {
      const node = this.custom.nodes[names[i]];
      if (!node) continue;
      const q = this.custom.baseQuats[names[i]].clone();
      const e = new THREE.Euler(0, 0, 0);
      e[axes[i]] = U.deg(angles[i]);
      q.multiply(new THREE.Quaternion().setFromEuler(e));
      node.quaternion.copy(q);
    }
    this.root.updateMatrixWorld(true);
  };

  RobotRig.prototype.resetModel = function () {
    if (this.custom && this.custom.group) {
      this.root.remove(this.custom.group);
      this.custom.group.traverse((obj) => {
        if (obj.isMesh) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => m.dispose());
          }
        }
      });
    }
    this.custom = null;
    this.tcpRef = this.tcp;
    this.armMeshes.forEach((m) => { m.visible = this._layerState.arm; });
    this.nozzleMeshes.forEach((m) => { m.visible = this._layerState.nozzle; });
    if (this.toolMount) this.toolMount.visible = this._layerState.nozzle;
    if (SB.Tools && SB.Tools.applyVisibility) SB.Tools.applyVisibility(this._layerState.nozzle);
    this.setJoints(this.currentJoints);
    this.updateHose(true);
  };

  SB.Robot = {
    init(sceneMgr) { return new RobotRig(sceneMgr); },
    RobotRig
  };
})();