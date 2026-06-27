/**
 * Evaluator Stub
 *
 * 评估器桩实现（Phase J 最小实现）
 */

import type { ActionDecision } from '../types/action';

export interface EvaluatorRequest {
  actionDecision: ActionDecision;
  contextSummary: string;
}

export interface EvaluatorResult {
  approved: boolean;
  reason: string;
  modifiedActions?: ActionDecision['actions'];
}

export class EvaluatorStub {
  /**
   * 评估行动决策（桩实现：总是批准）
   */
  async evaluate(request: EvaluatorRequest): Promise<EvaluatorResult> {
    // Phase J 桩实现：总是批准低风险行动
    const { actionDecision } = request;

    if (actionDecision.riskLevel === 'prohibited') {
      return {
        approved: false,
        reason: 'Risk level prohibited',
      };
    }

    return {
      approved: true,
      reason: 'Stub evaluator: auto-approved',
    };
  }
}
