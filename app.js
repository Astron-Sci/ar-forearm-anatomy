// app.js - 前臂与手部 AR 解剖调试版 v0.1
// 全新架构：MediaPipe Hands(21点) + Three.js GLB 模型 + 动作识别联动肌肉高亮
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

const state = {
  running: false,
  showBones: true,
  showMuscles: true,
  highlight: true,
  hand: null,           // 当前手部关键点
  handedness: null,     // Left / Right（已按前置镜像取反）
  landmarks: null,      // 归一化 21 点
  score: 0,
  actions: [],          // 识别出的动作列表
  smooth: false,        // 跟随平滑开关（首帧关闭，直接对齐）
  lastPalm: null,       // 上一帧掌面法线（时间连续性，解决叉积手性歧义）
  calib: { phase: 'idle', start: 0, ang: 0, qAlg: null, offset: null },  // 校准：idle|waiting|done
};

// ── Three.js 场景 ──
let scene, camera, renderer, modelRoot;
let bonesGroup, musclesGroup;
const boneMeshes = new Map();    // name -> THREE.Mesh
const muscleMeshes = new Map();  // name -> THREE.Mesh
let camFacingFront = true;

function initThree() {
  const c = $('three-container');
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, c.clientWidth / c.clientHeight, 0.01, 100);
  camera.position.set(0, 0, 1.2);
  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(c.clientWidth, c.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  c.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const d1 = new THREE.DirectionalLight(0xffffff, 1.2); d1.position.set(1, 2, 2); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.4); d2.position.set(-1, -1, -1); scene.add(d2);
  window.addEventListener('resize', () => {
    camera.aspect = c.clientWidth / c.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(c.clientWidth, c.clientHeight);
  });
}

