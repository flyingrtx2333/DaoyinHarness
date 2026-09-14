export function keepReadyAfterBackgroundFailure(
  quiet: boolean,
  previousScope: string,
  currentScope: string,
  status?: number,
): boolean {
  return quiet && previousScope.length > 0 && previousScope === currentScope && status !== 401 && status !== 403;
}
