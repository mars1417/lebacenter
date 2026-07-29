# CDN入口页优化方案

## 问题一：跳转前强刷CDN

### 现状分析
- `finishHeal()` 仅 fetch 一次 `url.json` 即调用 `verifyAndRedirect()`
- `verifyAndRedirect()` 做 HEAD 验证，失败重试最多6次后无限循环
- 无强制清除缓存机制，可能拿到旧的 CDN 边缘节点缓存

### 优化方案
在 `finishHeal()` 中增加 **2次强刷CDN** 流程：
1. 每次 fetch 加 `Cache-Control: no-cache` 头 + 时间戳参数
2. 对比两次结果，确认稳定后再验证跳转
3. 若两次结果不一致，第3次兜底取最新

```javascript
async function finishHeal() {
  healProgress = 100; healMessage = 'OK'; MODE = 'complete';
  
  // 强刷CDN：连续fetch 2-3次 url.json，取最新稳定值
  let finalUrl = await forceRefreshTunnelUrl(3);
  
  if (finalUrl) target = finalUrl + '/gateway/';
  verifyAndRedirect();
}

async function forceRefreshTunnelUrl(maxAttempts = 3) {
  let lastUrl = '';
  let stableCount = 0;
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(URL_JSON + '?t=' + Date.now() + '&v=' + i, {
        cache: 'no-store',           // 强制不读缓存
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      const data = await res.json();
      const url = data.url || '';
      
      if (url && url === lastUrl) {
        stableCount++;
        if (stableCount >= 2) return url; // 连续2次一致视为稳定
      } else {
        stableCount = 0;
      }
      lastUrl = url;
      
      if (i < maxAttempts - 1) await sleep(300); // 间隔300ms避免过快
    } catch (e) {
      console.warn('强刷CDN失败:', e);
    }
  }
  return lastUrl || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
```

---

## 问题二：动画抖动不真实 - 核心重构

### 根因分析
| 组件 | 当前问题 | 表现 |
|------|----------|------|
| `drawGround` | 每帧 `Math.random()` 生成草高 | 草丛持续抖动像噪点 |
| `drawTrunk` | `sway = Math.sin(t*0.001)*2` | 树干独立摆动 |
| `drawCanopy` | `sway = Math.sin(t*0.001)*4` | 树冠独立摆动(频率不同) |
| `drawBranch` | 递归中每层 `sway = Math.sin(t*0.002+depth)*2` | 分支各自乱晃 |
| `leafParticles` | 每片叶子独立 `swayPhase/swaySpeed/swayAmp` | 叶子像虫子爬动 |

**核心问题**：缺乏**统一风场**，各组件频率/相位不一，导致"发抖"而非"随风摇摆"。

### 重构架构：统一风场系统

```javascript
// ===== 统一风场系统 =====
const Wind = {
  time: 0,
  // 主风向：低频正弦 + 噪声调制
  getMainSway(t) {
    const base = Math.sin(t * 0.0003) * 1.5;           // 慢速大摆动 (周期~20秒)
    const gust = Math.sin(t * 0.0012 + 1.3) * 0.8;     // 中速阵风
    const micro = Math.sin(t * 0.005 + 2.7) * 0.3;     // 微风抖动
    return base + gust + micro;
  },
  // 高度衰减：树根固定，树顶摆动最大
  getSwayAtHeight(mainSway, heightRatio, baseStiffness = 0.15) {
    return mainSway * (baseStiffness + (1 - baseStiffness) * heightRatio * heightRatio);
  },
  // 草地波动：空间相干的正弦波
  getGrassSway(t, x, wavelength = 120) {
    return Math.sin(t * 0.0008 + x / wavelength) * 2.5;
  }
};
```

### 1. 草地重构：预生成 + 风场驱动