async function loadModels() {
  const loader = new GLTFLoader();
  let b, m;
  try {
    const r = await Promise.all([
      loader.loadAsync('forearm_bones.glb'),
      loader.loadAsync('forearm_muscles.glb'),
    ]);
    b = r[0]; m = r[1];
    console.log('[load] bones.scene:', b.scene ? 'defined' : 'UNDEFINED', '| muscles.scene:', m.scene ? 'defined' : 'UNDEFINED');
    if (!b.scene) throw new Error('bones GLB 没有 scene (scene.nodes 为空?)');
    if (!m.scene) throw new Error('muscles GLB 没有 scene');
  } catch (e) {
    console.error('[load] fetch/parse error:', e.message);
    throw e;
  }
  bonesGroup = new THREE.Group();
  musclesGroup = new THREE.Group();

  // 注意：不能在 traverse 回调里直接 add 到别的组（会修改正在遍历的 children 数组）
  // 先收集，再统一添加
  const collectBones = [];
  b.scene.traverse(o => { if (o.isMesh) collectBones.push(o); });
  const collectMuscles = [];
  m.scene.traverse(o => { if (o.isMesh) collectMuscles.push(o); });
  console.log('[load] bones meshes:', collectBones.length, '| muscles meshes:', collectMuscles.length);

  // 烘焙步骤：
  // ① 先把 GLTF 节点树自身的变换合并进几何（GLB 内 mesh 节点可能带 position/rotation），
  //    并重置节点为单位变换 —— 否则包围盒/锚点全部算偏
  collectBones.forEach(o => {
    o.updateMatrixWorld(true);
    o.geometry.applyMatrix4(o.matrixWorld);
    o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
  });
  collectMuscles.forEach(o => {
    o.updateMatrixWorld(true);
    o.geometry.applyMatrix4(o.matrixWorld);
    o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
  });
  // ② 原始数据手指默认朝 -Z，先绕 Y 旋转 -90° 使手指朝 +X（与 updateModelFromHand 的旋转基准一致）
  // ③ 再绕 X 旋转 -90°：实测模型掌心朝 -Y（拇指+Z），转到掌心朝 +Z（朝镜头、拇指朝 +Y，与代码假设一致）
  collectBones.forEach(o => o.geometry.rotateY(-Math.PI / 2));
  collectMuscles.forEach(o => o.geometry.rotateY(-Math.PI / 2));
  collectBones.forEach(o => o.geometry.rotateX(-Math.PI / 2));
  collectMuscles.forEach(o => o.geometry.rotateX(-Math.PI / 2));

  // 先把所有 mesh 挂到一个临时组，计算整体包围盒
  const tmpAll = new THREE.Group();
  collectBones.forEach(o => tmpAll.add(o));
  collectMuscles.forEach(o => tmpAll.add(o));
  const boxAll = new THREE.Box3().setFromObject(tmpAll);
  const centerAll = boxAll.getCenter(new THREE.Vector3());
  const sizeAll = boxAll.getSize(new THREE.Vector3());
  const scaleAll = 0.55 / Math.max(sizeAll.x, sizeAll.y, sizeAll.z);
  console.log('[load] box center:', centerAll.toArray().map(n=>n.toFixed(1)).join(','), '| size:', sizeAll.toArray().map(n=>n.toFixed(1)).join(','), '| scale:', scaleAll.toFixed(4));

  // 把居中+缩放直接烘焙进 geometry（modelRoot 永远保持原点、单位缩放）
  collectBones.forEach(o => {
    o.name = o.name.replace(/_/g, ' ');
    o.geometry.translate(-centerAll.x, -centerAll.y, -centerAll.z);
    o.geometry.scale(scaleAll, scaleAll, scaleAll);
    o.material = new THREE.MeshPhongMaterial({
      color: 0xf0ead6, emissive: 0x888866, emissiveIntensity: 0.08,
      transparent: true, opacity: 0.99, shininess: 30, side: THREE.DoubleSide,
    });
    o.castShadow = false;
    bonesGroup.add(o);
    boneMeshes.set(o.name, o);
  });
  collectMuscles.forEach(o => {
    o.name = o.name.replace(/_/g, ' ');
    o.geometry.translate(-centerAll.x, -centerAll.y, -centerAll.z);
    o.geometry.scale(scaleAll, scaleAll, scaleAll);
    o.material = new THREE.MeshPhongMaterial({
      color: 0xcc5544, emissive: 0x552222, emissiveIntensity: 0.08,
      transparent: true, opacity: 0.85, shininess: 20, side: THREE.DoubleSide,
    });
    musclesGroup.add(o);
    muscleMeshes.set(o.name, o);
  });

  // ③ 腕骨锚点：8 块腕骨几何中心平均 → 整体平移到原点（手腕即锚点）
  const carp = computeCarpalAnchor();
  if (carp) {
    collectBones.forEach(o => o.geometry.translate(-carp.x, -carp.y, -carp.z));
    collectMuscles.forEach(o => o.geometry.translate(-carp.x, -carp.y, -carp.z));
    console.log('[load] carpal anchor:', carp.toArray().map(n => n.toFixed(3)).join(','));
  } else {
    console.warn('[load] 未找到腕骨，锚点保持包围盒中心');
  }

  modelRoot = new THREE.Group();
  modelRoot.add(bonesGroup);
  modelRoot.add(musclesGroup);
  // 模型已烘焙到原点附近，modelRoot 保持单位变换
  modelRoot.position.set(0, 0, 0);
  modelRoot.scale.set(1, 1, 1);

  scene.add(modelRoot);
  applyLayerVisibility();
  setStatus('模型加载完成');
}

// ── 图层控制 ──
function applyLayerVisibility() {
  if (bonesGroup) bonesGroup.visible = state.showBones;
  if (musclesGroup) musclesGroup.visible = state.showMuscles;
}

// ── 肌肉联动高亮 ──
// 每个动作 → 参与的肌肉名列表（与 GLB 节点名精确匹配）
const ACTION_MUSCLES = {
  '握拳': ['left flexor digitorum superficialis', 'left flexor digitorum superficialis (2)', 'left flexor digitorum profundus', 'set of lumbricals of left hand'],
  '伸指': ['left extensor digitorum', 'left extensor indicis', 'left extensor digiti minimi'],
  '屈腕': ['left flexor carpi radialis', 'left flexor carpi ulnaris', 'humeral head of left flexor carpi ulnaris', 'ulnar head of left flexor carpi ulnaris', 'left palmaris longus'],
  '伸腕': ['left extensor carpi radialis longus', 'left extensor carpi radialis brevis', 'left extensor carpi ulnaris', 'left extensor carpi ulnaris (2)'],
  '拇指屈': ['left flexor pollicis longus', 'left flexor pollicis brevis', 'superficial head of left flexor pollicis brevis'],
  '拇指伸': ['left extensor pollicis longus', 'left extensor pollicis brevis'],
  '拇指对掌': ['left opponens pollicis', 'left abductor pollicis brevis'],
  '旋前': ['left pronator teres', 'humeral head of left pronator teres', 'ulnar head of left pronator teres', 'left pronator quadratus'],
  '旋后': ['left supinator', 'left brachioradialis'],
};

