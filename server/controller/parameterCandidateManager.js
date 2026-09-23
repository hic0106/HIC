// Placeholder for future parameter research. Disabled in V1: the controller never changes
// Turtle 20/10, ADX 14/25 or TSMOM 30 parameters and never generates new parameters.
export class ParameterCandidateManager {
  constructor() { this.enabled = false; }
  listCandidates() { return []; }
  propose() { return { ok: false, msg: 'ParameterCandidateManager is disabled in Controller V1' }; }
}