```javascript
// 预生成草叶数据（仅初始化一次）
const grassBlades = [];
const GRASS_COUNT = Math.floor(W / 4); // 每4像素一根
const GROUND_Y = H * 0.78;

function initGrass() {
  grassBlades.length = 0;
  for (let i = 0; i < GRASS_COUNT; i++) {
    const x = i * 4 + Math.random() * 2;
    const baseHeight = 12 + Math.random() * 18;    // 固定基础高度
    const stiffness = 0.6 + Math.random() * 0.4;   // 固定硬度
    const phase = Math.random() * Math.PI * 2;     // 固定相位
    const colorVariation = (Math.random() - 0.5) * 15;
    grassBlades.push({ x, baseHeight, stiffness, phase, colorVariation });
  }
}

function drawGround(progress, t) {
  const gndY = GROUND_Y;
  const gh = Math.min(progress / 100 * 40 + 8, 48);
  
  // 地面渐变（保持原有）
  const grd = ctx.createLinearGradient(0, gndY, 0, H);
  grd.addColorStop(0, '#5a7a3a'); grd.addColorStop(0.2, '#4a6a2e');
  grd.addColorStop(0.5, '#3d5a25'); grd.addColorStop(1, '#2a3d18');
  ctx.fillStyle = grd; ctx.fillRect(0, gndY, W, H - gndY);
  
  // 阴影
  const sh = ctx.createRadialGradient(W/2, gndY+5, 0, W/2, gndY+5, 40+progress*0.3);
  sh.addColorStop(0, 'rgba(0,0,0,0.15)'); sh.addColorStop(1, 'transparent');
  ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(W/2, gndY+5, 40+progress*0.3, 0, Math.PI*2); ctx.fill();
  
  // 草叶：使用预生成数据 + 风场
  if (progress > 5) {
    const pct = Math.min(1, progress / 100);
    const mainSway = Wind.getMainSway(t);
    
    ctx.strokeStyle = '#6a9a4a'; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    
    for (const blade of grassBlades) {
      // 高度随进度生长
      const h = blade.baseHeight * pct * blade.stiffness;
      if (h < 2) continue;
      
      // 风场驱动：主风向 + 空间相干波动
      const grassSway = Wind.getGrassSway(t, blade.x) * blade.stiffness * pct;
      const totalSway = mainSway * 0.3 * pct + grassSway;
      
      const tipX = blade.x + totalSway;
      const midX = blade.x + totalSway * 0.5;
      const midY = gndY - h * 0.55;
      const tipY = gndY - h;
      
      // 颜色微变
      const g = 100 + blade.colorVariation;
      ctx.strokeStyle = `rgb(60, ${Math.max(80, Math.min(160, g))}, 40)`;
      
      ctx.beginPath();
      ctx.moveTo(blade.x, gndY);
      ctx.quadraticCurveTo(midX, midY, tipX, tipY);
      ctx.stroke();
    }
  }
}
```

### 2. 树木重构：统一骨架 + 传递式摆动

