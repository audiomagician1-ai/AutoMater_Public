/**
 * Phase barrel — Re-exports all phase modules for clean imports.
 * @module phases
 */

export { phasePMAnalysis, phaseIncrementalPM, phasePMAcceptance } from './pm-phase';
export { phaseArchitect } from './architect-phase';
export { phaseReqsAndTestSpecs } from './docs-phase';
// worker-phase, devops-phase, finalize-phase remain in orchestrator.ts for now
// They will be extracted in subsequent iterations.
