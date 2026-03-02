/**
 * Phase barrel — Re-exports all phase modules for clean imports.
 * @module phases
 */

export { phaseEnvironmentBootstrap } from './bootstrap-phase';
export { phasePMAnalysis, phaseIncrementalPM, phasePMAcceptance } from './pm-phase';
export { phaseArchitect } from './architect-phase';
export { phaseReqsAndTestSpecs, phaseIncrementalDocSync } from './docs-phase';
export { workerLoop } from './worker-phase';
export { phaseDevOpsBuild } from './devops-phase';
export { phaseDeployPipeline } from './deploy-phase';
export { phaseFinalize } from './finalize-phase';