```javascript
// 树骨架预生成（仅生成一次结构，运行时只算变换）
const TreeSkeleton = {
  trunk: { baseW: 16, topW: 6, heightRatio: 0.35 },
  branches: [],      // 主枝
  twigs: [],         // 细枝
  leaves: [],        // 叶子簇位置（相对树冠中心）
  
  generate(maxH, cx, gndY) {
    this.trunk.height = maxH * this.trunk.heightRatio;
    this.trunk.baseX = cx - this.trunk.baseW/2;
    this.trunk.topX = cx - this.trunk.topW/2;
    this.trunk.topY = gndY - this.trunk.height;
    
    // 主枝：3-4根，固定角度/长度/位置
    this.branches = [];
    const branchCount = 4;
    for (let i = 0; i < branchCount; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const ang = -Math.PI/2 + side * (0.45 + (i > 1 ? 0.15 : 0));
      const len = maxH * (0.22 + Math.random() * 0.08); // 只在生成时随机
      const thickness = 6 + Math.random() * 3;
      const attachRatio = 0.25 + (i > 1 ? 0.2 : 0) + Math.random() * 0.15;
      this.branches.push({
        angle: ang, length: len, thickness: thickness,
        attachRatio: attachRatio,
        children: this.genTwigs(ang, len, thickness, 1)
      });
    }
    
    // 叶子簇：树冠区域内固定分布
    this.leaves = [];
    const canopyR = maxH * 0.35;
    const leafClusterCount = 40;
    for (let i = 0; i < leafClusterCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * canopyR * 0.85;
      this.leaves.push({
        angle: a, dist: d,
        size: 8 + Math.random() * 12,
        hue: 90 + Math.random() * 40,
        sat: 40 + Math.random() * 30,
        light: 45 + Math.random() * 25,
        rotSpeed: (Math.random() - 0.5) * 0.008,
        initialRot: Math.random() * Math.PI * 2
      });
    }
  },
  
  genTwigs(parentAng, parentLen, parentThick, depth) {
    if (depth > 3 || parentLen < 15) return [];
    const twigs = [];
    const count = depth === 1 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const spread = depth === 1 ? 0.5 : 0.35;
      const ang = parentAng + (i === 0 ? spread : -spread) + (Math.random() - 0.5) * 0.15;
      const len = parentLen * (0.55 + Math.random() * 0.2);
      const thick = Math.max(1, parentThick * 0.55);
      twigs.push({
        angle: ang, length: len, thickness: thick,
        children: this.genTwigs(ang, len, thick, depth + 1)
      });
    }
    return twigs;
  }
};

// 绘制树干：接收统一的 sway 值
function drawTrunk(progress, t, mainSway) {
  if (progress <= 0) return;
  const pct = easeOutCubic(Math.min(1, progress / 100));
  const gndY = GROUND_Y;
  const th = pct * TreeSkeleton.trunk.height;
  const cx = W/2;
  const by = gndY - th;
  
  // 树根几乎不动，树顶随风
  const baseSway = Wind.getSwayAtHeight(mainSway, 0, 0.02);
  const topSway = Wind.getSwayAtHeight(mainSway, pct, 0.02);
  
  ctx.beginPath();
  ctx.moveTo(cx - TreeSkeleton.trunk.baseW/2 + baseSway, gndY);
  ctx.quadraticCurveTo(
    cx - TreeSkeleton.trunk.baseW/4 + topSway * 0.5, gndY - th * 0.5,
    cx - TreeSkeleton.trunk.topW/2 + topSway, by
  );
  ctx.quadraticCurveTo(
    cx + TreeSkeleton.trunk.topW/2 + topSway, by,
    cx + TreeSkeleton.trunk.baseW/4 + topSway * 0.5, gndY - th * 0.3
  );
  ctx.quadraticCurveTo(cx + TreeSkeleton.trunk.baseW/2 + baseSway, gndY, cx + TreeSkeleton.trunk.baseW/2 + baseSway, gndY);
  ctx.closePath();
  
  // 渐变填充（保持原有）
  const tg = ctx.createLinearGradient(cx - TreeSkeleton.trunk.baseW/2, gndY, cx + TreeSkeleton.trunk.baseW/2, gndY);
  tg.addColorStop(0, '#5a3a1a'); tg.addColorStop(0.3, '#7a5a2a');
  tg.addColorStop(0.5, '#8a6a3a'); tg.addColorStop(0.7, '#7a5a2a'); tg.addColorStop(1, '#4a2a10');
  ctx.fillStyle = tg; ctx.fill();
  
  // 树皮纹理（简化，不每帧随机）
  if (pct > 0.15) {
    ctx.strokeStyle = 'rgba(0,0,0,0.06)'; ctx.lineWidth = 0.5;
    for (let i = 0; i < 4; i++) {
      const lx = cx + (i - 1.5) * TreeSkeleton.trunk.baseW * 0.15;
      const ly = gndY - th * (0.2 + i * 0.15);
      ctx.beginPath(); ctx.moveTo(lx, ly);
      ctx.quadraticCurveTo(lx + 2, ly - 8, lx + 1, ly - 16);
      ctx.stroke();
    }
  }
}

// 绘制树枝：递归传递 sway
function drawBranches(progress, t, mainSway) {
  if (progress < 15) return;
  const pct = easeOutCubic(Math.min(1, progress / 100));
  const gndY = GROUND_Y;
  const cx = W/2;
  const trunkTopY = gndY - pct * TreeSkeleton.trunk.height;
  
  for (const branch of TreeSkeleton.branches) {
    if (pct < branch.attachRatio * 0.8) continue; // 生长延迟
    const branchPct = easeOutCubic(Math.min(1, (pct - branch.attachRatio * 0.8) / (1 - branch.attachRatio * 0.8)));
    if (branchPct <= 0) continue;
    
    const attachY = gndY - pct * TreeSkeleton.trunk.height * branch.attachRatio;
    const attachSway = Wind.getSwayAtHeight(mainSway, branch.attachRatio, 0.02);
    drawBranchRec(cx + attachSway, attachY, branch, branchPct, mainSway, branch.attachRatio, 1);
  }
}

function drawBranchRec(cx, cy, branch, pct, mainSway, heightRatio, depth) {
  const len = branch.length * pct;
  if (len < 3) return;
  
  // 该高度的 sway
  const endSway = Wind.getSwayAtHeight(mainSway, heightRatio + 0.15 * depth, 0.02);
  const ex = cx + Math.cos(branch.angle) * len + endSway;
  const ey = cy + Math.sin(branch.angle) * len;
  
  ctx.beginPath(); ctx.moveTo(cx, cy);
  // 控制点也受 sway 影响
  const ctrlSway = Wind.getSwayAtHeight(mainSway, heightRatio + 0.1 * depth, 0.02);
  ctx.quadraticCurveTo(cx + Math.cos(branch.angle) * len * 0.5 + ctrlSway * 0.5, cy + Math.sin(branch.angle) * len * 0.5, ex, ey);
  ctx.strokeStyle = '#6a4a2a'; ctx.lineWidth = Math.max(0.8, branch.thickness * pct); ctx.lineCap = 'round'; ctx.stroke();
  
  // 递归绘制子枝
  for (const child of branch.children) {
    const childAttachRatio = heightRatio + 0.15 * depth;
    if (pct > 0.3) drawBranchRec(ex, ey, child, Math.max(0, pct - 0.2), mainSway, childAttachRatio, depth + 1);
  }
}

// 绘制树冠/叶子：统一 sway + 微小个体差异
function drawCanopy(progress, t, mainSway) {
  if (progress < 20) return;
  const pct = easeOutCubic(Math.min(1, progress / 100));
  const gndY = GROUND_Y;
  const cx = W/2;
  const trunkH = pct * TreeSkeleton.trunk.height;
  const canopyCenterY = gndY - trunkH - 20 * pct;
  const canopySway = Wind.getSwayAtHeight(mainSway, 0.95, 0.02); // 树冠顶部
  const spread = pct * 130;
  
  // 树冠整体光晕
  const grd = ctx.createRadialGradient(cx + canopySway, canopyCenterY, 0, cx + canopySway, canopyCenterY, spread);
  grd.addColorStop(0, `rgba(80,160,60,${0.18 * pct})`);
  grd.addColorStop(0.5, `rgba(60,140,50,${0.12 * pct})`);
  grd.addColorStop(1, 'transparent');
  ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(cx + canopySway, canopyCenterY, spread, 0, Math.PI*2); ctx.fill();
  
  // 叶子簇
  for (const leaf of TreeSkeleton.leaves) {
    const leafPct = Math.max(0, (pct - 0.25) / 0.5); // 叶子延迟展开
    if (leafPct <= 0) continue;
    
    const dist = leaf.dist * leafPct;
    // 叶子随树冠整体摆动 + 微小自旋
    const angle = leaf.angle + Math.sin(t * 0.0015 + leaf.initialRot) * 0.03;
    const lx = cx + Math.cos(angle) * dist + canopySway * 0.6;
    const ly = canopyCenterY + Math.sin(angle) * dist * 0.5 - 15;
    
    if (ly > gndY - 15) continue;
    
    ctx.save(); ctx.translate(lx, ly);
    ctx.rotate(leaf.initialRot + t * 0.001 * leaf.rotSpeed);
    ctx.globalAlpha = 0.6 * leafPct;
    ctx.beginPath();
    ctx.ellipse(0, 0, leaf.size * 0.4, leaf.size * 0.7, 0, 0, Math.PI*2);
    ctx.fillStyle = `hsl(${leaf.hue}, ${leaf.sat}%, ${leaf.light}%)`;
    ctx.fill(); ctx.restore();
  }
  
  // 树冠高光
  if (pct > 0.6) {
    const ha = (pct - 0.6) * 0.2;
    const hl = ctx.createRadialGradient(cx + canopySway - spread*0.2, canopyCenterY - spread*0.3, 0, cx + canopySway - spread*0.2, canopyCenterY - spread*0.3, spread*0.4);
    hl.addColorStop(0, `rgba(255,255,200,${ha})`); hl.addColorStop(1, 'transparent');
    ctx.fillStyle = hl; ctx.beginPath(); ctx.arc(cx + canopySway - spread*0.2, canopyCenterY - spread*0.3, spread*0.4, 0, Math.PI*2); ctx.fill();
  }
}
```