const HIGHLIGHT_COLOR = 0xffd54f;   // 高亮金色
const MUSCLE_BASE = 0xcc5544;
const HIGHLIGHT_OPACITY = 0.95;

// ── 腕骨锚点 ──
const CARPAL_NAMES = ['left scaphoid', 'left lunate', 'left triquetral', 'left pisiform', 'left trapezium', 'left trapezoid', 'left capitate', 'left hamate'];
// 返回 8 块腕骨几何中心的平均（世界坐标，需在烘焙后调用）
function computeCarpalAnchor() {
  const acc = new THREE.Vector3();
  let n = 0;
  boneMeshes.forEach((m, name) => {
    if (CARPAL_NAMES.includes(name)) {
      m.geometry.computeBoundingBox();
      acc.add(m.geometry.boundingBox.getCenter(new THREE.Vector3()));
      n++;
    }
  });
  return n ? acc.divideScalar(n) : null;
}

function applyHighlight() {
  if (!musclesGroup) return;
  const active = new Set();
  state.actions.forEach(a => {
    (ACTION_MUSCLES[a] || []).forEach(n => active.add(n));
  });
  muscleMeshes.forEach((mesh, name) => {
    if (!state.highlight) {
      mesh.material.color.setHex(MUSCLE_BASE);
      mesh.material.opacity = 0.65;
      mesh.material.emissive.setHex(0x552222);
      return;
    }
    const on = active.has(name);
    mesh.material.color.setHex(on ? HIGHLIGHT_COLOR : MUSCLE_BASE);
    mesh.material.opacity = on ? HIGHLIGHT_OPACITY : 0.55;
    mesh.material.emissive.setHex(on ? 0x664400 : 0x552222);
  });
}

// ── 动作识别 ──
// 基于 21 点手部关键点（MediaPipe Hands 标准索引）
// 拇指: 1-4, 食指: 5-8, 中指: 9-12, 无名指: 13-16, 小指: 17-20, 腕: 0
function fingerCurl(lm, a, b, c, d) {
  // 计算 PIP(中间关节) 弯曲角：向量 ba 与 bc 的夹角
  const v1 = { x: lm[a].x - lm[b].x, y: lm[a].y - lm[b].y, z: lm[a].z - lm[b].z };
  const v2 = { x: lm[c].x - lm[b].x, y: lm[c].y - lm[b].y, z: lm[c].z - lm[b].z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const l1 = Math.hypot(v1.x, v1.y, v1.z), l2 = Math.hypot(v2.x, v2.y, v2.z);
  if (l1 < 1e-6 || l2 < 1e-6) return 0;
  const ang = Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2))));
  return ang * 180 / Math.PI;  // 0=伸直, 180=完全弯曲
}
function thumbCurl(lm) {
  // 拇指用 CMC-MCP 段与 MCP-IP 段夹角近似
  const v1 = { x: lm[1].x - lm[2].x, y: lm[1].y - lm[2].y, z: lm[1].z - lm[2].z };
  const v2 = { x: lm[3].x - lm[2].x, y: lm[3].y - lm[2].y, z: lm[3].z - lm[2].z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const l1 = Math.hypot(v1.x, v1.y, v1.z), l2 = Math.hypot(v2.x, v2.y, v2.z);
  if (l1 < 1e-6 || l2 < 1e-6) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2)))) * 180 / Math.PI;
}
function wristAngle(lm) {
  // 腕部弯曲：手腕(0) - 中指MCP(9) 方向 vs 中指MCP(9) - 中指PIP(10) 方向
  const v1 = { x: lm[0].x - lm[9].x, y: lm[0].y - lm[9].y, z: lm[0].z - lm[9].z };
  const v2 = { x: lm[10].x - lm[9].x, y: lm[10].y - lm[9].y, z: lm[10].z - lm[9].z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const l1 = Math.hypot(v1.x, v1.y, v1.z), l2 = Math.hypot(v2.x, v2.y, v2.z);
  if (l1 < 1e-6 || l2 < 1e-6) return 90;
  return Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2)))) * 180 / Math.PI;
}

