// extract_forearm.js
// 从 BodyExplorer 的全身 GLB 中裁剪出「左前臂 + 左手」的骨骼/肌肉，输出独立 GLB
// 用法: node extract_forearm.js
const { NodeIO } = require('@gltf-transform/core');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;

// ── 需要保留的骨骼（左手前臂 + 手）──
const BONE_KEEP = [
  'left radius', 'left ulna',
  // 腕骨 8 块
  'left scaphoid', 'left lunate', 'left triquetral', 'left pisiform',
  'left trapezium', 'left trapezoid', 'left capitate', 'left hamate',
  // 掌骨 5 块
  'left first metacarpal bone', 'left second metacarpal bone',
  'left third metacarpal bone', 'left fourth metacarpal bone',
  'left fifth metacarpal bone',
  // 指骨（拇指 2 节，其余 3 节 = 14 节）
  'proximal phalanx of left thumb', 'distal phalanx of left thumb',
  'proximal phalanx of left index finger', 'middle phalanx of left index finger', 'distal phalanx of left index finger',
  'proximal phalanx of left middle finger', 'middle phalanx of left middle finger', 'distal phalanx of left middle finger',
  'proximal phalanx of left ring finger', 'middle phalanx of left ring finger', 'distal phalanx of left ring finger',
  'proximal phalanx of left little finger', 'middle phalanx of left little finger', 'distal phalanx of left little finger',
];

// ── 需要保留的肌肉（左前臂 + 左手）──
// 前臂屈侧
const FLEXOR = [
  'left brachioradialis',
  'left pronator teres', 'humeral head of left pronator teres', 'ulnar head of left pronator teres',
  'left flexor carpi radialis', 'left palmaris longus',
  'left flexor carpi ulnaris', 'humeral head of left flexor carpi ulnaris', 'ulnar head of left flexor carpi ulnaris',
  'left flexor digitorum superficialis', 'left flexor digitorum superficialis (2)',
  'left flexor digitorum profundus',
  'left flexor pollicis longus', 'left pronator quadratus',
];
// 前臂伸侧
const EXTENSOR = [
  'left extensor carpi radialis longus', 'left extensor carpi radialis brevis',
  'left extensor carpi ulnaris', 'left extensor carpi ulnaris (2)',
  'left extensor digitorum', 'left extensor digiti minimi', 'left extensor indicis',
  'left extensor pollicis longus', 'left extensor pollicis brevis',
  'left abductor pollicis longus', 'left supinator',
];
// 手部
const HAND = [
  'left abductor pollicis brevis', 'left flexor pollicis brevis',
  'superficial head of left flexor pollicis brevis',
  'left opponens pollicis',
  'oblique head of left adductor pollicis', 'transverse head of left adductor pollicis',
  'left abductor digiti minimi', 'left flexor digiti minimi brevis', 'left opponens digiti minimi',
  'set of dorsal interossei of left hand', 'set of palmar interossei of left hand',
  'set of lumbricals of left hand', 'left flexor retinaculum',
];
const MUSCLE_KEEP = [...new Set([...FLEXOR, ...EXTENSOR, ...HAND])];

// 保留时前缀匹配（处理 "(2)" 等多段）
function keepName(name, keepList) {
  return keepList.includes(name);
}

async function extract(src, dst, keepList, label) {
  const io = new NodeIO();
  const doc = await io.read(src);
  const root = doc.getRoot();
  const scenes = root.listScenes();
  const allNodes = root.listNodes();

  // 找出要保留的节点名
  const keepSet = new Set();
  for (const n of allNodes) {
    const name = n.getName();
    if (name && keepName(name, keepList)) keepSet.add(name);
  }
  console.log(`[${label}] keep ${keepSet.size} nodes of ${allNodes.length}`);

  // 删除不需要的节点（同时删掉关联 mesh）
  let removed = 0;
  for (const n of [...allNodes]) {
    if (!n.getName() || !keepSet.has(n.getName())) {
      n.dispose();
      removed++;
    }
  }
  // 清掉孤儿 mesh（没有节点引用的）
  const liveNodes = root.listNodes();
  for (const m of [...root.listMeshes()]) {
    if (!liveNodes.some(n => n.getMesh() === m)) m.dispose();
  }
  // 把保留的顶层节点挂回场景（删除原根节点后 scene.nodes 会变空）
  const scene = root.listScenes()[0];
  const sceneNodes = scene.listChildren();
  for (const n of sceneNodes) scene.removeChild(n);
  for (const n of root.listNodes()) {
    if (n.getName() && keepSet.has(n.getName()) && n.getParentNode() === null) {
      scene.addChild(n);
    }
  }

  await io.write(dst, doc);
  const size = fs.statSync(dst).size;
  console.log(`[${label}] -> ${dst} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

async function main() {
  const skelSrc = path.join(DIR, 'skeleton.glb');
  const anatSrc = path.join(DIR, 'anatomy.glb');
  if (!fs.existsSync(skelSrc)) { console.error('缺少 skeleton.glb'); process.exit(1); }
  if (!fs.existsSync(anatSrc)) { console.error('缺少 anatomy.glb'); process.exit(1); }

  await extract(skelSrc, path.join(DIR, 'forearm_bones.glb'), BONE_KEEP, '骨骼');
  await extract(anatSrc, path.join(DIR, 'forearm_muscles.glb'), MUSCLE_KEEP, '肌肉');
  console.log('完成');
}

main().catch(e => { console.error(e); process.exit(1); });
