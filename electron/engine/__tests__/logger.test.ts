/**
 * logger.ts — 日志系统测试
 *
 * 测试维度:
 *  1. createLogger + child logger 命名
 *  2. 日志级别过滤 (setLogLevel)
 *  3. toErrorMessage 对各种输入的处理
 *  4. 结构化输出不崩溃 (data / error / stack)
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createLogger, setLogLevel, toErrorMessage, type LogLevel } from '../logger';

describe('logger', () => {
  // 保存 + 恢复原始 console 方法
  const origDebug = console.debug;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  let captured: { level: string; msg: string }[] = [];

  beforeEach(() => {
    captured = [];
    const capture = (level: string) => (msg: string) => captured.push({ level, msg });
    console.debug = capture('debug') as any;
    console.info = capture('info') as any;
    console.warn = capture('warn') as any;
    console.error = capture('error') as any;
    setLogLevel('debug'); // 开放所有级别
  });

  afterEach(() => {
    console.debug = origDebug;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
    setLogLevel('error'); // 恢复测试环境默认
  });

  describe('createLogger', () => {
    test('创建的 logger 有全部 4 个级别方法 + child', () => {
      const log = createLogger('test-module');
      expect(typeof log.debug).toBe('function');
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.child).toBe('function');
    });

    test('输出包含模块名', () => {
      const log = createLogger('my-mod');
      log.info('hello');
      expect(captured.length).toBe(1);
      expect(captured[0].msg).toContain('my-mod');
      expect(captured[0].msg).toContain('hello');
    });

    test('child logger 输出包含父:子模块名', () => {
      const log = createLogger('parent').child('child');
      log.warn('test-msg');
      expect(captured.length).toBe(1);
      expect(captured[0].msg).toContain('parent:child');
    });
  });

  describe('日志级别过滤', () => {
    test('setLogLevel("warn") 应过滤 debug 和 info', () => {
      setLogLevel('warn');
      const log = createLogger('filter-test');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e', new Error('x'));
      expect(captured.length).toBe(2);
      expect(captured[0].level).toBe('warn');
      expect(captured[1].level).toBe('error');
    });

    test('setLogLevel("error") 应只保留 error', () => {
      setLogLevel('error');
      const log = createLogger('err-only');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e', new Error('x'));
      expect(captured.length).toBe(1);
      expect(captured[0].level).toBe('error');
    });

    test('setLogLevel("debug") 应全部输出', () => {
      setLogLevel('debug');
      const log = createLogger('all');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e', new Error('x'));
      expect(captured.length).toBe(4);
    });
  });

  describe('结构化数据输出', () => {
    test('带 data 对象不崩溃', () => {
      const log = createLogger('data-test');
      log.info('msg', { key: 'value', num: 42 });
      expect(captured.length).toBe(1);
      expect(captured[0].msg).toContain('key');
    });

    test('error 带 Error 对象输出 error message', () => {
      const log = createLogger('err-test');
      log.error('boom', new Error('test-error'));
      expect(captured.length).toBe(1);
      expect(captured[0].msg).toContain('test-error');
    });

    test('error 带字符串作为 err 参数', () => {
      const log = createLogger('str-err');
      log.error('oops', 'string-error');
      expect(captured.length).toBe(1);
      expect(captured[0].msg).toContain('string-error');
    });
  });

  describe('toErrorMessage', () => {
    test('Error 实例返回 message', () => {
      expect(toErrorMessage(new Error('hello'))).toBe('hello');
    });

    test('字符串直接返回', () => {
      expect(toErrorMessage('raw string')).toBe('raw string');
    });

    test('带 message 属性的对象', () => {
      expect(toErrorMessage({ message: 'obj-msg' })).toBe('obj-msg');
    });

    test('数字', () => {
      expect(toErrorMessage(42)).toBe('42');
    });

    test('null', () => {
      expect(toErrorMessage(null)).toBe('null');
    });

    test('undefined', () => {
      expect(toErrorMessage(undefined)).toBe('undefined');
    });

    test('普通对象用 JSON.stringify', () => {
      expect(toErrorMessage({ a: 1 })).toBe('{"a":1}');
    });

    test('循环引用对象不崩溃', () => {
      const obj: any = {};
      obj.self = obj;
      const result = toErrorMessage(obj);
      expect(typeof result).toBe('string');
    });
  });
});