function analyzeActions(lm) {
  const actions = [];
  // 四指弯曲（食中无名小）PIP 角
  const curls = [
    fingerCurl(lm, 5, 6, 7, 8),
    fingerCurl(lm, 9, 10, 11, 12),
    fingerCurl(lm, 13, 14, 15, 16),
    fingerCurl(lm, 17, 18, 19, 20),
  ];
  const avgCurl = curls.reduce((a, b) => a + b, 0) / 4;
  // 指尖到掌心（腕+中指MCP 中点）平均距离——握拳时指尖贴近掌心，辅助区分弯曲/自然手
  const pcx = (lm[0].x + lm[9].x) / 2, pcy = (lm[0].y + lm[9].y) / 2, pcz = (lm[0].z + lm[9].z) / 2;
  let tipDist = 0;
  [8, 12, 16, 20].forEach(t => { tipDist += Math.hypot(lm[t].x - pcx, lm[t].y - pcy, lm[t].z - pcz); });
  tipDist /= 4;

  // 握拳：PIP 弯曲（fingerCurl 语义：大=伸直 180°，小=弯曲 0°）；真实握拳 PIP 角约 60-100°+指尖贴掌心
  if (avgCurl < 100 && tipDist < 0.15) actions.push('握拳');
  // 伸指：PIP 近直（>150°）且指尖远离掌心（排除自然放松手）
  else if (avgCurl > 150 && tipDist > 0.15) actions.push('伸指');

  const tCurl = thumbCurl(lm);   // 同样语义：大=拇指伸直
  if (tCurl < 70) actions.push('拇指屈');
  else if (tCurl > 150) actions.push('拇指伸');

  // 拇指对掌：拇指尖(4) 与小指尖(20) 距离近（手掌摊开时更易触发）
  const dThumbPinky = Math.hypot(lm[4].x - lm[20].x, lm[4].y - lm[20].y, lm[4].z - lm[20].z);
  if (dThumbPinky < 0.14 && avgCurl > 100) actions.push('拇指对掌');

  // ── 旋前/旋后（手掌绕前臂轴翻转，掌法线前后倾）──
  // 掌法线 = 手指方向 × 掌宽方向（3D，含深度）
  const fx2 = lm[9].x - lm[0].x, fy2 = lm[9].y - lm[0].y, fz2 = lm[9].z - lm[0].z;
  const wx2 = lm[17].x - lm[5].x, wy2 = lm[17].y - lm[5].y, wz2 = lm[17].z - lm[5].z;
  const nx2 = fy2 * wz2 - fz2 * wy2, ny2 = fz2 * wx2 - fx2 * wz2, nz2 = fx2 * wy2 - fy2 * wx2;
  // 法线水平方位角：0=掌心朝镜头；±90°=旋前/旋后（手掌绕手指轴翻转）
  const nLen = Math.hypot(nx2, ny2, nz2);
  let supinating = false, pronating = false;
  if (nLen > 1e-4 && avgCurl > 100 && Math.abs(nz2) > 1e-3) {   // 手接近伸直才判（握拳时掌法线无意义）
    const roll = Math.atan2(nx2, nz2) * 180 / Math.PI;
    // 符号按左手：旋前掌心转向前臂尺侧（需实测确认，若反了互换）
    if (roll > 30) { actions.push('旋前'); pronating = true; }
    else if (roll < -30) { actions.push('旋后'); supinating = true; }
  }

  // 屈腕/伸腕：腕弯曲程度（中性≈180°）；方向用 PIP 相对 MCP 的深度
  // （MediaPipe z 越小越近相机；掌心朝镜头时屈腕=指尖向镜头弯，zBend<0）
  // 旋前/旋后状态下不判（避免翻转时误判）
  const wAng = wristAngle(lm);
  const bend = 180 - wAng;
  if (!supinating && !pronating && bend > 35) {
    actions.push((lm[10].z - lm[9].z) < 0 ? '屈腕' : '伸腕');
  }

  // 调试显示
  $('dbg-curl').textContent = avgCurl.toFixed(0) + '°';
  $('dbg-thumb').textContent = tCurl.toFixed(0) + '°';
  $('dbg-wrist').textContent = wAng.toFixed(0) + '°';
  return actions;
}

