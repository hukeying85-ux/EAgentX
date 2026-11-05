/** 结构化澄清提问卡（对标 arena.ai/agent 的交互式提问）。 */

import { useState } from 'react';
import { Check, HelpCircle, Send } from 'lucide-react';
import type { AskUserQuestion } from '../types';

interface Props {
  question: AskUserQuestion;
  answer?: string;
  onAnswer: (value: string) => void;
}

export function AskUserCard({ question, answer, onAnswer }: Props) {
  const [custom, setCustom] = useState('');
  const resolved = Boolean(answer);

  return (
    <div className="animate-rise rounded-xl2 border border-day-accent/30 bg-day-accent/5 p-3.5 dark:border-night-accent/30 dark:bg-night-accent/10">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-day-accent/15 text-day-accent dark:bg-night-accent/20 dark:text-night-accent">
          <HelpCircle size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">{question.question}</p>

          {resolved ? (
            <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-emerald-600 dark:text-emerald-400">
              <Check size={13} /> 你的回答：{answer}
            </p>
          ) : (
            <>
              {question.options.length > 0 && (
                <div className="mt-2.5 grid gap-1.5">
                  {question.options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => onAnswer(option.label)}
                      className="group flex items-start gap-2 rounded-lg border border-day-line bg-white px-3 py-2 text-left transition hover:border-day-accent hover:bg-day-accent/5 dark:border-night-line dark:bg-night-card dark:hover:border-night-accent"
                    >
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-day-line transition group-hover:bg-day-accent dark:bg-night-line" />
                      <span>
                        <span className="block text-[13px] font-medium">{option.label}</span>
                        {option.description && (
                          <span className="mt-0.5 block text-[12px] text-day-muted dark:text-night-muted">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {question.allowCustom && (
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (custom.trim()) onAnswer(custom.trim());
                  }}
                >
                  <input
                    value={custom}
                    onChange={(event) => setCustom(event.target.value)}
                    placeholder={question.options.length > 0 ? '或者直接输入你的答案…' : '输入你的答案…'}
                    className="min-w-0 flex-1 rounded-lg border border-day-line bg-white px-3 py-2 text-[13px] outline-none transition focus:border-day-accent focus:ring-2 focus:ring-day-accent/20 dark:border-night-line dark:bg-night-card dark:focus:border-night-accent dark:focus:ring-night-accent/20"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-day-accent px-3 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-110 active:scale-[0.98] dark:bg-night-accent dark:text-night-bg"
                  >
                    <Send size={13} /> 提交
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