### 3. 生长进度平滑：缓动函数

```javascript
// 缓动函数库
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }
function easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
function easeInOutCubic(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2; }

// 生长阶段映射：将 0-100 进度映射到各组件的平滑时间线
const GrowthStages = {
  sky:      { start: 0,   end: 100, ease: easeOutCubic },
  ground:   { start: 5,   end: 35,  ease: easeOutQuart },
  trunk:    { start: 10,  end: 50,  ease: easeOutCubic },
  branches: { start: 20,  end: 70,  ease: easeOutExpo },
  canopy:   { start: 30,  end: 85,  ease: easeOutCubic },
  leaves:   { start: 40,  end: 90,  ease: easeOutQuart },
  flowers:  { start: 75,  end: 100, ease: easeInOutCubic }, // 开花在树冠成型后
  fireflies:{ start: 35,  end: 100, ease: easeOutCubic },
  petals:   { start: 60,  end: 100, ease: easeOutCubic }
};

function getStageProgress(stage, globalProgress) {
  const s = GrowthStages[stage];
  if (globalProgress < s.start) return 0;
  if (globalProgress > s.end) return 1;
  return s.ease((globalProgress - s.start) / (s.end - s.start));
}

// 在 render 中使用：
// const skyPct = getStageProgress('sky', healProgress);
// const groundPct = getStageProgress('ground', healProgress);
// ...
```

