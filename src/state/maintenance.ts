/**
 * 状态库维护态的统一文案（#254）：`/dsh-flow list` 与运行监控横幅同源，
 * 避免两处各写一份导致提示漂移。
 */
import type { StateMaintenanceDiagnostic } from './store.ts'

export function maintenanceText(diagnostic: StateMaintenanceDiagnostic): string {
  return [
    'Workflow State Store is in maintenance mode; ordinary list/start/tools are disabled.',
    `path: ${diagnostic.path}`,
    `user_version: ${diagnostic.userVersion ?? 'unreadable'}`,
    `reason: ${diagnostic.reason}`,
    'No data was migrated or replaced. Plain /dsh-flow reset cannot cut over an incompatible store.',
    'A root user may back up and replace the ENTIRE workflow State Store with: /dsh-flow reset --incompatible-store',
    'This does not cancel old external effects; inspect them before starting new work.',
  ].join('\n')
}
