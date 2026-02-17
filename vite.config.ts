import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite'; // 1. 引入 loadEnv
import react from '@vitejs/plugin-react';

// 2. 将配置改成函数形式，接收 command 和 mode
export default defineConfig(({ command, mode }) => {
  // 3. 手动加载环境变量
  // process.cwd() 获取当前工作目录，'' 表示加载所有前缀的变量
  const env = loadEnv(mode, process.cwd(), '');

  // 4. 定义一个辅助函数，安全地获取 HTTPS 配置
  const getHttpsConfig = () => {
    // 只有在开发环境 (serve) 且 两个变量都有值的时候才启用 HTTPS
    if (command === 'serve' && env.VITE_DEV_KEY && env.VITE_DEV_CERT) {
      try {
        return {
          key: fs.readFileSync(env.VITE_DEV_KEY),
          cert: fs.readFileSync(env.VITE_DEV_CERT),
        };
      } catch (e) {
        console.warn('⚠️  HTTPS 证书读取失败，将降级为 HTTP 启动。');
        return undefined;
      }
    }
    return undefined; // 构建模式或缺少变量时，不配置 HTTPS
  };

  return {
    server: {
      port: 4861,
      host: '0.0.0.0',
      https: getHttpsConfig(), // 5. 使用函数调用的结果
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
      preserveSymlinks: true,
    },
  };
});