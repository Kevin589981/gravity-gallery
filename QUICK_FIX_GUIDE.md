# 🔧 快速修复指南

## 替换文件清单

按照以下步骤手动替换文件（因编辑器问题，无法使用自动替换工具）：

### ✅ 步骤 1: 后端文件

```bash
# 复制修复后的文件
server_fixed.py  →  server.py
```

**关键改动：**
- 添加了 `import re` （用于自然排序）
- 新增 `natural_sort_key()` 函数
- `PlaylistRequest` 新增 `direction: str = "forward"` 字段
- `/api/playlist` 端点增加了 5 种完整的排序逻辑
- 所有排序都支持 `forward` / `reverse` 方向

---

### ✅ 步骤 2: 类型定义

```bash
types_fixed.ts  →  types.ts
```

**关键改动：**
```typescript
// 新增排序模式
export enum SortMode {
  Shuffle = 'Shuffle',
  Sequential = 'Sequential',
  Date = 'Date',
  SubfolderRandom = 'SubfolderRandom',    // ← 新增
  SubfolderDate = 'SubfolderDate',        // ← 新增
}

// 新增方向枚举
export enum SortDirection {                 // ← 新增
  Forward = 'Forward',
  Reverse = 'Reverse',
}

// AppConfig 新增字段
export interface AppConfig {
  // ... 其他字段
  sortDirection: SortDirection;             // ← 新增
}
```

---

### ✅ 步骤 3: 默认配置

```bash
constants_fixed.ts  →  constants.ts
```

**关键改动：**
```typescript
import { SortDirection } from './types';    // ← 新增导入

export const DEFAULT_CONFIG: AppConfig = {
  // ... 其他字段
  sortDirection: SortDirection.Forward,      // ← 新增
};
```

---

### ✅ 步骤 4: 工具函数

```bash
utils/imageUtils_fixed.ts  →  utils/imageUtils.ts
```

**关键改动：**
```typescript
// 新增自然排序函数
export const naturalSort = (a: string, b: string): number => {
  const regex = /(\d+)|(\D+)/g;
  const aParts = a.match(regex) || [];
  const bParts = b.match(regex) || [];
  
  for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
    const aNum = parseInt(aParts[i], 10);
    const bNum = parseInt(bParts[i], 10);
    
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      const cmp = aParts[i].localeCompare(bParts[i]);
      if (cmp !== 0) return cmp;
    }
  }
  
  return aParts.length - bParts.length;
};
```

---

### ✅ 步骤 5: 主应用

```bash
App_fixed.tsx  →  App.tsx
```

**关键改动：**

1. **导入更新**
```typescript
import { SortMode, SortDirection } from './types';
import { naturalSort } from './utils/imageUtils';
```

2. **监听排序方向变化**
```typescript
useEffect(() => {
  // ...
}, [config.sortMode, config.sortDirection, config.orientationFilter]);
```

3. **fetchServerPlaylist 函数更新**
```typescript
const fetchServerPlaylist = async (
    url: string, 
    paths: string[], 
    sort: SortMode, 
    direction: SortDirection,  // ← 新增参数
    orientation: OrientationFilter
) => {
  // 映射排序模式
  let sortStr = 'name';
  if (sort === SortMode.Shuffle) sortStr = 'shuffle';
  else if (sort === SortMode.Date) sortStr = 'date';
  else if (sort === SortMode.SubfolderRandom) sortStr = 'subfolder_random';
  else if (sort === SortMode.SubfolderDate) sortStr = 'subfolder_date';

  // 发送请求
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({
      paths: paths,
      sort: sortStr,
      direction: direction.toLowerCase(),  // ← 新增
      orientation: orientation
    })
  });
}
```

4. **本地模式使用自然排序**
```typescript
// 本地模式
if (config.sortMode === SortMode.Sequential) {
  setAllImages(prev => [...prev].sort((a,b) => naturalSort(a.name, b.name)));
}

// 应用方向
if (config.sortDirection === SortDirection.Reverse) {
  setAllImages(prev => [...prev].reverse());
}
```

