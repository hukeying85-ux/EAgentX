/** 内联命令审批卡（对标 EAgentX 的 ApproveForm，但嵌在对话流里）。 */

import { AlertTriangle, Check, ShieldCheck, X } from 'lucide-react';
import type { ApprovalRequest } from '../types';

interface Props {
  approval: ApprovalRequest;
  decision?: 'approved' | 'rejected' | 'auto';
  onDecide: (decision: 'approved' | 'rejected') => void;
  onAlwaysAllow: () => void;
}

export function ApprovalCard({ approval, decision, onDecide, onAlwaysAllow }: Props) {
  const resolved = Boolean(decision);

  return (
    <div className="animate-rise rounded-xl2 border border-amber-300/70 bg-amber-50/80 p-3.5 dark:border-amber-500/30 dark:bg-amber-500/10">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-300">
          <AlertTriangle size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-amber-800 dark:text-amber-200">
            需要你确认：<span className="font-mono">{approval.tool}</span>
          </p>
          <p className="mt-0.5 text-[12px] text-amber-700/80 dark:text-amber-200/70">{approval.reason}</p>
          <pre className="scrollbar-thin mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-amber-300/60 bg-white/70 p-2 text-[12px] text-amber-900 dark:border-amber-500/20 dark:bg-black/20 dark:text-amber-100">
            {approval.preview || '（无参数）'}
          </pre>

          {resolved ? (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] font-medium">
              {decision === 'approved' || decision === 'auto' ? (
                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <Check size={13} /> 已允许执行
                </span>
              ) : (
                <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
                  <X size={13} /> 已拒绝，模型会换一种方式
                </span>
              )}
            </p>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onDecide('approved')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-emerald-500 active:scale-[0.98]"
              >
                <Check size={14} /> 允许执行
              </button>
              <button
                type="button"
                onClick={() => onDecide('rejected')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-day-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-day-text transition hover:border-rose-400 hover:text-rose-600 dark:border-night-line dark:bg-night-card dark:text-night-text"
              >
                <X size={14} /> 拒绝
              </button>
              <button
                type="button"
                onClick={onAlwaysAllow}
                className="inline-flex items-center gap-1.5 rounded-lg border border-transparent px-2 py-1.5 text-[12px] text-amber-700/80 transition hover:bg-amber-500/10 dark:text-amber-200/80"
                title="把审批模式切到「全自动」，本会话不再逐条确认"
              >
                <ShieldCheck size={14} /> 本会话自动放行
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