### 4. 开花动画：自然绽放

```javascript
function drawFlowers(progress, t, mainSway) {
  const pct = getStageProgress('flowers', progress);
  if (pct <= 0) return;
  
  const gndY = GROUND_Y;
  const cx = W/2;
  const trunkH = Math.min(1, progress/100) * TreeSkeleton.trunk.height;
  const canopyCenterY = gndY - trunkH - 20 * Math.min(1, progress/100);
  const canopySway = Wind.getSwayAtHeight(mainSway, 0.95, 0.02);
  const spread = Math.min(1, progress/100) * 130;
  
  // 预定义花朵位置（固定）
  const flowerPositions = [
    { angle: 0.8, dist: 0.6, size: 1.0, delay: 0.0 },
    { angle: -0.6, dist: 0.7, size: 0.9, delay: 0.1 },
    { angle: 1.5, dist: 0.4, size: 0.7, delay: 0.2 },
    { angle: -1.2, dist: 0.5, size: 0.8, delay: 0.05 },
    { angle: 0.3, dist: 0.3, size: 0.6, delay: 0.15 },
    { angle: -1.8, dist: 0.55, size: 0.75, delay: 0.25 },
    { angle: 2.2, dist: 0.45, size: 0.65, delay: 0.18 }
  ];
  
  for (const f of flowerPositions) {
    // 错开绽放时间
    const bloomPct = Math.max(0, (pct - f.delay) / (1 - f.delay));
    if (bloomPct <= 0) continue;
    
    // 绽放缓动：先快后慢
    const bloom = easeOutExpo(bloomPct);
    const fs = 3 + bloom * f.size * 14;
    const alpha = bloom * 0.9;
    
    const fx = cx + Math.cos(f.angle) * spread * f.dist + canopySway * 0.5;
    const fy = canopyCenterY + Math.sin(f.angle) * spread * f.dist * 0.4 - 10;
    
    // 花瓣（5瓣）
    for (let j = 0; j < 5; j++) {
      const pa = j * Math.PI * 2 / 5 + t * 0.0003; // 缓慢整体旋转
      const px = fx + Math.cos(pa) * fs * 0.55;
      const py = fy + Math.sin(pa) * fs * 0.55;
      ctx.beginPath();
      ctx.ellipse(px, py, fs * 0.35, fs * 0.55, pa, 0, Math.PI*2);
      ctx.fillStyle = `rgba(255, 220, 200, ${alpha * 0.85})`;
      ctx.fill();
    }
    // 花心
    ctx.beginPath(); ctx.arc(fx, fy, fs * 0.18, 0, Math.PI*2);
    ctx.fillStyle = `rgba(255, 200, 50, ${alpha})`; ctx.fill();
  }
}
```

### 5. 新增自然元素

