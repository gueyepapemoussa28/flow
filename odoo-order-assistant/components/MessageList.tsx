"use client";

import { useEffect, useRef } from "react";
import type { UiMessage } from "@/types/ui";
import OrderPreview from "./OrderPreview";
import SelectionMessage from "./SelectionMessage";

interface Props {
  messages: UiMessage[];
  loading: boolean;
  onPick: (message: Extract<UiMessage, { kind: "selection" }>, id: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Historique de la conversation. */
export default function MessageList({ messages, loading, onPick, onConfirm, onCancel }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, loading]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4">
      <div className="flex flex-col gap-3">
        {messages.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-md bg-mine px-4 py-2.5 text-[15px] leading-snug text-white">
                  {m.text}
                </p>
              </div>
            );
          }

          if (m.kind === "selection") {
            return (
              <SelectionMessage
                key={m.id}
                text={m.text}
                candidates={m.candidates}
                answered={m.answered}
                chosenId={m.chosenId}
                onPick={(id) => onPick(m, id)}
              />
            );
          }

          if (m.kind === "preview") {
            return <OrderPreview key={m.id} order={m.order} status={m.status} onConfirm={onConfirm} onCancel={onCancel} />;
          }

          const tone =
            m.tone === "error"
              ? "border-alert/40 border-l-4 border-l-alert"
              : m.tone === "success"
                ? "border-go/40 border-l-4 border-l-go"
                : "border-rule";
          return (
            <div key={m.id} className="flex">
              <p className={"max-w-[92%] whitespace-pre-line rounded-2xl rounded-bl-md border bg-white px-4 py-2.5 text-[15px] leading-snug " + tone}>
                {m.text}
              </p>
            </div>
          );
        })}

        {loading && (
          <div className="flex" role="status" aria-label="Analyse en cours">
            <p className="animate-pulse rounded-2xl rounded-bl-md border border-rule bg-white px-4 py-2.5 text-[15px] text-muted">
              Je prépare votre commande…
            </p>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
