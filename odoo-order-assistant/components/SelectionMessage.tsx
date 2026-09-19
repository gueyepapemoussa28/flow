"use client";

import type { Candidate } from "@/types/order";

interface Props {
  text: string;
  candidates: Candidate[];
  answered: boolean;
  chosenId?: number;
  onPick: (id: number) => void;
}

/** Liste de choix quand plusieurs clients ou produits correspondent. */
export default function SelectionMessage({ text, candidates, answered, chosenId, onPick }: Props) {
  return (
    <div className="w-full max-w-[92%] rounded-2xl rounded-bl-md border border-rule bg-white p-3">
      <p className="mb-2 text-[15px] leading-snug">{text}</p>
      <ul className="flex flex-col gap-2">
        {candidates.map((c) => {
          const chosen = answered && c.id === chosenId;
          return (
            <li key={c.id}>
              <button
                type="button"
                disabled={answered}
                onClick={() => onPick(c.id)}
                className={
                  "flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-[15px] focus-visible:ring-2 focus-visible:ring-mine/40 " +
                  (chosen
                    ? "border-mine bg-mine/10 font-semibold"
                    : answered
                      ? "border-rule opacity-50"
                      : "border-rule bg-paper active:bg-mine/10")
                }
              >
                <span>{c.label}</span>
                {c.detail && <span className="num shrink-0 text-sm text-muted">{c.detail}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
