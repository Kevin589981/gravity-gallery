# Gravity Gallery - 图片排序逻辑修复说明

## 📋 概述

本次修改完整复现了 Rust 版本 (example.rs) 中的图片排序逻辑，增加了以下功能：

### ✨ 新增功能

1. **自然排序 (Natural Sort)** - 正确处理文件名中的数字（例如：img1 < img2 < img10）
2. **按子文件夹分组排序**
   - 子文件夹随机排序 + 文件夹内按文件名自然排序
   - 子文件夹按时间戳排序 + 文件夹内按文件名自然排序
3. **排序方向控制** - 支持正向/反向排序
4. **5种完整的排序模式**

---

## 📦 修改的文件

### 1. **server_fixed.py** (后端Python服务器)

#### 主要改动：

- ✅ 新增 `natural_sort_key()` 函数用于自然排序
- ✅ 更新 `PlaylistRequest` 模型：
  - 新增 `direction` 字段（forward/reverse）
  - `sort` 字段新增选项：`subfolder_random`、`subfolder_date`
  
- ✅ 增强 `/api/playlist` 端点的排序逻辑：
  - `shuffle` - 完全随机
  - `name` - 按完整路径自然排序
  - `date` - 按修改时间排序（最新在前）
  - `subfolder_random` - 子文件夹随机 + 内部自然排序
  - `subfolder_date` - 子文件夹按时间戳 + 内部自然排序
  
- ✅ 应用排序方向（正向/反向）

- ✅ `/api/browse` 端点也使用自然排序

#### 核心代码示例：

```python
# 自然排序实现
def natural_sort_key(text: str):
    def atoi(text):
        return int(text) if text.isdigit() else text.lower()
    return [atoi(c) for c in re.split(r'(\d+)', text)]

# 子文件夹随机排序示例
elif req.sort == 'subfolder_random':
    subfolder_map = {}
    for item in results:
        parent = os.path.dirname(item['path'])
        if parent not in subfolder_map:
            subfolder_map[parent] = []
        subfolder_map[parent].append(item)
    
    subfolders = list(subfolder_map.keys())
    random.shuffle(subfolders)  # 文件夹随机
    
    final_paths = []
    for folder in subfolders:
        items = subfolder_map[folder]
        items.sort(key=lambda x: natural_sort_key(x['path']))  # 文件夹内自然排序
        final_paths.extend([item['path'] for item in items])
```

---

### 2. **types_fixed.ts** (TypeScript类型定义)

#### 主要改动：

- ✅ `SortMode` 枚举新增：
  - `SubfolderRandom` - 子文件夹随机 > 文件名
  - `SubfolderDate` - 子文件夹日期 > 文件名
  
- ✅ 新增 `SortDirection` 枚举：
  - `Forward` - 正向
  - `Reverse` - 反向
  
- ✅ `AppConfig` 接口新增 `sortDirection` 字段

---

### 3. **constants_fixed.ts** (默认配置)

#### 主要改动：

- ✅ 添加 `sortDirection: SortDirection.Forward` 默认值

---

### 4. **App_fixed.tsx** (主应用组件)

#### 主要改动：

- ✅ 导入 `naturalSort` 函数
- ✅ 监听 `config.sortDirection` 变化并重新获取播放列表
- ✅ `fetchServerPlaylist` 函数：
  - 将 `SortMode` 映射为后端API字符串
  - 发送 `direction` 参数到后端
  
- ✅ 本地模式也支持自然排序和方向控制

#### 核心代码示例：

```typescript
// 映射排序模式到后端
let sortStr = 'name';
if (sort === SortMode.Shuffle) sortStr = 'shuffle';
else if (sort === SortMode.Date) sortStr = 'date';
else if (sort === SortMode.SubfolderRandom) sortStr = 'subfolder_random';
else if (sort === SortMode.SubfolderDate) sortStr = 'subfolder_date';

// 发送请求
fetch(api, {
    method: 'POST',
    body: JSON.stringify({
        paths: paths,
        sort: sortStr,
        direction: direction.toLowerCase(),
        orientation: orientation
    })
});
```

---

### 5. **utils/imageUtils_fixed.ts** (图片工具函数)

#### 主要改动：

- ✅ 新增 `naturalSort()` 函数用于前端自然排序

#### 自然排序实现：

```typescript
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
      const cmp = aParts[i].localeCompare(bParts[i], undefined, { sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    }
  }
  
  return aParts.length - bParts.length;
};
```

---

### 6. **components/SettingsModal_fixed.tsx** (设置模态框)

#### 主要改动：

- ✅ 导入 `SortDirection` 类型
- ✅ 新增排序模式按钮：
  - Random (随机)
  - Name (自然排序)
  - Date (日期)
  - Folder Random (子文件夹随机)
  - Folder by Date (子文件夹日期)
  
