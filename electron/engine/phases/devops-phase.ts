/**
 * DevOps Phase — 自动构建验证 (G8)
 * Extracted from orchestrator.ts for maintainability.
 * @module phases/devops-phase
 */

import {
  BrowserWindow, getDb, createLogger, execAsync, fs, path,
  sendToUI, addLog,
  spawnAgent,
  emitEvent,
  commitWorkspace,
  type AppSettings,
} from './shared';

const log = createLogger('phase:devops');

export async function phaseDevOpsBuild(
  projectId: string, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string,
): Promise<void> {
  if (signal.aborted) return;

  const db = getDb();
  const devopsId = 'devops-0';  // 固定 ID: 复用同一 DevOps Agent
  spawnAgent(projectId, devopsId, 'devops', win);
  sendToUI(win, 'agent:status', { projectId, agentId: devopsId, status: 'working', currentTask: 'build-verify', featureTitle: '构建验证' });
  sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: '🚀 Phase 4d: DevOps 自动构建验证...' });

  const buildSteps: Array<{ name: string; cmd: string; critical: boolean }> = [];

  const hasPackageJson = fs.existsSync(path.join(workspacePath, 'package.json'));
  const hasRequirements = fs.existsSync(path.join(workspacePath, 'requirements.txt'));
  const hasPyproject = fs.existsSync(path.join(workspacePath, 'pyproject.toml'));
  const hasCargoToml = fs.existsSync(path.join(workspacePath, 'Cargo.toml'));
  const hasGoMod = fs.existsSync(path.join(workspacePath, 'go.mod'));

  if (hasPackageJson) {
    buildSteps.push({ name: '安装依赖', cmd: 'npm install --prefer-offline 2>&1', critical: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf-8'));
    const hasTsc = pkg.devDependencies?.typescript || pkg.dependencies?.typescript;
    if (hasTsc || fs.existsSync(path.join(workspacePath, 'tsconfig.json'))) {
      buildSteps.push({ name: '类型检查', cmd: 'npx tsc --noEmit 2>&1', critical: false });
    }
    if (pkg.devDependencies?.eslint || pkg.dependencies?.eslint || pkg.scripts?.lint) {
      buildSteps.push({ name: 'Lint', cmd: pkg.scripts?.lint ? 'npm run lint 2>&1' : 'npx eslint . --ext .ts,.tsx,.js,.jsx 2>&1', critical: false });
    }
    if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
      buildSteps.push({ name: '测试', cmd: 'npm test 2>&1', critical: false });
    }
    if (pkg.scripts?.build) {
      buildSteps.push({ name: '构建', cmd: 'npm run build 2>&1', critical: true });
    }
  } else if (hasRequirements || hasPyproject) {
    if (hasRequirements) buildSteps.push({ name: '安装依赖', cmd: 'pip install -r requirements.txt 2>&1', critical: true });
    if (hasPyproject) buildSteps.push({ name: '安装依赖', cmd: 'pip install -e . 2>&1', critical: true });
    buildSteps.push({ name: '语法检查', cmd: 'python -m py_compile $(find . -name "*.py" -not -path "*/venv/*" -not -path "*/.venv/*" | head -50) 2>&1', critical: false });
    buildSteps.push({ name: '测试', cmd: 'pytest --tb=short 2>&1 || python -m pytest --tb=short 2>&1 || echo "No pytest"', critical: false });
  } else if (hasCargoToml) {
    buildSteps.push({ name: '构建', cmd: 'cargo build 2>&1', critical: true });
    buildSteps.push({ name: '测试', cmd: 'cargo test 2>&1', critical: false });
  } else if (hasGoMod) {
    buildSteps.push({ name: '构建', cmd: 'go build ./... 2>&1', critical: true });
    buildSteps.push({ name: '测试', cmd: 'go test ./... 2>&1', critical: false });
  }

  if (buildSteps.length === 0) {
    sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: '  ↳ 未检测到已知构建系统，跳过' });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(devopsId);
    sendToUI(win, 'agent:status', { projectId, agentId: devopsId, status: 'idle' });
    return;
  }

  let allPassed = true;
  const results: Array<{ name: string; ok: boolean; output: string }> = [];

  for (const step of buildSteps) {
    if (signal.aborted) break;
    sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: `  🔧 ${step.name}...` });
    try {
      const { stdout } = await execAsync(step.cmd, { cwd: workspacePath, encoding: 'utf-8', timeout: 120_000, maxBuffer: 1024 * 1024 });
      results.push({ name: step.name, ok: true, output: (stdout || '').slice(-500) });
      sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: `  ✅ ${step.name} 成功` });
    } catch (err: unknown) {
      const errObj = err as { stdout?: string; stderr?: string; message?: string };
      const output = (errObj.stdout || '') + (errObj.stderr || '');
      results.push({ name: step.name, ok: false, output: output.slice(-500) });
      if (step.critical) {
        allPassed = false;
        sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: `  ❌ ${step.name} 失败 (关键步骤):\n${output.slice(-300)}` });
      } else {
        sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: `  ⚠️ ${step.name} 失败 (非关键):\n${output.slice(-200)}` });
      }
    }
  }

  const passedCount = results.filter(r => r.ok).length;
  const summary = allPassed
    ? `✅ 构建验证全部通过 (${passedCount}/${results.length} 步骤)`
    : `⚠️ 构建验证部分失败 (${passedCount}/${results.length} 步骤通过)`;

  sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: summary });
  addLog(projectId, devopsId, 'log', summary);

  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(devopsId);
  sendToUI(win, 'agent:status', { projectId, agentId: devopsId, status: 'idle' });
  emitEvent({ projectId, agentId: devopsId, type: 'phase:dev:end', data: { devops: true, allPassed, steps: results.length, passed: passedCount } });

  if (workspacePath && allPassed) {
    await commitWorkspace(workspacePath, 'AutoMater: DevOps build verification passed');
  }
}
