/**
 * Étape 1 du flux : message texte → intention + brouillon de commande.
 *
 * Pour économiser des appels Gemini, les réponses simples ("oui", "annule")
 * sont reconnues ici, sans IA.
 */
import { callGemini } from "./gemini";
import { sanitizeParsed } from "./validation";
import type { Draft, DraftLine, ParsedMessage } from "@/types/order";

const CONFIRM_RE = /^\s*(oui|ok|okay|d'?accord|confirme[rz]?|valide[rz]?|c'?est bon|go|yes)\s*[.!]*\s*$/i;
const CANCEL_RE = /^\s*(non|annule[rz]?|annulation|stop|laisse tomber)\s*[.!]*\s*$/i;

export async function parseMessage(
  text: string,
  opts: { previousDraft: Draft | null }
): Promise<ParsedMessage> {
  // Raccourcis sans IA
  if (CANCEL_RE.test(text)) return { intent: "cancel_order", customer_query: null, lines: [], clarification: null };
  // "oui" seul = confirmation (handleChat vérifie qu'une commande est bien en attente)
  if (CONFIRM_RE.test(text)) {
    return { intent: "confirm_order", customer_query: null, lines: [], clarification: null };
  }

  // Cas général : UN appel Gemini
  const raw = await callGemini(text, opts.previousDraft);
  return sanitizeParsed(raw);
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Transforme la réponse de Gemini en brouillon.
 * Si l'utilisateur avait déjà choisi un client / un produit dans une liste et que
 * le texte n'a pas changé, on garde ce choix (il n'a pas à le refaire).
 */
export function mergeIntoDraft(parsed: ParsedMessage, previous: Draft | null): Draft {
  const customerQuery = parsed.customer_query ?? previous?.customerQuery ?? null;
  const keepCustomerId = previous && same(customerQuery, previous.customerQuery) ? previous.customerId : undefined;

  let lines: DraftLine[];
  if (parsed.lines.length === 0 && previous) {
    lines = previous.lines;
  } else {
    lines = parsed.lines.map((l, i) => {
      const before = previous?.lines[i];
      return {
        productQuery: l.product_query,
        quantity: l.quantity,
        uomQuery: l.uom_query,
        productId: before && same(before.productQuery, l.product_query) ? before.productId : undefined,
      };
    });
  }

  return { customerQuery, customerId: keepCustomerId, lines };
}
