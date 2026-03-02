/**
 * System Monitor — 系统性能指标采集 + 活动时序聚合
 *
 * 1. 系统性能：CPU / GPU / 内存 / 硬盘 / 网络实时采样
 * 2. 活动时序：从 event-store 聚合每分钟 token / cost / 代码行写入
 *
 * v6.0.0: 初始实现
 */

import * as os from 'os';
import { getDb } from '../db';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface SystemMetrics {
  timestamp: number;
  cpu: {
    /** 总体 CPU 使用率 0~100 */
    usage: number;
    /** 逻辑核心数 */
    cores: number;
    /** 每核心使用率 */
    perCore: number[];
  };
  memory: {
    /** 已用内存 bytes */
    used: number;
    /** 总内存 bytes */
    total: number;
    /** 使用率 0~100 */
    percent: number;
  };
  gpu: {
    /** GPU 使用率 0~100 (-1 = 不可用) */
    usage: number;
    /** GPU 显存使用率 0~100 (-1 = 不可用) */
    memoryPercent: number;
    /** GPU 名称 */
    name: string;
  };
  disk: {
    /** 磁盘读速率 bytes/s (近似) */
    readBytesPerSec: number;
    /** 磁盘写速率 bytes/s (近似) */
    writeBytesPerSec: number;
  };
  network: {
    /** 网络接收速率 bytes/s */
    rxBytesPerSec: number;
    /** 网络发送速率 bytes/s */
    txBytesPerSec: number;
  };
  /** Electron 进程自身 */
  process: {
    /** 进程占用内存 MB */
    memoryMB: number;
    /** 进程运行时长 s */
    uptimeS: number;
  };
}

export interface ActivityDataPoint {
  /** 分钟时间桶 (ISO, 截断到分钟) */
  minute: string;
  /** 该分钟内消耗的 input tokens */
  inputTokens: number;
  /** 该分钟内消耗的 output tokens */
  outputTokens: number;
  /** 该分钟内的花费 USD */
  costUsd: number;
  /** 该分钟内写入的代码行数 */
  linesWritten: number;
  /** 该分钟内的 LLM 调用次数 */
  llmCalls: number;
  /** 该分钟内的工具调用次数 */
  toolCalls: number;
}

// ═══════════════════════════════════════
// CPU 采样
// ═══════════════════════════════════════

let _prevCpuTimes: Array<{ idle: number; total: number }> = [];

function sampleCpuUsage(): { usage: number; cores: number; perCore: number[] } {
  const cpus = os.cpus();
  const perCore: number[] = [];
  let totalIdle = 0;
  let totalTick = 0;

  for (let i = 0; i < cpus.length; i++) {
    const cpu = cpus[i];
    const idle = cpu.times.idle;
    const total = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;

    if (_prevCpuTimes[i]) {
      const deltaIdle = idle - _prevCpuTimes[i].idle;
      const deltaTotal = total - _prevCpuTimes[i].total;
      const usage = deltaTotal > 0 ? Math.round((1 - deltaIdle / deltaTotal) * 100) : 0;
      perCore.push(Math.max(0, Math.min(100, usage)));
    } else {
      perCore.push(0);
    }

    totalIdle += idle;
    totalTick += total;
  }

  // 更新上次快照
  _prevCpuTimes = cpus.map(cpu => ({
    idle: cpu.times.idle,
    total: cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle,
  }));

  const prevTotalIdle = _prevCpuTimes.reduce((a, b) => a + b.idle, 0);
  const prevTotalTick = _prevCpuTimes.reduce((a, b) => a + b.total, 0);

  // 总体使用率 = 全核心平均
  const avgUsage = perCore.length > 0
    ? Math.round(perCore.reduce((a, b) => a + b, 0) / perCore.length)
    : 0;

  return { usage: avgUsage, cores: cpus.length, perCore };
}

// ═══════════════════════════════════════
// GPU 采样 (Windows: nvidia-smi, 无GPU则返回-1)
// ═══════════════════════════════════════

let _lastGpu: { usage: number; memoryPercent: number; name: string } = {
  usage: -1, memoryPercent: -1, name: 'N/A',
};
let _gpuSamplePending = false;

