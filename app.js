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
  handedness: null,     // Left / Right
  landmarks: null,      // 归一化 21 点
  score: 0,
  actions: [],          // 识别出的动作列表
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
  // ② 原始数据手指默认朝 -Z，再绕 Y 旋转 -90° 使手指朝 +X（与 updateModelFromHand 的旋转基准一致）
  collectBones.forEach(o => o.geometry.rotateY(-Math.PI / 2));
  collectMuscles.forEach(o => o.geometry.rotateY(-Math.PI / 2));

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
  // 四指弯曲（食中无名小）
  const curls = [
    fingerCurl(lm, 5, 6, 7, 8),
    fingerCurl(lm, 9, 10, 11, 12),
    fingerCurl(lm, 13, 14, 15, 16),
    fingerCurl(lm, 17, 18, 19, 20),
  ];
  const avgCurl = curls.reduce((a, b) => a + b, 0) / 4;
  const tCurl = thumbCurl(lm);
  const wAng = wristAngle(lm);

  if (avgCurl > 100) actions.push('握拳');
  else if (avgCurl < 40) actions.push('伸指');
  if (tCurl > 90) actions.push('拇指屈');
  else if (tCurl < 35) actions.push('拇指伸');
  // 拇指对掌：拇指尖(4) 与小指尖(20) 距离近
  const dThumbPinky = Math.hypot(lm[4].x - lm[20].x, lm[4].y - lm[20].y, lm[4].z - lm[20].z);
  if (dThumbPinky < 0.12 && avgCurl > 60) actions.push('拇指对掌');
  if (wAng < 60) actions.push('屈腕');
  else if (wAng > 130) actions.push('伸腕');

  // 调试显示
  $('dbg-curl').textContent = avgCurl.toFixed(0) + '°';
  $('dbg-thumb').textContent = tCurl.toFixed(0) + '°';
  $('dbg-wrist').textContent = wAng.toFixed(0) + '°';
  return actions;
}

// ── 模型跟随手部 ──
// 相机在 (0,0,1.2) 朝 -Z，模型锚点（腕骨中心）对准 MediaPipe 腕点 lm[0]
const PALM_DEPTH = 1.2;                    // 相机到模型平面的距离
const CAM_FOV = 55;                        // 相机垂直 FOV
const MODEL_LEN = 0.55;                    // 模型烘焙后全长（前臂+手）
const REAL_ARM_LEN = 0.44;                 // 真实前臂+手全长 (m)
const REAL_HAND_LEN = 0.19;                // 真实手长：腕→中指指尖 (m)
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

function updateModelFromHand(lm) {
  if (!modelRoot) return;
  const p0 = screenNorm(lm[0]);    // 腕
  const p12 = screenNorm(lm[12]);  // 中指指尖

  // 位置：腕点 → NDC → 射线与 z=0 模型平面求交（比固定距离更精确）
  const ndcX = p0.x * 2 - 1;
  const ndcY = -(p0.y * 2 - 1);
  const v = new THREE.Vector3(ndcX, ndcY, -1).unproject(camera);
  const dir = v.sub(camera.position).normalize();
  const t = PALM_DEPTH / Math.abs(dir.z);
  modelRoot.position.copy(camera.position.clone().add(dir.multiplyScalar(t)));

  // 缩放：手长（腕→中指指尖，屏幕归一化）→ 按真实比例映射到模型全长
  const handLen = Math.hypot(p12.x - p0.x, p12.y - p0.y);
  const scale = THREE.MathUtils.clamp(handLen * SCALE_K, 0.4, 12);

  // 左右手镜像：模型为左手解剖结构，识别为右手时镜像成右手外观
  const isRight = state.handedness === 'Right';
  modelRoot.scale.set(isRight ? -scale : scale, scale, scale);

  // 朝向：模型手指默认朝 +X（烘焙时已旋转）；屏幕角 ang → 世界角 -ang；镜像时 π-ang
  const ang = Math.atan2(p12.y - p0.y, p12.x - p0.x);
  modelRoot.rotation.z = isRight ? Math.PI - ang : -ang;
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
    $('dbg-status').textContent = '未检测到手';
    $('dbg-score').textContent = '-';
    state.actions = [];
    applyHighlight();
    return;
  }
  state.hand = r.multiHandLandmarks[0];
  state.landmarks = state.hand;
  // 前置摄像头输入是镜像画面，MediaPipe 的 Left/Right 与实际相反 → 取反
  let label = r.multiHandedness && r.multiHandedness[0] ? r.multiHandedness[0].label : '?';
  if (camFacingFront && (label === 'Left' || label === 'Right')) label = label === 'Left' ? 'Right' : 'Left';
  state.handedness = label;
  state.score = (r.multiHandedness && r.multiHandedness[0] ? r.multiHandedness[0].score : 0);

  $('dbg-status').textContent = `✓ ${state.handedness}手${state.handedness === 'Right' ? '（已镜像）' : ''}`;
  $('dbg-score').textContent = state.score.toFixed(2);

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
      await loadModels();
      animate();
      state.running = true;
    } catch (e) {
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
      modelRoot.position.set(0, 0, 0);
      modelRoot.scale.set(1, 1, 1);
      modelRoot.rotation.set(0, 0, 0);
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
  get modelRoot() { return modelRoot; },
  get bonesGroup() { return bonesGroup; },
  get musclesGroup() { return musclesGroup; },
  get state() { return state; },
  // 供 headless/调试注入假手部关键点：window.__ar.setHand(lm) 返回跟随结果
  setHand(lm) {
    if (!modelRoot) return { error: 'model not loaded' };
    state.handedness = state.handedness || 'Left';
    updateModelFromHand(lm);
    return {
      pos: modelRoot.position.toArray(),
      scale: modelRoot.scale.toArray(),
      rot: modelRoot.rotation.toArray(),
    };
  },
};

// 演示模式：?demo=1 自动进入手动查看（无需摄像头，供测试/预览）
if (new URLSearchParams(location.search).get('demo') === '1') {
  setTimeout(() => $('btn-manual').click(), 300);
}