// ── 模型跟随手部 ──
// 模型本地基：手指 +X、掌心 +Z（朝镜头）、Y = Z×X（左手解剖，拇指侧 -Y）
// 相机在 (0,0,1.2) 朝 -Z，模型锚点（腕骨中心）对准 MediaPipe 腕点 lm[0]
const PALM_DEPTH = 1.2;                    // 相机到模型平面的距离
const CAM_FOV = 55;                        // 相机垂直 FOV
const MODEL_LEN = 0.55;                    // 模型烘焙后全长（前臂+手）
const REAL_ARM_LEN = 0.44;                 // 真实前臂+手全长 (m)
const REAL_HAND_LEN = 0.19;                // 真实手长：腕→中指指尖 (m)
const Z_GAIN = 1.5;                          // MediaPipe z 深度增益（近距时 z 易主导方向，调低）
const FINGER_Z_W = 0.3;                       // 手指方向中 z 分量权重（弱化，防深度主导 90° 偏转）
const SMOOTH_K = 0.55;                     // 跟随平滑系数（0-1，越大越跟手；调高提升翻转响应）
// 模型在 PALM_DEPTH 处时，屏幕归一化高度 1.0 对应的世界长度
const VIS_H = 2 * PALM_DEPTH * Math.tan(THREE.MathUtils.degToRad(CAM_FOV) / 2);
// 屏幕归一化手长 → 模型缩放系数：手长(屏幕) → 手世界长(≈手在模型深度) → 按真实比例放大到模型全长
const SCALE_K = (VIS_H / MODEL_LEN) * (REAL_ARM_LEN / REAL_HAND_LEN);

// 把 MediaPipe 归一化坐标（相对视频帧，未镜像）转为屏幕归一化坐标（0-1，y 向下，含 cover 裁剪修正 + 前置镜像）
function screenNorm(lm) {
  const v = $('video');
  const vw = v.videoWidth, vh = v.videoHeight;
  const sw = window.innerWidth, sh = window.innerHeight;
  let x = lm.x, y = lm.y;
  if (vw && vh) {
    // object-fit: cover：视频等比放大铺满屏幕，超出部分裁剪 → 修正偏移
    const s = Math.max(sw / vw, sh / vh);
    const dw = vw * s, dh = vh * s;
    x = (x * dw - (dw - sw) / 2) / sw;
    y = (y * dh - (dh - sh) / 2) / sh;
  }
  if (camFacingFront) x = 1 - x;   // 前置摄像头画面为镜像
  return { x, y };
}

// ── 模型校准（用户掌心朝镜头保持 3 秒，生成方向偏置补偿）──
const CALIB_MS = 3000;
function startCalib() {
  if (!modelRoot || !state.running) return;
  state.calib = { phase: 'waiting', start: performance.now(), ang: 0, qAlg: null, offset: null };
  show('overlayCalib');
  $('calibFill').style.width = '0%';
}
function finishCalib() {
  const c = state.calib;
  if (c.qAlg) {
    // 期望姿态：绕 Z 转手指屏幕角（掌心自然朝镜头）
    const qDesired = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), c.ang);
    c.offset = qDesired.multiply(c.qAlg.clone().invert());   // offset = desired × alg⁻¹
  }
  c.phase = 'done';
  hide('overlayCalib');
  toast('✅ 校准完成！模型已对齐');
}
function skipCalib() {
  state.calib.phase = 'done';
  state.calib.offset = null;
  hide('overlayCalib');
  toast('已跳过校准');
}

