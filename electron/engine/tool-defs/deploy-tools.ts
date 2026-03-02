/**
 * Deployment, image generation, Supabase & Cloudflare tool definitions.
 */
import type { ToolDef } from './types';

export const DEPLOY_TOOLS: ToolDef[] = [
  // ── Image Generation ──
  {
    name: 'generate_image',
    description:
      '文生图 — 根据文字描述生成图像。支持 DALL-E 3/2、Gemini Imagen、自定义 OpenAI 兼容 API (如本地 Stable Diffusion)。\n返回 base64 PNG + 可选本地保存。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图像生成提示词 (英文效果更好)' },
        negative_prompt: { type: 'string', description: '负面提示词 (仅自定义 API 支持)' },
        size: {
          type: 'string',
          enum: ['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'],
          description: '图像尺寸，默认 1024x1024',
          default: '1024x1024',
        },
        quality: { type: 'string', enum: ['standard', 'hd'], description: '质量 (DALL-E 3)，默认 standard' },
        style: { type: 'string', enum: ['vivid', 'natural'], description: '风格 (DALL-E 3)，默认 vivid' },
        save_path: { type: 'string', description: '保存到本地的路径 (可选，如 ./assets/hero.png)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description: '图像编辑 (inpainting) — 基于蒙版编辑已有图像的局部区域。仅 DALL-E 2 / 自定义 API 支持。',
    parameters: {
      type: 'object',
      properties: {
        image_label: { type: 'string', description: '源图像标签 (来自截图缓存或 generate_image 缓存)' },
        prompt: { type: 'string', description: '编辑提示词 — 描述编辑区域的期望效果' },
        mask_label: { type: 'string', description: '蒙版图像标签 (透明区域=编辑区)' },
        size: { type: 'string', enum: ['256x256', '512x512', '1024x1024'], description: '输出尺寸' },
        save_path: { type: 'string', description: '保存路径' },
      },
      required: ['image_label', 'prompt'],
    },
  },
  {
    name: 'configure_image_gen',
    description:
      '配置图像生成引擎。支持: openai (DALL-E)、gemini (Imagen)、custom (任何 OpenAI 兼容 API)。\n配置一次后所有后续 generate_image 调用都使用此配置。',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['openai', 'gemini', 'custom'], description: '图像生成引擎类型' },
        api_key: { type: 'string', description: 'API Key' },
        base_url: { type: 'string', description: 'API Base URL (OpenAI 默认 https://api.openai.com)' },
        model: { type: 'string', description: '模型名 (dall-e-3, dall-e-2, gemini-2.0-flash-exp 等)' },
      },
      required: ['provider', 'api_key'],
    },
  },

  // ── Docker Compose / PM2 / Nginx ──
  {
    name: 'deploy_compose_down',
    description: '停止并清理 Docker Compose 部署的服务 (docker compose down -v)',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'deploy_pm2_status',
    description: '查询 PM2 进程状态 — 名称、状态、CPU、内存、运行时间、重启次数',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'deploy_compose_generate',
    description: '生成 docker-compose.yml 内容（仅生成不执行）。返回 YAML 字符串供审查或手动修改。',
    parameters: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: '项目名称' },
        services: {
          type: 'array',
          description: '服务列表',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '服务名' },
              image: { type: 'string', description: 'Docker 镜像（与 build 二选一）' },
              build: { type: 'string', description: 'Dockerfile 路径（与 image 二选一）' },
              ports: { type: 'array', items: { type: 'string' }, description: '端口映射 host:container' },
              env: { type: 'object', description: '环境变量 key-value' },
              volumes: { type: 'array', items: { type: 'string' }, description: '卷挂载 host:container' },
              depends_on: { type: 'array', items: { type: 'string' }, description: '依赖的服务名' },
              command: { type: 'string', description: '自定义启动命令' },
              restart: {
                type: 'string',
                enum: ['always', 'unless-stopped', 'on-failure', 'no'],
                description: '重启策略',
              },
            },
            required: ['name', 'ports'],
          },
        },
        network_name: { type: 'string', description: '自定义网络名（可选）' },
      },
      required: ['project_name', 'services'],
    },
  },
  {
    name: 'deploy_dockerfile_generate',
    description: '生成 Dockerfile 内容（仅生成字符串不写文件）。支持多阶段构建。',
    parameters: {
      type: 'object',
      properties: {
        base_image: { type: 'string', description: '基础镜像 (如 node:20-alpine, python:3.12-slim)' },
        install_cmd: { type: 'string', description: '安装依赖命令 (如 npm ci --omit=dev)' },
        build_cmd: { type: 'string', description: '构建命令 (如 npm run build)' },
        start_cmd: { type: 'string', description: '启动命令 (JSON 数组格式如 ["node","dist/index.js"])' },
        expose_ports: { type: 'array', items: { type: 'number' }, description: '暴露端口列表' },
        work_dir: { type: 'string', description: '工作目录，默认 /app' },
      },
      required: ['base_image', 'start_cmd'],
    },
  },
  {
    name: 'deploy_pm2_start',
    description: '使用 PM2 进程管理器启动 Node.js 应用。自动生成 ecosystem.config.js 并启动。',
    parameters: {
      type: 'object',
      properties: {
        apps: {
          type: 'array',
          description: '要启动的应用列表',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '应用名称' },
              script: { type: 'string', description: '启动脚本路径 (如 dist/index.js)' },
              cwd: { type: 'string', description: '工作目录（可选）' },
              args: { type: 'string', description: '启动参数（可选）' },
              instances: { type: 'number', description: '实例数，0 或 "max" 表示 CPU 核数' },
              env: { type: 'object', description: '环境变量 key-value' },
              max_memory_restart: { type: 'string', description: '内存超限自动重启阈值 (如 500M)' },
              watch: { type: 'boolean', description: '是否监听文件变化自动重启' },
            },
            required: ['name', 'script'],
          },
        },
      },
      required: ['apps'],
    },
  },
  {
    name: 'deploy_nginx_generate',
    description: '生成 Nginx 反向代理站点配置文件。支持 SSL、SPA 模式、WebSocket 代理。',
    parameters: {
      type: 'object',
      properties: {
        server_name: { type: 'string', description: '域名 (如 api.example.com)' },
        upstream: { type: 'string', description: '后端服务地址 (如 127.0.0.1:3000)' },
        listen_port: { type: 'number', description: '监听端口，默认 80 (有 SSL 时默认 443)' },
        static_root: { type: 'string', description: '静态文件根目录路径（可选）' },
        spa_mode: {
          type: 'boolean',
          description: '是否启用 SPA 模式 (所有路由 fallback 到 index.html)',
          default: false,
        },
        ssl_cert_path: { type: 'string', description: 'SSL 证书路径（可选）' },
        ssl_key_path: { type: 'string', description: 'SSL 私钥路径（可选）' },
        output_dir: { type: 'string', description: '配置文件输出目录，默认项目根目录' },
      },
      required: ['server_name', 'upstream'],
    },
  },
  {
    name: 'deploy_find_port',
    description: '检测并返回一个可用的本地端口。用于部署前确认端口不冲突。',
    parameters: {
      type: 'object',
      properties: {
        start_port: { type: 'number', description: '起始端口，默认 3000', default: 3000 },
        end_port: { type: 'number', description: '结束端口，默认 9999', default: 9999 },
      },
    },
  },

  // ── Supabase ──
  {
    name: 'supabase_status',
    description:
      '查询 Supabase 项目状态 (数据库地址、API URL、状态)。需要在密钥管理中配置 supabase_access_token 和 supabase_project_ref。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'supabase_migration_create',
    description: '创建 Supabase 数据库迁移文件。迁移文件会存放在 supabase/migrations/ 目录下。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '迁移名称 (如 add_users_table, create_posts)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'supabase_migration_push',
    description: '将本地迁移推送到远程 Supabase 数据库执行。⚠️ 此操作会修改远程数据库 Schema。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'supabase_db_pull',
    description: '从远程 Supabase 数据库拉取当前 Schema 到本地。用于同步远程手动修改。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'supabase_deploy_function',
    description: '部署 Supabase Edge Function。函数源码应在 supabase/functions/<name>/ 目录下。',
    parameters: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Edge Function 名称' },
      },
      required: ['function_name'],
    },
  },
  {
    name: 'supabase_gen_types',
    description: '从远程 Supabase Schema 生成 TypeScript 类型定义文件。输出到 src/types/supabase.ts。',
    parameters: {
      type: 'object',
      properties: {
        output_path: {
          type: 'string',
          description: '输出路径，默认 src/types/supabase.ts',
          default: 'src/types/supabase.ts',
        },
      },
    },
  },
  {
    name: 'supabase_set_secret',
    description: '设置 Supabase 项目的远程环境变量 (Secret)。用于配置 Edge Functions 的运行时环境。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '环境变量名' },
        value: { type: 'string', description: '环境变量值' },
      },
      required: ['name', 'value'],
    },
  },

  // ── Cloudflare ──
  {
    name: 'cloudflare_deploy_pages',
    description:
      '部署静态站点到 Cloudflare Pages。需要先构建 (npm run build) 生成 dist/ 目录。需要在密钥管理中配置 cloudflare_api_token 和 cloudflare_account_id。',
    parameters: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Pages 项目名称 (首次部署会自动创建)' },
        directory: { type: 'string', description: '构建输出目录，默认 dist', default: 'dist' },
        branch: { type: 'string', description: '部署分支名 (可选，影响预览/正式环境)' },
      },
    },
  },
  {
    name: 'cloudflare_deploy_worker',
    description: '部署 Cloudflare Worker。需要项目根目录有 wrangler.toml 配置文件。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker 名称 (可选，默认用 wrangler.toml 中的配置)' },
        entry_point: { type: 'string', description: '入口文件路径 (可选，默认用 wrangler.toml 中的配置)' },
      },
    },
  },
  {
    name: 'cloudflare_set_secret',
    description: '设置 Cloudflare Worker 的 Secret 环境变量。',
    parameters: {
      type: 'object',
      properties: {
        worker_name: { type: 'string', description: 'Worker 名称' },
        key: { type: 'string', description: '变量名' },
        value: { type: 'string', description: '变量值' },
      },
      required: ['worker_name', 'key', 'value'],
    },
  },
  {
    name: 'cloudflare_dns_list',
    description: '列出域名的 DNS 记录。需要在密钥管理中配置 cloudflare_zone_id。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'cloudflare_dns_create',
    description: '创建 DNS 记录 (A/AAAA/CNAME/TXT/MX 等)。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '记录类型 (A, AAAA, CNAME, TXT, MX 等)' },
        name: { type: 'string', description: '记录名 (如 www, api, @)' },
        content: { type: 'string', description: '记录值 (IP 地址/域名/文本)' },
        proxied: { type: 'boolean', description: '是否通过 Cloudflare 代理，默认 true', default: true },
      },
      required: ['type', 'name', 'content'],
    },
  },
  {
    name: 'cloudflare_status',
    description: '查询 Cloudflare Pages/Workers 部署状态。',
    parameters: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Pages 项目名称' },
      },
      required: ['project_name'],
    },
  },
];
