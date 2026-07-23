export const MAX_TOOL_RUNTIME_MS = 2_147_483_647;

type ToolRuntimeFailureKind = 'aborted' | 'timeout';

export interface ToolRuntimeFailure {
  status: 'error' | 'timeout';
  code: 'TOOL_EXECUTION_ABORTED' | 'TOOL_RUNTIME_LIMIT_EXCEEDED';
  message: 'Tool execution aborted' | 'Tool runtime limit exceeded';
}

export interface ToolRuntimeGuard {
  signal: AbortSignal;
  throwIfAbortedOrExpired(): void;
  dispose(): void;
}

class ToolRuntimeFailureError extends Error {
  constructor(readonly kind: ToolRuntimeFailureKind) {
    super(failureForKind(kind).message);
    this.name = 'ToolRuntimeFailureError';
  }
}

export function startToolRuntimeGuard(
  upstreamSignal: AbortSignal | undefined,
  maxRuntimeMs: number | undefined,
): ToolRuntimeGuard {
  const normalizedUpstreamSignal = upstreamSignal ?? new AbortController().signal;
  const controller = new AbortController();
  const startedAt = performance.now();
  let failureKind: ToolRuntimeFailureKind | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let listeningForUpstreamAbort = false;

  const dispose = (): void => {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    if (listeningForUpstreamAbort) {
      normalizedUpstreamSignal.removeEventListener('abort', handleUpstreamAbort);
      listeningForUpstreamAbort = false;
    }
  };

  const abort = (kind: ToolRuntimeFailureKind): void => {
    if (failureKind !== undefined) {
      return;
    }

    failureKind = kind;
    dispose();
    controller.abort(new ToolRuntimeFailureError(kind));
  };

  function handleUpstreamAbort(): void {
    abort('aborted');
  }

  if (normalizedUpstreamSignal.aborted) {
    abort('aborted');
  } else {
    normalizedUpstreamSignal.addEventListener('abort', handleUpstreamAbort, { once: true });
    listeningForUpstreamAbort = true;
    if (maxRuntimeMs !== undefined) {
      deadlineTimer = setTimeout(() => abort('timeout'), maxRuntimeMs);
    }
  }

  return {
    signal: controller.signal,
    throwIfAbortedOrExpired(): void {
      if (
        failureKind === undefined
        && maxRuntimeMs !== undefined
        && performance.now() - startedAt >= maxRuntimeMs
      ) {
        abort('timeout');
      }

      if (failureKind !== undefined) {
        throw new ToolRuntimeFailureError(failureKind);
      }
    },
    dispose,
  };
}

export function getToolRuntimeFailure(error: unknown): ToolRuntimeFailure | undefined {
  return error instanceof ToolRuntimeFailureError
    ? failureForKind(error.kind)
    : undefined;
}

function failureForKind(kind: ToolRuntimeFailureKind): ToolRuntimeFailure {
  return kind === 'timeout'
    ? {
        status: 'timeout',
        code: 'TOOL_RUNTIME_LIMIT_EXCEEDED',
        message: 'Tool runtime limit exceeded',
      }
    : {
        status: 'error',
        code: 'TOOL_EXECUTION_ABORTED',
        message: 'Tool execution aborted',
      };
}