function updateModelFromHand(lm) {
  if (!modelRoot) return;
  // 屏幕归一化（0-1，已含 cover 修正 + 前置镜像）与物理空间 NDC（x 右、y 上、z 朝相机为正）
  const S = lm.map(p => screenNorm(p));
  const P = S.map(s => ({ x: s.x * 2 - 1, y: -(s.y * 2 - 1), z: 0 }));
  // z 深度（MediaPipe z 越小越近相机 → 取反+增益）
  lm.forEach((p, i) => { P[i].z = -p.z * Z_GAIN; });
  const p0 = P[0], p9 = P[9], p12 = P[12], p17 = P[17];

  // ── 位置：腕点 → 射线与 z=0 模型平面求交 ──
  const v = new THREE.Vector3(p0.x, p0.y, -1).unproject(camera);
  const dir = v.sub(camera.position).normalize();
  const t = PALM_DEPTH / Math.abs(dir.z);
  const targetPos = camera.position.clone().add(dir.multiplyScalar(t));

  // ── 缩放：手长（腕→中指指尖，屏幕归一化空间）→ 按真实比例映射到模型全长 ──
  const handLen = Math.hypot(S[12].x - S[0].x, S[12].y - S[0].y);
  const scale = THREE.MathUtils.clamp(handLen * SCALE_K, 0.4, 12);
  const targetScale = new THREE.Vector3(scale, scale, scale);

  // ── 3D 旋转：手指方向（X 轴）+ 掌面法线（Z 轴，掌心强制朝镜头）──
  // X 轴：腕 → 中指MCP（不受屈指影响，z 分量弱化防深度主导）
  const fx = (p9.x - p0.x), fy = (p9.y - p0.y), fz = (p9.z - p0.z) * FINGER_Z_W;
  let xAxis = new THREE.Vector3(fx, fy, fz);
  if (xAxis.lengthSq() > 1e-8) xAxis.normalize(); else xAxis.set(0, 1, 0);
  // Z 轴：掌面法线 = (中指MCP-腕) × (小指MCP-中指MCP)
  // 叉积符号有手性歧义，用时间连续性解决（首帧默认掌心朝镜头）
  const a1x = p9.x - p0.x, a1y = p9.y - p0.y, a1z = p9.z - p0.z;
  const a2x = p17.x - p9.x, a2y = p17.y - p9.y, a2z = p17.z - p9.z;
  let zAxis = new THREE.Vector3(
    a1y * a2z - a1z * a2y,
    a1z * a2x - a1x * a2z,
    a1x * a2y - a1y * a2x,
  );
  if (zAxis.lengthSq() < 1e-8) zAxis.set(0, 0, 1);
  zAxis.normalize();
  if (state.lastPalm) {
    if (zAxis.dot(state.lastPalm) < 0) zAxis.negate();
  } else if (zAxis.z < 0) {
    zAxis.negate();   // 首帧：默认掌心朝镜头
  }
  state.lastPalm = zAxis.clone();
  // 掌心跟随：去掉强混合压缩（模型基已修正，时间连续性 + 平滑已足够稳定；翻转幅度不再被压缩）
  // Gram-Schmidt 正交化：xAxis 去掉 zAxis 分量
  xAxis.addScaledVector(zAxis, -xAxis.dot(zAxis));
  if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
  xAxis.normalize();
  // Y 轴：Z × X（与模型本地基一致）
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  const targetQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis)
  );

  // ── 校准：等待期间采样手指方向角 + 算法四元数，3 秒后计算偏置 ──
  if (state.calib.phase === 'waiting') {
    state.calib.ang = Math.atan2(p9.y - p0.y, p9.x - p0.x);
    state.calib.qAlg = targetQuat.clone();
    const p = Math.min(1, (performance.now() - state.calib.start) / CALIB_MS);
    $('calibFill').style.width = (p * 100) + '%';
    if (p >= 1) finishCalib();
  }
  // 校准偏置补偿：final = offset × 算法旋转
  if (state.calib.offset) {
    targetQuat.premultiply(state.calib.offset);
  }

  // ── 平滑跟随（位置/旋转/缩放）──
  if (state.smooth) {
    modelRoot.position.lerp(targetPos, SMOOTH_K);
    modelRoot.quaternion.slerp(targetQuat, SMOOTH_K);
    modelRoot.scale.lerp(targetScale, SMOOTH_K);
  } else {
    modelRoot.position.copy(targetPos);
    modelRoot.quaternion.copy(targetQuat);
    modelRoot.scale.copy(targetScale);
    state.smooth = true;
  }
}

