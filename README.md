# Gravity Gallery

本项目是一个基于 Vite + React 的本地/服务器图片画廊应用。

## 本地运行

**前置条件：** Node.js

1. 安装依赖：
   `npm install`
2. 启动开发服务器：
   `npm run dev`

## 构建与预览

- 生产构建：`npm run build`
- 本地预览：`npm run preview`

## Rust 后端（实验版）

- Rust 服务目录：`rust-server`
- 编译检查：`cargo check --manifest-path rust-server/Cargo.toml`
- 一键启动（Rust 后端 + 前端静态服务）：`run-dev-rust.bat`

> `run-dev-rust.bat` 会读取与 Python 版本一致的环境变量（如 `GALLERY_ROOT_DIR`、`GALLERY_ALLOW_PARENT_DIR_ACCESS`、`GALLERY_SSL_CERT`、`GALLERY_SSL_KEY`）。
