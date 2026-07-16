import type { CourStore } from '../cour/store';
import type { ReelyProvider } from './providers/types';

// Simplified context -- providers are injected via res.locals by app.ts middleware.
export interface RouteContext {
  providers: ReelyProvider[];
  // The SQLite-backed cour store (0.5.0): accounts, sessions, rooms,
  // verdicts, results. Optional for the same test-harness reason; auth
  // and verdict handlers answer with errors when absent.
  cour?: CourStore;
}
