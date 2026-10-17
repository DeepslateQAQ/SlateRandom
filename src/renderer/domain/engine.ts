import canonicalEngine from '../../shared/domain/engine.js';
import type { DomainEngine } from '../../shared/domain/model';

// Keep one canonical algorithm while the presentation moves to Vue. This is
// deliberately a typed boundary, so v1 seeds, records and undo stay identical.
export const engine: DomainEngine = canonicalEngine;
export default engine;