// ── MediaPipe Hands ──
let handsInst = null, camStream = null, frameLoop = true;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('加载失败: ' + src));
    document.head.appendChild(s);
  });
}

async function initHands() {
  if (typeof window.Hands !== 'undefined') return;
  await loadScript('https://unpkg.com/@mediapipe/hands/hands.js');
  await loadScript('https://unpkg.com/@mediapipe/camera_utils/camera_utils.js');
}

async function startCamera() {
  try {
    const constraints = camFacingFront
      ? { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } }
      : { video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } } };
    camStream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = $('video');
    video.srcObject = camStream;
    await video.play();
    // 前置摄像头镜像
    video.style.transform = camFacingFront ? 'scaleX(-1)' : 'scaleX(1)';

    handsInst = new window.Hands({ locateFile: f => 'https://unpkg.com/@mediapipe/hands/' + f });
    handsInst.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    handsInst.onResults(onHandResults);

    frameLoop = true;
    async function loop() {
      if (!frameLoop) return;
      if (video.readyState >= 2) {
        try { await handsInst.send({ image: video }); } catch (e) { /* 单帧失败忽略 */ }
      }
      requestAnimationFrame(loop);
    }
    loop();
    setStatus('识别中… 把手放到摄像头前');
  } catch (e) {
    setStatus('摄像头错误: ' + (e.name === 'NotAllowedError' ? '请允许摄像头权限' : e.message));
  }
}

function onHandResults(r) {
  if (!r || !r.multiHandLandmarks || r.multiHandLandmarks.length === 0) {
    state.hand = null;
    state.lastPalm = null;   // 手丢失后重置法线连续性（下次检测重新初始化）
    $('dbg-status').textContent = '未检测到手';
    $('dbg-score').textContent = '-';
    state.actions = [];
    applyHighlight();
    return;
  }
  state.hand = r.multiHandLandmarks[0];
  state.landmarks = state.hand;
  // MediaPipe 假定输入为镜像图（自拍/前置），前置原始帧本身即镜像 → 直接输出真实手性，无需取反；
  // 后置摄像头原始帧非镜像 → 需取反交换 Left/Right
  let label = r.multiHandedness && r.multiHandedness[0] ? r.multiHandedness[0].label : '?';
  if (!camFacingFront && (label === 'Left' || label === 'Right')) label = label === 'Left' ? 'Right' : 'Left';
  state.handedness = label;
  state.score = (r.multiHandedness && r.multiHandedness[0] ? r.multiHandedness[0].score : 0);
  $('dbg-score').textContent = state.score.toFixed(2);

  // 仅支持左手（模型为左手解剖）。识别到右手：隐藏模型并提示
  if (state.handedness === 'Right') {
    $('dbg-status').textContent = '⚠ 请伸出左手';
    if (modelRoot) modelRoot.visible = false;
    return;
  }
  if (modelRoot) modelRoot.visible = true;
  $('dbg-status').textContent = '✓ 左手';

  state.actions = analyzeActions(state.hand);
  $('dbg-action').textContent = state.actions.length ? state.actions.join('、') : '无';
  const mus = new Set();
  state.actions.forEach(a => (ACTION_MUSCLES[a] || []).forEach(n => mus.add(n)));
  $('dbg-muscles').textContent = mus.size ? mus.size + ' 块' : '-';
  applyHighlight();
  if (modelRoot) updateModelFromHand(state.hand);
}

// ── UI ──
function setStatus(m) {
  $('dbg-status').textContent = m;
}
function toast(m, ms = 2200) {
  const t = $('toast');
  t.textContent = m;
  show('toast');
  setTimeout(() => hide('toast'), ms);
}

