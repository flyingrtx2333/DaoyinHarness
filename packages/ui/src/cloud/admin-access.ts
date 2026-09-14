export function canShowAdmin(scope: string): boolean { return /^[a-f0-9]{64}$/u.test(scope); }
export function requestedAdminView(hash: string, allowed: boolean): boolean { return allowed && hash === "#admin"; }