```javascript
// ===== 云朵系统 =====
const clouds = [];
function initClouds() {
  clouds.length = 0;
  for (let i = 0; i < 5; i++) {
    clouds.push({
      x: Math.random() * W,
      y: 60 + Math.random() * (H * 0.25),
      speed: 0.03 + Math.random() * 0.05,
      scale: 0.6 + Math.random() * 0.5,
      opacity: 0.15 + Math.random() * 0.15,
      parts: Array.from({length: 3+Math.floor(Math.random()*3)}, () => ({
        ox: (Math.random()-0.5)*60, oy: (Math.random()-0.5)*20,
        r: 20 + Math.random()*30
      }))
    });
  }
}

function drawClouds(t, skyPct) {
  if (skyPct < 0.1) return;
  const alpha = Math.min(1, skyPct * 1.5);
  
  for (const c of clouds) {
    c.x += c.speed;
    if (c.x - 100 > W) c.x = -100;
    
    ctx.globalAlpha = c.opacity * alpha;
    ctx.fillStyle = '#fff';
    for (const p of c.parts) {
      ctx.beginPath();
      ctx.ellipse(c.x + p.ox, c.y + p.oy, p.r * c.scale, p.r * c.scale * 0.6, 0, 0, Math.PI*2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ===== 光线/上帝之光 =====
function drawLightRays(t, skyPct) {
  if (skyPct < 0.3) return;
  const pct = Math.min(1, (skyPct - 0.3) / 0.4);
  const rayCount = 5;
  const sunX = W * 0.3 + Math.cos(t * 0.0001) * W * 0.2;
  const sunY = H * 0.25;
  
  for (let i = 0; i < rayCount; i++) {
    const angle = -Math.PI/2 + (i - 2) * 0.15 + Math.sin(t * 0.0005 + i) * 0.02;
    const len = H * 0.6;
    const grad = ctx.createLinearGradient(sunX, sunY, sunX + Math.cos(angle)*len, sunY + Math.sin(angle)*len);
    grad.addColorStop(0, `rgba(255,230,180,${0.04 * pct})`);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(sunX, sunY);
    ctx.lineTo(sunX + Math.cos(angle - 0.01) * len, sunY + Math.sin(angle - 0.01) * len);
    ctx.lineTo(sunX + Math.cos(angle + 0.01) * len, sunY + Math.sin(angle + 0.01) * len);
    ctx.closePath(); ctx.fill();
  }
}

// ===== 小鸟 =====
const birds = [];
function initBirds() {
  birds.length = 0;
  for (let i = 0; i < 3; i++) {
    birds.push({
      x: Math.random() * W,
      y: H * 0.15 + Math.random() * H * 0.2,
      vx: 0.3 + Math.random() * 0.4,
      vy: (Math.random() - 0.5) * 0.15,
      wingPhase: Math.random() * Math.PI * 2,
      scale: 0.7 + Math.random() * 0.5
    });
  }
}

function drawBirds(t, skyPct) {
  if (skyPct < 0.5) return;
  for (const b of birds) {
    b.x += b.vx;
    b.y += b.vy + Math.sin(t * 0.005 + b.wingPhase) * 0.3;
    b.wingPhase += 0.15;
    
    if (b.x > W + 50) { b.x = -50; b.y = H * 0.15 + Math.random() * H * 0.2; }
    
    const wing = Math.sin(b.wingPhase) * 8 * b.scale;
    ctx.strokeStyle = `rgba(30,30,40,${0.4 * skyPct})`;
    ctx.lineWidth = 1.5 * b.scale; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.x - 10*b.scale, b.y);
    ctx.quadraticCurveTo(b.x, b.y - wing, b.x + 10*b.scale, b.y);
    ctx.stroke();
  }
}
```

### 6. 粒子系统优化

```javascript
// 入场粒子：改为固定轨道 + 缓慢漂移
const introParticles = [];
function initIntroParticles() {
  introParticles.length = 0;
  for (let i = 0; i < 60; i++) {
    introParticles.push({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.15,
      vy: -(Math.random() * 0.15 + 0.03),
      size: Math.random() * 2 + 0.5,
      hue: Math.random() > 0.5 ? 32 : 220,
      baseAlpha: Math.random() * 0.25 + 0.05,
      phase: Math.random() * Math.PI * 2
    });
  }
}

function drawIntroParticles(t, introElapsed) {
  const alphaMult = Math.min(1, introElapsed / 3);
  for (const p of introParticles) {
    p.x += p.vx + Math.sin(t * 0.0005 + p.phase) * 0.02;
    p.y += p.vy;
    if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
    if (p.x < -10) p.x = W + 10;
    if (p.x > W + 10) p.x = -10;
    
    const alpha = p.baseAlpha * alphaMult * (0.7 + Math.sin(t * 0.002 + p.phase) * 0.3);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `hsl(${p.hue}, 70%, 70%)`;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
    ctx.shadowColor = `hsl(${p.hue}, 70%, 70%)`;
    ctx.shadowBlur = 4; ctx.fill(); ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
}
```