- ✅ 新增排序方向选择器（Forward/Reverse）

#### UI效果：

```
┌─────────────────────────────────────┐
│ Sort Order                          │
├─────────────────────────────────────┤
│  🔄      A-Z      📅                │
│ Random   Name    Date               │
├─────────────────────────────────────┤
│  📁🎲         📁📅                   │
│ Folder Random   Folder by Date      │
└─────────────────────────────────────┘

Direction:  ▶ Forward  |  ◀ Reverse
```

---

## 🔄 排序模式对比表

| 模式 | Rust (example.rs) | Python (server.py) | 前端 (TypeScript) |
|------|-------------------|-------------------|------------------|
| 完全随机 | `FullyRandom` | `shuffle` | `SortMode.Shuffle` |
| 按路径自然排序 | `ByFullPath` | `name` | `SortMode.Sequential` |
| 按日期排序 | ❌ | `date` | `SortMode.Date` |
| 子文件夹随机 | `BySubfolderRandom` | `subfolder_random` | `SortMode.SubfolderRandom` |
| 子文件夹日期 | `BySubfolderTimestamp` | `subfolder_date` | `SortMode.SubfolderDate` |
| 排序方向 | `DisplayDirection` | `direction` | `SortDirection` |

---

## 🚀 使用说明

### 1. 替换文件

请将以下固定版本的文件手动替换到项目中：

```
server_fixed.py               → server.py
types_fixed.ts                → types.ts
constants_fixed.ts            → constants.ts
App_fixed.tsx                 → App.tsx
utils/imageUtils_fixed.ts     → utils/imageUtils.ts
components/SettingsModal_fixed.tsx → components/SettingsModal.tsx
```

### 2. 安装Python依赖

确保安装了所需的Python包：

```bash
pip install fastapi uvicorn pillow
```

### 3. 启动后端服务器

```bash
python server.py
```

服务器将启动在 `http://YOUR_IP:4860`

### 4. 启动前端

```bash
npm install
npm run dev
```

---

## 🧪 测试场景

### 场景1：自然排序测试

**文件列表：**
```
img1.jpg
img2.jpg
img10.jpg
img20.jpg
```

**旧版排序结果（错误）：**
```
img1.jpg
img10.jpg
img2.jpg
img20.jpg
```

**新版排序结果（正确）：**
```
img1.jpg
img2.jpg
img10.jpg
img20.jpg
```

---

### 场景2：子文件夹分组测试

**目录结构：**
```
📁 photos/
  📁 2024-01/ (修改时间: 2024-01-15)
    - img1.jpg
    - img10.jpg
    - img2.jpg
  📁 2024-02/ (修改时间: 2024-02-20)
    - photo1.jpg
    - photo2.jpg
```

**SubfolderDate 模式结果：**
```
photos/2024-01/img1.jpg
photos/2024-01/img2.jpg
photos/2024-01/img10.jpg
photos/2024-02/photo1.jpg
photos/2024-02/photo2.jpg
```

**SubfolderRandom 模式结果（随机一次）：**
```
photos/2024-02/photo1.jpg
photos/2024-02/photo2.jpg
photos/2024-01/img1.jpg
photos/2024-01/img2.jpg
photos/2024-01/img10.jpg
```

---

### 场景3：反向排序测试

**原始顺序（Forward）：**
```
A.jpg → B.jpg → C.jpg
```

**反向顺序（Reverse）：**
```
C.jpg → B.jpg → A.jpg
```

---

## ⚠️ 注意事项

1. **数据库缓存**：后端使用 SQLite 缓存图片元数据，首次扫描可能需要时间
2. **自动重扫**：服务器启动时会自动扫描图片库
3. **手动重扫**：在设置中点击 "Rescan Library" 可手动触发扫描
4. **排序性能**：自然排序对大量文件（>10000张）可能稍慢，但仍可接受

---

## 📊 完整功能对比

| 功能 | Rust版本 | Web版本（修复前） | Web版本（修复后） |
|------|---------|----------------|----------------|
| 完全随机排序 | ✅ | ✅ | ✅ |
| 自然排序 | ✅ | ❌ | ✅ |
| 日期排序 | ❌ | ❌ | ✅ |
| 子文件夹随机 | ✅ | ❌ | ✅ |
| 子文件夹日期 | ✅ | ❌ | ✅ |
| 排序方向控制 | ✅ | ❌ | ✅ |
| 方向筛选 | ✅ | ✅ | ✅ |

---

## 🎉 总结

本次修复完全复现了 Rust 版本的排序逻辑，并额外增加了"按日期排序"功能。所有排序算法都使用自然排序，确保文件名中的数字被正确处理。

如有任何问题，请检查：
1. Python正则表达式导入：`import re`
2. TypeScript类型导入是否完整
3. 后端API响应格式是否正确

祝使用愉快！🚀
