// Process definitions + execution handlers (docs/LLD.md section 4, ADR 003).
export * from './types';
export * from './processes';
export * from './handlers';
export { runOnce, type RunOptions, type RunResult } from './executor';
export * from './bp-policy';
export { syncProcessDefs, syncProductAccess } from './sync';