async function sampleGpu(): Promise<{ usage: number; memoryPercent: number; name: string }> {
  if (_gpuSamplePending) return _lastGpu; // 防止并发调用
  if (process.platform !== 'win32') return _lastGpu;

  _gpuSamplePending = true;
  try {
    const { execSync } = await import('child_process');
    const output = execSync(
      'nvidia-smi --query-gpu=utilization.gpu,utilization.memory,name --format=csv,noheader,nounits',
      { timeout: 3000, encoding: 'utf8', windowsHide: true },
    );
    const parts = output.trim().split(',').map(s => s.trim());
    if (parts.length >= 3) {
      _lastGpu = {
        usage: parseInt(parts[0]) || 0,
        memoryPercent: parseInt(parts[1]) || 0,
        name: parts[2],
      };
    }
  } catch {
    // nvidia-smi 不存在或执行失败 — 保持上一次值或 -1
  }
  _gpuSamplePending = false;
  return _lastGpu;
}

// ═══════════════════════════════════════
// 网络 + 磁盘 (差值估算)
// ═══════════════════════════════════════

let _prevNet = { rx: 0, tx: 0, ts: Date.now() };
let _prevDisk = { read: 0, write: 0, ts: Date.now() };

function sampleNetwork(): { rxBytesPerSec: number; txBytesPerSec: number } {
  const interfaces = os.networkInterfaces();
  // 这里无法精确获取流量，用 Node 级别 fallback
  // 返回 0 — 精确网络需要 perf counter / WMI，复杂度高
  // 后续可接入 systeminformation 库
  return { rxBytesPerSec: 0, txBytesPerSec: 0 };
}

// ═══════════════════════════════════════
// 主采集函数
// ═══════════════════════════════════════

/**
 * 获取当前系统性能快照
 */
export async function getSystemMetrics(): Promise<SystemMetrics> {
  const mem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = mem - freeMem;
  const cpu = sampleCpuUsage();
  const gpu = await sampleGpu();
  const net = sampleNetwork();
  const procMem = process.memoryUsage();

  return {
    timestamp: Date.now(),
    cpu,
    memory: {
      used: usedMem,
      total: mem,
      percent: Math.round((usedMem / mem) * 100),
    },
    gpu,
    disk: {
      readBytesPerSec: 0,
      writeBytesPerSec: 0,
    },
    network: net,
    process: {
      memoryMB: Math.round(procMem.rss / 1024 / 1024),
      uptimeS: Math.round(process.uptime()),
    },
  };
}

// ═══════════════════════════════════════
// 活动时序数据（从 events 表聚合）
// ═══════════════════════════════════════

/**
 * 获取项目最近 N 分钟的活动时序数据（每分钟一个数据点）
 */
export function getActivityTimeseries(projectId: string, minutes: number = 30): ActivityDataPoint[] {
  const db = getDb();
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  // 按分钟聚合 events 表
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:%M:00', created_at) AS minute,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      SUM(CASE WHEN type = 'llm:call' OR type = 'llm:result' THEN 1 ELSE 0 END) AS llm_calls,
      SUM(CASE WHEN type = 'tool:call' THEN 1 ELSE 0 END) AS tool_calls
    FROM events
    WHERE project_id = ? AND created_at >= ?
    GROUP BY minute
    ORDER BY minute ASC
  `).all(projectId, since) as any[];

  // 代码行写入：从 tool:result 事件中提取 (file-writer 写入会记录行数)
  const lineRows = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:%M:00', created_at) AS minute,
      COALESCE(SUM(CAST(json_extract(data, '$.linesWritten') AS INTEGER)), 0) AS lines
    FROM events
    WHERE project_id = ? AND created_at >= ?
      AND type = 'tool:result'
      AND json_extract(data, '$.linesWritten') IS NOT NULL
    GROUP BY minute
    ORDER BY minute ASC
  `).all(projectId, since) as any[];

  const linesMap = new Map<string, number>();
  for (const r of lineRows) linesMap.set(r.minute, r.lines);

  // 构建完整时间轴（补齐空缺分钟）
  const result: ActivityDataPoint[] = [];
  const dataMap = new Map<string, any>();
  for (const r of rows) dataMap.set(r.minute, r);

  const now = new Date();
  for (let i = minutes - 1; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 60 * 1000);
    const key = t.toISOString().slice(0, 16) + ':00';
    const row = dataMap.get(key);
    result.push({
      minute: key,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      costUsd: row?.cost_usd ?? 0,
      linesWritten: linesMap.get(key) ?? 0,
      llmCalls: row?.llm_calls ?? 0,
      toolCalls: row?.tool_calls ?? 0,
    });
  }

  return result;
}

/**
 * 获取内置模型价格表（供前端设置界面展示默认值参考）
 */
export function getBuiltinModelPricing(): Record<string, { input: number; output: number }> {
  // Lazy import to avoid circular dependency
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MODEL_PRICING } = require('./llm-client');
  return { ...MODEL_PRICING };
}
