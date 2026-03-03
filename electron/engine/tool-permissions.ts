/**
 * Tool Permissions — Role-based tool access control
 *
 * 各角色可用工具白名单 — 最小权限原则。
 * 从 tool-registry.ts (1850行) 拆出以提升可维护性。
 */

export type AgentRole = 'pm' | 'architect' | 'developer' | 'qa' | 'devops' | 'researcher' | 'meta-agent';

/** 各角色可用工具白名单 — 最小权限原则 */
const ROLE_TOOLS: Record<AgentRole, string[]> = {
  pm: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'scratchpad_write', 'scratchpad_read',  // v19.0: 持久化工作记忆
    'read_file', 'list_files', 'search_files', 'glob_files',
    'code_search', 'code_search_files', 'read_many_files', 'repo_map', 'code_graph_query',  // v17.0: 高级搜索
    // v5.5: PM 需要读文件能力 (分析用户提到的本地工程)
    'web_search', 'fetch_url',
    'web_search_boost', 'deep_research', 'configure_search',  // v8.0
    'download_file', 'search_images',  // v19.0
    'generate_image', 'configure_image_gen',  // v9.0
    'memory_read', 'memory_append',
    'report_blocked',  // v5.5: 信息不足时阻塞反馈给用户
    'rfc_propose',     // v5.5: RFC 设计变更提案
  ],
  architect: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'scratchpad_write', 'scratchpad_read',  // v19.0: 持久化工作记忆
    'read_file', 'list_files', 'search_files', 'glob_files',
    'code_search', 'code_search_files', 'read_many_files', 'repo_map', 'code_graph_query',  // v17.0
    'write_file',
    'web_search', 'fetch_url',
    'web_search_boost', 'deep_research', 'configure_search',  // v8.0
    'download_file', 'search_images',  // v19.0
    'generate_image', 'configure_image_gen',  // v9.0
    'memory_read', 'memory_append',
    'report_blocked',  // v5.5: 信息不足时阻塞反馈给用户
    'rfc_propose',     // v5.5: RFC 设计变更提案
  ],
  developer: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'scratchpad_write', 'scratchpad_read',  // v19.0: 持久化工作记忆
    'read_file', 'write_file', 'edit_file', 'batch_edit',
    'list_files', 'glob_files', 'search_files',
    'code_search', 'code_search_files', 'read_many_files', 'repo_map', 'code_graph_query',  // v17.0
    'run_command', 'run_test', 'run_lint',
    'git_commit', 'git_diff',
    'github_close_issue', 'github_add_comment', 'github_get_issue',  // v13.0
    // v14.0: Branch + Remote Sync + PR
    'git_create_branch', 'git_switch_branch', 'git_list_branches', 'git_delete_branch',
    'git_pull', 'git_push', 'git_fetch',
    'github_create_pr', 'github_list_prs', 'github_get_pr', 'github_merge_pr',
    'web_search', 'fetch_url', 'http_request',
    'web_search_boost', 'deep_research', 'configure_search',  // v8.0
    'download_file', 'search_images',  // v19.0
    'spawn_researcher',
    'memory_read', 'memory_append',
    'check_process', 'wait_for_process',   // v6.0/v19.0: 查询/等待后台进程
    'rfc_propose',     // v5.5: RFC 设计变更提案
    // Computer Use — 调试 GUI/桌面应用
    'screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey',
    // Playwright 浏览器 — 调试 Web 前端
    'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
    'browser_network', 'browser_close',
    // v7.0: 浏览器增强
    'browser_hover', 'browser_select_option', 'browser_press_key', 'browser_fill_form',
    'browser_drag', 'browser_tabs', 'browser_file_upload', 'browser_console',
    // 视觉验证
    'analyze_image', 'compare_screenshots', 'visual_assert',
    // 技能进化 (v5.1)
    'skill_acquire', 'skill_search', 'skill_improve', 'skill_record_usage',
    // v7.0: Sub-Agent
    'spawn_agent', 'spawn_parallel', 'list_sub_agents', 'cancel_sub_agent',
    // v7.0: Docker Sandbox
    'sandbox_init', 'sandbox_exec', 'sandbox_write', 'sandbox_read', 'sandbox_destroy',
    // v8.0: Black-box test runner
    'run_blackbox_tests',
    // v9.0: Image Generation
    'generate_image', 'edit_image', 'configure_image_gen',
    // v9.0+v15.0: Deployment Tools
    'deploy_compose_up', 'deploy_compose_down',
    'deploy_dockerfile', 'deploy_dockerfile_generate',
    'deploy_health_check', 'deploy_find_port',
    'deploy_nginx_generate',
    // v14.0: Supabase (开发相关)
    'supabase_status', 'supabase_migration_create', 'supabase_db_pull', 'supabase_gen_types',
    // v14.0: Cloudflare (查看状态)
    'cloudflare_status',
  ],
  qa: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'scratchpad_write', 'scratchpad_read',  // v19.0: 持久化工作记忆
    'read_file', 'list_files', 'search_files', 'glob_files',
    'code_search', 'code_search_files', 'read_many_files', 'repo_map', 'code_graph_query',  // v17.0
    'run_command', 'run_test', 'run_lint',
    'web_search', 'fetch_url', 'http_request',
    'web_search_boost', 'deep_research',  // v8.0
    'download_file', 'search_images',  // v19.0
    'memory_read', 'memory_append',
    'screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey',
    'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
    'browser_network', 'browser_close',
    // v7.0: 浏览器增强
    'browser_hover', 'browser_select_option', 'browser_press_key', 'browser_fill_form',
    'browser_drag', 'browser_tabs', 'browser_file_upload', 'browser_console',
    'analyze_image', 'compare_screenshots', 'visual_assert',
    // 技能进化 (v5.1)
    'skill_search', 'skill_record_usage',
    'rfc_propose',     // v5.5: RFC 设计变更提案
    // v7.0: Sub-Agent (QA can spawn researcher for analysis)
    'spawn_agent', 'list_sub_agents',
    // v7.0: Docker Sandbox (QA can use sandbox for test isolation)
    'sandbox_init', 'sandbox_exec', 'sandbox_read', 'sandbox_destroy',
    // v8.0: Black-box test runner
    'run_blackbox_tests',
  ],
  devops: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'scratchpad_write', 'scratchpad_read',  // v19.0: 持久化工作记忆
    // v13.0: 文件操作 (完整读写)
    'read_file', 'write_file', 'edit_file', 'batch_edit',
    'list_files', 'glob_files', 'search_files',
    'code_search', 'code_search_files', 'read_many_files', 'repo_map', 'code_graph_query',  // v17.0
    // 命令执行
    'run_command', 'check_process', 'wait_for_process', 'run_test', 'run_lint',
    // HTTP
    'http_request', 'fetch_url',
    // Git + GitHub
    'git_commit', 'git_diff', 'git_log',
    'github_create_issue', 'github_list_issues',
    'github_close_issue', 'github_add_comment', 'github_get_issue',
    // v14.0: Branch + Remote Sync + PR
    'git_create_branch', 'git_switch_branch', 'git_list_branches', 'git_delete_branch',
    'git_pull', 'git_push', 'git_fetch',
    'github_create_pr', 'github_list_prs', 'github_get_pr', 'github_merge_pr',
    // v9.0+: Deploy Tools (core)
    'deploy_compose_up', 'deploy_compose_down', 'deploy_health_check', 'deploy_dockerfile',
    // v15.0: Extended Deploy Tools (I4)
    'deploy_compose_generate', 'deploy_dockerfile_generate',
    'deploy_pm2_start', 'deploy_pm2_status',
    'deploy_nginx_generate', 'deploy_find_port',
    // Docker Sandbox
    'sandbox_init', 'sandbox_exec', 'sandbox_write', 'sandbox_read', 'sandbox_destroy',
    // 搜索
    'web_search', 'web_search_boost',
    'download_file', 'search_images',  // v19.0
    // 记忆
    'memory_read', 'memory_append',
    // v14.0: Supabase (全部)
    'supabase_status', 'supabase_migration_create', 'supabase_migration_push',
    'supabase_db_pull', 'supabase_deploy_function', 'supabase_gen_types', 'supabase_set_secret',
    // v14.0: Cloudflare (全部)
    'cloudflare_deploy_pages', 'cloudflare_deploy_worker', 'cloudflare_set_secret',
    'cloudflare_dns_list', 'cloudflare_dns_create', 'cloudflare_status',
  ],
  researcher: [
    'think',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'code_search', 'code_search_files', 'read_many_files', 'repo_map', 'code_graph_query',  // v17.0
    'web_search', 'fetch_url',
    'web_search_boost', 'deep_research',  // v8.0
    'download_file', 'search_images',  // v19.0
  ],
  // v6.1: 元Agent (管家) — 只读工具集 + 搜索 + 项目查询 + 需求派发
  //   模式裁剪在 meta-agent.ts 中按 mode 动态过滤
  //   v23.0: 移除 git_log — 管家无权访问 git 历史，防止信息泄露
  'meta-agent': [
    'think', 'task_complete',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'code_search', 'code_search_files', 'read_many_files', 'repo_map', 'code_graph_query',  // v17.0
    'web_search', 'fetch_url',
    'web_search_boost', 'deep_research',  // v8.0
    'download_file', 'search_images',  // v19.0
    'memory_read', 'memory_append',
    'create_wish',  // v21.0: 派发任务给团队
    // v22.0: 深度讨论模式 — 可输出文件 + 派发任务
    'write_file', 'edit_file', 'batch_edit',
    // v22.0: 管理模式 — 项目配置/成员/工作流管理
    'admin_list_members', 'admin_add_member', 'admin_update_member', 'admin_remove_member',
    'admin_list_workflows', 'admin_activate_workflow', 'admin_update_workflow',
    'admin_update_project', 'admin_get_available_stages',
  ],
};

export { ROLE_TOOLS };

