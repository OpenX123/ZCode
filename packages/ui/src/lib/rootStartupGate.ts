interface RootStartupGateState {
  isRestoring: boolean;
  isBootstrappingInitialWorkspace: boolean;
}

export function shouldBlockRootRender(state: RootStartupGateState): boolean {
  return state.isRestoring || state.isBootstrappingInitialWorkspace;
}

export function shouldShowRootStartupLoading(
  state: RootStartupGateState & { isDesktop: boolean | undefined },
): boolean {
  return Boolean(state.isDesktop) && shouldBlockRootRender(state);
}

export function shouldOpenFallbackWorkspaceAfterCreate(state: {
  isMounted: boolean;
  activeWorkspacePath: string | null;
}): boolean {
  return state.isMounted && !state.activeWorkspacePath;
}
