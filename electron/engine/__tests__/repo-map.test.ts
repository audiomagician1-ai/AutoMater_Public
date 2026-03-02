/// <reference types="vitest" />
/**
 * repo-map.ts — 代码结构索引生成测试
 *
 * 在 temp dir 下创建多语言示例项目，测试符号提取 + repo map 生成。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateRepoMap } from '../repo-map';

describe('repo-map', () => {
  let tmpDir: string;

  function writeFile(rel: string, content: string): void {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmap-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('空目录返回空串', () => {
    expect(generateRepoMap(tmpDir)).toBe('');
  });

  test('TypeScript 文件提取 function/class/interface/type/export', () => {
    writeFile('src/utils.ts', `
export function helper(x: number): string {
  return x.toString();
}

export class Engine {
  start() {}
}

export interface Config {
  name: string;
}

export type Status = 'ok' | 'error';

export const VERSION = '1.0.0';
`);
    const map = generateRepoMap(tmpDir);
    expect(map).toContain('Repository Map');
    expect(map).toContain('src/utils.ts');
    expect(map).toContain('export function helper');
    expect(map).toContain('export class Engine');
    expect(map).toContain('export interface Config');
    expect(map).toContain('export type Status');
    expect(map).toContain('export const VERSION');
  });

  test('Python 文件提取 def/class', () => {
    writeFile('app/main.py', `
def handle_request(req):
    pass

class UserService:
    def get_user(self, user_id):
        pass

async def async_handler():
    pass
`);
    const map = generateRepoMap(tmpDir);
    expect(map).toContain('def handle_request');
    expect(map).toContain('class UserService');
    expect(map).toContain('async def async_handler');
  });

  test('Go 文件提取 func/type struct', () => {
    writeFile('main.go', `
package main

func (s *Server) HandleRequest(w http.ResponseWriter, r *http.Request) {
}

type Config struct {
    Port int
}
`);
    const map = generateRepoMap(tmpDir);
    expect(map).toContain('package main');
    expect(map).toContain('func');
    expect(map).toContain('type Config struct');
  });

  test('Rust 文件提取 fn/struct/impl', () => {
    writeFile('src/lib.rs', `
pub fn process(data: &[u8]) -> Result<(), Error> {
    Ok(())
}

pub struct Engine {
    state: State,
}

impl Engine {
    pub fn new() -> Self {
        Engine { state: State::Idle }
    }
}
`);
    const map = generateRepoMap(tmpDir);
    expect(map).toContain('pub fn process');
    expect(map).toContain('pub struct Engine');
    expect(map).toContain('impl Engine');
  });

  test('忽略 node_modules', () => {
    writeFile('node_modules/pkg/index.ts', 'export function x() {}');
    writeFile('src/app.ts', 'export function y() {}');
    const map = generateRepoMap(tmpDir);
    expect(map).not.toContain('node_modules');
    expect(map).toContain('export function y');
  });

  test('maxFiles 限制文件数', () => {
    for (let i = 0; i < 10; i++) {
      writeFile(`src/mod${i}.ts`, `export function fn${i}() {}`);
    }
    const map = generateRepoMap(tmpDir, 3);
    // 最多 3 个文件
    const fileHeaders = (map.match(/### /g) || []).length;
    expect(fileHeaders).toBeLessThanOrEqual(3);
  });

  test('maxTotalLines 限制输出长度', () => {
    for (let i = 0; i < 20; i++) {
      writeFile(`src/mod${i}.ts`, Array(30).fill(`export function fn${i}_line() {}`).join('\n'));
    }
    const map = generateRepoMap(tmpDir, 80, 20, 10);
    const lineCount = map.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(15); // 10 + some margin
    expect(map).toContain('已截断');
  });

  test('跳过大文件 (>256KB)', () => {
    const bigContent = 'export function x() {}\n'.repeat(20000); // ~440KB
    writeFile('src/big.ts', bigContent);
    writeFile('src/small.ts', 'export function y() {}');
    const map = generateRepoMap(tmpDir);
    expect(map).not.toContain('src/big.ts');
    expect(map).toContain('src/small.ts');
  });
});

