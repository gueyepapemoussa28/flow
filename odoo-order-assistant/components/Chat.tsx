"use client";

/**
 * Écran principal : conversation + état de la commande en cours.
 *
 * L'état est gardé ICI, dans le navigateur (pas de base de données) :
 *  - messages     → ce qui s'affiche ;
 *  - draftRef     → brouillon de commande renvoyé au serveur à chaque message ;
 *  - un preview "pending" = commande en attente de confirmation.
 *
 * Le navigateur n'appelle QUE /api/chat et /api/orders/confirm (jamais Odoo).
 */
import { useRef, useState } from "react";
import { formatMoney } from "@/lib/format";
import type { ChatResponse, ConfirmResponse, Draft } from "@/types/order";
import type { OrderStatus, UiMessage } from "@/types/ui";
import ChatInput from "./ChatInput";
import MessageList from "./MessageList";

type PreviewMessage = Extract<UiMessage, { kind: "preview" }>;
type SelectionMsg = Extract<UiMessage, { kind: "selection" }>;
const isPreview = (m: UiMessage): m is PreviewMessage => m.role === "assistant" && m.kind === "preview";

const WELCOME: UiMessage = {
  id: "welcome",
  role: "assistant",
  kind: "text",
  text: "Écrivez votre commande en langage naturel.\nExemple : « Crée une commande pour ABC SARL avec 10 Coca 33cl et 5 Fanta. »",
};

let idCounter = 0;
const newId = () => `m${++idCounter}`;

const NETWORK_ERROR = "Connexion impossible. Vérifiez votre réseau et réessayez.";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export default function Chat() {
  const [messages, setMessagesState] = useState<UiMessage[]>([WELCOME]);
  const [loading, setLoading] = useState(false);

  // Copies "toujours à jour" pour éviter les valeurs périmées dans les fonctions async.
  const messagesRef = useRef<UiMessage[]>([WELCOME]);
  const draftRef = useRef<Draft | null>(null);
  const busyRef = useRef(false);

  function setMessages(update: (current: UiMessage[]) => UiMessage[]) {
    const next = update(messagesRef.current);
    messagesRef.current = next;
    setMessagesState(next);
  }

  const addUser = (text: string) => setMessages((m) => [...m, { id: newId(), role: "user", text }]);
  const addAssistant = (text: string, tone?: "error" | "success") =>
    setMessages((m) => [...m, { id: newId(), role: "assistant", kind: "text", text, tone }]);

  const findPending = () => messagesRef.current.filter(isPreview).find((m) => m.status === "pending");

  function setPreviewStatus(id: string, status: OrderStatus) {
    setMessages((all) => all.map((m) => (isPreview(m) && m.id === id ? { ...m, status } : m)));
  }

  // ── Réponses du serveur ────────────────────────────────────────────
  async function handleResponse(data: ChatResponse) {
    switch (data.type) {
      case "text":
        addAssistant(data.message);
        break;

      case "error":
        addAssistant(data.message, "error");
        break;

      case "clarification":
        draftRef.current = data.draft;
        addAssistant(data.message);
        break;

      case "selection":
        draftRef.current = data.draft;
        setMessages((m) => [
          ...m,
          {
            id: newId(),
            role: "assistant",
            kind: "selection",
            text: data.message,
            selectionKind: data.kind,
            lineIndex: data.lineIndex,
            candidates: data.candidates,
            draft: data.draft,
            answered: false,
          },
        ]);
        break;

      case "order_preview":
        draftRef.current = data.draft;
        setMessages((all) => [
          // un nouveau preview remplace l'ancien encore en attente
          ...all.map((m) => (isPreview(m) && m.status === "pending" ? { ...m, status: "replaced" as const } : m)),
          { id: newId(), role: "assistant", kind: "preview", order: data.order, status: "pending" },
        ]);
        break;

      case "confirm_requested":
        await confirmPending();
        break;

      case "cancelled":
        cancelPending(data.message);
        break;
    }
  }

  async function callChat(payload: Record<string, unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      const data = await postJson<ChatResponse>("/api/chat", { ...payload, hasPendingOrder: !!findPending() });
      await handleResponse(data);
    } catch {
      addAssistant(NETWORK_ERROR, "error");
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }

  // ── Actions de l'utilisateur ───────────────────────────────────────
  function send(text: string) {
    addUser(text);
    void callChat({ message: text, draft: draftRef.current });
  }

  function pick(message: SelectionMsg, id: number) {
    if (busyRef.current || message.answered) return;
    const label = message.candidates.find((c) => c.id === id)?.label ?? String(id);
    setMessages((all) =>
      all.map((m) => (m.id === message.id && m.role === "assistant" && m.kind === "selection" ? { ...m, answered: true, chosenId: id } : m))
    );
    addUser(`${message.selectionKind === "customer" ? "Client" : "Produit"} : ${label}`);
    void callChat({
      draft: message.draft,
      selection: { kind: message.selectionKind, lineIndex: message.lineIndex, id },
    });
  }

  function cancelPending(message = "D'accord, c'est annulé. Rien n'a été créé dans Odoo.") {
    const pending = findPending();
    if (pending) setPreviewStatus(pending.id, "cancelled");
    draftRef.current = null;
    addAssistant(message);
  }

  async function confirmPending() {
    const pending = findPending();
    if (!pending) return;
    setPreviewStatus(pending.id, "confirming"); // bloque le double clic

    // On n'envoie que des IDs et des quantités : le serveur revalide tout auprès d'Odoo.
    const order = {
      customer: { id: pending.order.customer.id },
      lines: pending.order.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, uomId: l.uomId })),
    };

    try {
      const data = await postJson<ConfirmResponse>("/api/orders/confirm", { order });
      if (data.success) {
        setPreviewStatus(pending.id, "created");
        draftRef.current = null;
        const lines = [
          data.confirmed ? "Commande créée et confirmée avec succès." : "Devis créé avec succès.",
          `Numéro : ${data.odoo_order_name}`,
          `Client : ${data.customer}`,
        ];
        if (data.total !== null) lines.push(`Total : ${formatMoney(data.total, data.currency)}`);
        if (data.warning) lines.push(data.warning);
        addAssistant(lines.join("\n"), "success");
      } else {
        setPreviewStatus(pending.id, "pending");
        addAssistant(`${data.message}\nLa commande n'a pas été créée.`, "error");
      }
    } catch {
      setPreviewStatus(pending.id, "pending");
      addAssistant("Connexion interrompue. La commande n'a peut-être pas été créée : vérifiez dans Odoo avant de réessayer.", "error");
    }
  }

  const confirming = messages.some((m) => isPreview(m) && m.status === "confirming");

  return (
    <main className="mx-auto flex h-dvh max-w-2xl flex-col bg-paper sm:border-x sm:border-rule">
      <header className="border-b border-rule bg-white px-4 pb-3 pt-[calc(0.75rem_+_env(safe-area-inset-top))]">
        <h1 className="text-[17px] font-semibold leading-tight">Assistant commandes</h1>
        <p className="text-sm text-muted">Écrivez la commande, vérifiez, confirmez.</p>
      </header>

      <MessageList messages={messages} loading={loading} onPick={pick} onConfirm={() => void confirmPending()} onCancel={() => cancelPending()} />

      <ChatInput disabled={loading || confirming} onSend={send} />
    </main>
  );
}