---

## 集成指南：render 循环重构

```javascript
function render(t) {
  const globalPct = Math.min(1, healProgress / 100);
  const mainSway = Wind.getMainSway(t);
  
  // 天空渐变
  drawSky(getStageProgress('sky', healProgress), t);
  
  // 云朵 & 光线 & 小鸟（入场/治愈/完成都显示）
  const skyPct = getStageProgress('sky', healProgress);
  drawClouds(t, skyPct);
  drawLightRays(t, skyPct);
  drawBirds(t, skyPct);
  
  if (MODE === 'healing' || MODE === 'complete') {
    const groundPct = getStageProgress('ground', healProgress);
    drawGround(groundPct * 100, t); // 传入 0-100 兼容旧签名
    
    drawTrunk(getStageProgress('trunk', healProgress) * 100, t, mainSway);
    drawBranches(getStageProgress('branches', healProgress) * 100, t, mainSway);
    drawCanopy(getStageProgress('canopy', healProgress) * 100, t, mainSway);
    drawFlowers(healProgress, t, mainSway);
  }
  
  // 大气效果
  drawAtmo(healProgress, t); // 内部已区分 MODE
  
  if (MODE === 'healing') drawProgressText(healProgress, healMessage);
  
  // 入场逻辑保持不变...
  requestAnimationFrame(render);
}
```

---

## 关键参数速查表

| 参数 | 原值 | 新值 | 说明 |
|------|------|------|------|
| 风场主频率 | 0.001 | 0.0003 | 降低 3倍，更舒缓 |
| 草随机频率 | 每帧 | 0 (预生成) | 消除抖动核心 |
| 树干 sway 幅度 | 2px | 动态(高度平方) | 树根稳、树顶动 |
| 树冠 sway 幅度 | 4px | 树干顶部 * 1.2 | 整体协同 |
| 分支递归 sway | 每层独立 | 统一风场+高度衰减 | 消除分支乱晃 |
| 叶子个体差异 | 随机相位/速度/幅度 | 仅保留微小旋转速度差 | 叶子随树冠整体动 |
| 开花触发进度 | 50% | 75% (树冠85%后) | 自然顺序 |
| 生长缓动 | 线性 | 分阶段 easeOut* | 平滑过渡 |

---

## 文件修改清单

1. **`index.html`** - 完整替换 `<script>` 区域（建议备份后整体替换）
2. 或分步应用：
   - 顶部添加：`Wind` 对象、`GrowthStages`、`缓动函数`
   - `initGrass()`、`initClouds()`、`initBirds()`、`initIntroParticles()` 在 `resize()` 后调用
   - 替换：`drawGround`、`drawTrunk`、`drawBranches`/`drawBranchRec`、`drawCanopy`、`drawFlowers`
   - 新增：`drawClouds`、`drawLightRays`、`drawBirds`、`drawIntroParticles`
   - 修改：`render()` 集成新调用顺序
   - 修改：`finishHeal()` → `forceRefreshTunnelUrl()`
   - 修改：`btn.click` 回调中启动 `initGrass()` 等初始化

---

## 验收标准

1. **强刷CDN**：跳转前连续 2 次 fetch `url.json` 结果一致才验证；网络异常时第 3 次兜底
2. **草不抖动**：静止时草叶完全静止；有风时呈现连贯波浪而非噪点
3. **树整体摆动**：树根~树顶连续变形，无分支"断裂"感
4. **生长平滑**：进度条 0→100 无跳变，各器官按生物学顺序展开
5. **开花自然**：树冠成型后花朵依次绽放，非瞬间全出现
6. **新增元素**：云朵缓慢飘移、光线随太阳角度变化、偶尔有鸟飞过
7. **性能**：60fps 维持，移动端无卡顿（草叶预生成、骨架预计算、无每帧随机）