function bindUI() {
  $('btn-start').addEventListener('click', async () => {
    hide('start-overlay');
    show('controls');
    try {
      await initHands();
      await startCamera();
      show('overlayCalib');   // 提前显示校准引导（模型加载中即可看到）
      await loadModels();
      animate();
      state.running = true;
      startCalib();   // 模型就绪，开始 3 秒计时
    } catch (e) {
      hide('overlayCalib');
      toast('启动失败: ' + e.message, 4000);
      console.error(e);
    }
  });
  $('btn-manual').addEventListener('click', async () => {
    hide('start-overlay');
    show('controls');
    try {
      await loadModels();
      if (camStream) camStream.getTracks().forEach(t => t.stop());
      frameLoop = false;
      // 手动模式：模型居中展示，可旋转（加轨道控制）
      if (!state.orbitAdded) {
        const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
        const c = $('three-container');
        c.style.pointerEvents = 'auto';
        state.orbit = new OrbitControls(camera, c);
        state.orbit.enableDamping = true;
        state.orbit.target.set(0, 0, 0);
        state.orbitAdded = true;
      }
      state.orbit.enabled = true;
      if (modelRoot) { modelRoot.visible = true; modelRoot.position.set(0, 0, 0); modelRoot.scale.set(1, 1, 1); modelRoot.rotation.set(0, 0, 0); }
      camera.position.set(0, 0, 1.2);
      animate();
      toast('手动查看模式：拖动旋转 / 滚轮缩放');
    } catch (e) {
      toast('加载失败: ' + e.message, 4000);
      console.error(e);
    }
  });
  $('btn-bones').addEventListener('click', () => {
    state.showBones = !state.showBones;
    $('btn-bones').classList.toggle('active', state.showBones);
    applyLayerVisibility();
  });
  $('btn-muscles').addEventListener('click', () => {
    state.showMuscles = !state.showMuscles;
    $('btn-muscles').classList.toggle('active', state.showMuscles);
    applyLayerVisibility();
  });
  $('btn-highlight').addEventListener('click', () => {
    state.highlight = !state.highlight;
    $('btn-highlight').classList.toggle('active', state.highlight);
    applyHighlight();
  });
  $('btn-cam').addEventListener('click', async () => {
    camFacingFront = !camFacingFront;
    if (camStream) camStream.getTracks().forEach(t => t.stop());
    if (handsInst) { try { handsInst.close && handsInst.close(); } catch (e) {} handsInst = null; }
    await startCamera();
  });
  $('btn-recalib').addEventListener('click', () => { if (state.running) startCalib(); });
  $('btn-calib-skip').addEventListener('click', skipCalib);
  $('btn-collapse').addEventListener('click', () => {
    const body = $('dbg-body');
    const hidden = body.classList.toggle('hidden');
    $('btn-collapse').textContent = hidden ? '+' : '—';
  });
}

function animate() {
  requestAnimationFrame(animate);
  if (renderer && scene && camera) renderer.render(scene, camera);
}

// ── 启动 ──
initThree();
animate();  // 渲染循环立即启动
bindUI();
// 暴露给调试工具
window.__ar = {
  get scene() { return scene; },
  get camera() { return camera; },
  get renderer() { return renderer; },
  startCalib, finishCalib, skipCalib,
  get modelRoot() { return modelRoot; },
  get bonesGroup() { return bonesGroup; },
  get musclesGroup() { return musclesGroup; },
  get state() { return state; },
  // 供 headless/调试注入假手部关键点：window.__ar.setHand(lm) 返回跟随结果
  onHandResults(r) { onHandResults(r); },
  setHand(lm) {
    if (!modelRoot) return { error: 'model not loaded' };
    state.handedness = state.handedness || 'Left';
    state.smooth = false;
    if (modelRoot) modelRoot.visible = true;
    updateModelFromHand(lm);
    state.smooth = true;
    return {
      pos: modelRoot.position.toArray(),
      scale: modelRoot.scale.toArray(),
      quat: modelRoot.quaternion.toArray(),
      euler: modelRoot.rotation.toArray(),
    };
  },
};

// 演示模式：?demo=1 自动进入手动查看（无需摄像头，供测试/预览）
if (new URLSearchParams(location.search).get('demo') === '1') {
  setTimeout(() => $('btn-manual').click(), 300);
}

