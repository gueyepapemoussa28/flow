"use client";

import { useState, type KeyboardEvent } from "react";

interface Props {
  disabled: boolean; // vrai pendant un chargement
  onSend: (text: string) => void;
}

/** Champ de saisie + bouton Envoyer. Entrée envoie, Maj+Entrée = retour à la ligne. */
export default function ChatInput({ disabled, onSend }: Props) {
  const [value, setValue] = useState("");

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="border-t border-rule bg-white px-3 pt-2 pb-[calc(0.5rem_+_env(safe-area-inset-bottom))]">
      <div className="flex items-end gap-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Ex : commande ABC SARL, 10 Coca 33cl…"
          aria-label="Votre commande"
          className="max-h-32 min-h-11 flex-1 resize-none rounded-lg border border-rule bg-paper px-3 py-2.5 text-base leading-snug outline-none focus:border-mine focus-visible:ring-2 focus-visible:ring-mine/30"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || value.trim() === ""}
          className="h-11 rounded-lg bg-mine px-4 text-base font-semibold text-white disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-mine/40 focus-visible:ring-offset-2"
        >
          Envoyer
        </button>
      </div>
    </div>
  );
}