---

### ✅ 步骤 6: 设置界面

```bash
components/SettingsModal_fixed.tsx  →  components/SettingsModal.tsx
```

**关键改动：**

1. **导入更新**
```typescript
import { SortMode, SortDirection } from '../types';
```

2. **新的排序模式UI**（替换原来的简单3按钮）
```tsx
<div className="grid grid-cols-3 gap-2">
  <button onClick={() => updateConfig('sortMode', SortMode.Shuffle)}>
    Random
  </button>
  <button onClick={() => updateConfig('sortMode', SortMode.Sequential)}>
    Name
  </button>
  <button onClick={() => updateConfig('sortMode', SortMode.Date)}>
    Date
  </button>
  <button onClick={() => updateConfig('sortMode', SortMode.SubfolderRandom)}>
    📁🎲 Folder Random
  </button>
  <button onClick={() => updateConfig('sortMode', SortMode.SubfolderDate)}>
    📁📅 Folder by Date
  </button>
</div>
```

3. **新增方向选择器**
```tsx
<div className="flex items-center justify-between">
  <span>Direction</span>
  <div className="flex bg-neutral-800 rounded-lg p-1">
    <button onClick={() => updateConfig('sortDirection', SortDirection.Forward)}>
      ▶ Forward
    </button>
    <button onClick={() => updateConfig('sortDirection', SortDirection.Reverse)}>
      ◀ Reverse
    </button>
  </div>
</div>
```

---

## 🎯 核心改进点总结

| 改进点 | 位置 | 说明 |
|--------|------|------|
| 自然排序算法 | `server.py` + `imageUtils.ts` | 正确处理文件名中的数字 |
| 子文件夹分组 | `server.py` | 支持按文件夹分组后排序 |
| 时间戳排序 | `server.py` | 支持按文件夹修改时间排序 |
| 方向控制 | 所有文件 | 支持正向/反向排序 |
| UI控制 | `SettingsModal.tsx` | 5种排序模式 + 方向选择 |

---

## 🧪 测试验证

替换完所有文件后，重启服务器和前端：

```bash
# 后端
python server.py

# 前端（新终端）
npm run dev
```

**验证步骤：**

1. ✅ 打开设置，确认有 5 个排序模式按钮
2. ✅ 确认有 Forward/Reverse 方向选择
3. ✅ 选择 "Name" 模式，文件应按自然顺序排列（img1 < img2 < img10）
4. ✅ 切换到 Reverse，顺序应反转
5. ✅ 尝试 "Folder Random" 和 "Folder by Date" 模式

---

## ❓ 常见问题

### Q: 后端报错 `name 're' is not defined`
**A:** 在 `server.py` 顶部添加 `import re`

### Q: 前端类型错误
**A:** 确保所有文件都已替换，特别是 `types.ts` 和 `constants.ts`

### Q: 排序不生效
**A:** 检查浏览器控制台，确认API请求包含 `sort` 和 `direction` 字段

### Q: 本地模式排序异常
**A:** 确认 `imageUtils.ts` 中的 `naturalSort` 函数已添加

---

## 📝 文件替换检查清单

- [ ] `server_fixed.py` → `server.py`
- [ ] `types_fixed.ts` → `types.ts`
- [ ] `constants_fixed.ts` → `constants.ts`
- [ ] `utils/imageUtils_fixed.ts` → `utils/imageUtils.ts`
- [ ] `App_fixed.tsx` → `App.tsx`
- [ ] `components/SettingsModal_fixed.tsx` → `components/SettingsModal.tsx`
- [ ] 重启后端服务器
- [ ] 重启前端开发服务器
- [ ] 测试所有排序模式

完成后即可享受完整的排序功能！🎉
