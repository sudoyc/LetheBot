declare const preparedLocalToolEffectBrand: unique symbol;

export interface PreparedLocalToolEffect<TResult = unknown> {
  readonly publicResult: TResult;
  readonly [preparedLocalToolEffectBrand]: never;
}

interface PreparedLocalToolEffectState {
  apply: () => void;
  consumed: boolean;
}

const preparedEffects = new WeakMap<object, PreparedLocalToolEffectState>();

export function prepareLocalToolEffect<TResult>(
  publicResult: TResult,
  apply: () => void,
): PreparedLocalToolEffect<TResult> {
  const effect = Object.freeze({ publicResult }) as PreparedLocalToolEffect<TResult>;
  preparedEffects.set(effect, { apply, consumed: false });
  return effect;
}

export function isPreparedLocalToolEffect(value: unknown): value is PreparedLocalToolEffect {
  return typeof value === 'object' && value !== null && preparedEffects.has(value);
}

export function applyPreparedLocalToolEffect(effect: PreparedLocalToolEffect): void {
  const state = preparedEffects.get(effect);
  if (!state) {
    throw new Error('invalid prepared local tool effect');
  }
  if (state.consumed) {
    throw new Error('prepared local tool effect already consumed');
  }

  state.consumed = true;
  state.apply();
}
