/**
 * Validation de TOUT ce qui entre dans le serveur :
 *  - la réponse de Gemini ;
 *  - ce que le navigateur envoie (brouillon, sélection, commande à confirmer).
 * On ne recopie que les champs connus et on vérifie leur type.
 */
import { AppError } from "./errors";
import type { Draft, DraftLine, Intent, OrderRequest, ParsedLine, ParsedMessage, SelectionKind } from "@/types/order";

export const LIMITS = {
  maxMessageLength: 1000,
  maxLines: 30,
  maxQuantity: 100000,
  maxTextLength: 200,
};

const INTENTS: Intent[] = ["create_order", "confirm_order", "cancel_order", "unknown"];

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Un ID Odoo valide = entier strictement positif. */
export function isId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export function cleanText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ").slice(0, LIMITS.maxTextLength);
  return t.length > 0 ? t : null;
}

/** Une quantité non numérique devient null (= "quantité manquante"). */
export function cleanQuantity(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Quantité acceptable ? (> 0 et pas absurde) */
export function isValidQuantity(q: number): boolean {
  return q > 0 && q <= LIMITS.maxQuantity;
}

/** Nettoie la réponse brute de Gemini. Les champs inconnus (ex: un product_id inventé) sont ignorés. */
export function sanitizeParsed(raw: unknown): ParsedMessage {
  const obj = isRecord(raw) ? raw : {};
  const intent = INTENTS.includes(obj.intent as Intent) ? (obj.intent as Intent) : "unknown";

  const lines: ParsedLine[] = [];
  if (Array.isArray(obj.lines)) {
    for (const l of obj.lines.slice(0, LIMITS.maxLines)) {
      if (!isRecord(l)) continue;
      const product_query = cleanText(l.product_query);
      if (!product_query) continue;
      lines.push({
        product_query,
        quantity: cleanQuantity(l.quantity),
        uom_query: cleanText(l.uom_query),
      });
    }
  }

  return {
    intent,
    customer_query: cleanText(obj.customer_query),
    lines,
    clarification: cleanText(obj.clarification),
  };
}

/** Nettoie le brouillon renvoyé par le navigateur. */
export function sanitizeDraft(raw: unknown): Draft | null {
  if (!isRecord(raw)) return null;
  const lines: DraftLine[] = [];
  if (Array.isArray(raw.lines)) {
    for (const l of raw.lines.slice(0, LIMITS.maxLines)) {
      if (!isRecord(l)) continue;
      const productQuery = cleanText(l.productQuery);
      if (!productQuery) continue;
      lines.push({
        productQuery,
        quantity: cleanQuantity(l.quantity),
        uomQuery: cleanText(l.uomQuery),
        productId: isId(l.productId) ? l.productId : undefined,
        packagingId: isId(l.packagingId) ? l.packagingId : undefined,
      });
    }
  }
  return {
    customerQuery: cleanText(raw.customerQuery),
    customerId: isId(raw.customerId) ? raw.customerId : undefined,
    lines,
  };
}

export interface Selection {
  kind: SelectionKind;
  id: number;
  lineIndex?: number;
}

const SELECTION_KINDS: SelectionKind[] = ["customer", "product", "packaging"];

export function sanitizeSelection(raw: unknown): Selection | null {
  if (!isRecord(raw)) return null;
  if (!SELECTION_KINDS.includes(raw.kind as SelectionKind)) return null;
  if (!isId(raw.id)) return null;
  const lineIndex = typeof raw.lineIndex === "number" && Number.isInteger(raw.lineIndex) ? raw.lineIndex : undefined;
  return { kind: raw.kind as SelectionKind, id: raw.id, lineIndex };
}

/**
 * Commande envoyée pour confirmation. On ne garde QUE les IDs et les quantités :
 * noms et prix envoyés par le navigateur sont ignorés (recalculés depuis Odoo).
 *
 * `quantity` est le nombre de CONDITIONNEMENTS quand packagingId est fourni
 * (2 bacs), sinon une quantité dans l'unité de base. La conversion en unité de
 * base est refaite côté serveur depuis la fiche Odoo du conditionnement.
 */
export function sanitizeOrderRequest(raw: unknown): OrderRequest {
  const invalid = new AppError("La commande est invalide. Recommencez votre demande.", "invalid_order");
  const order = isRecord(raw) && isRecord(raw.order) ? raw.order : null;
  if (!order) throw invalid;

  const customer = isRecord(order.customer) ? order.customer : null;
  if (!customer || !isId(customer.id)) throw invalid;

  if (!Array.isArray(order.lines) || order.lines.length === 0 || order.lines.length > LIMITS.maxLines) throw invalid;

  const lines = order.lines.map((l) => {
    if (!isRecord(l) || !isId(l.productId)) throw invalid;
    if (typeof l.quantity !== "number" || !Number.isFinite(l.quantity) || !isValidQuantity(l.quantity)) {
      throw new AppError("Une quantité est invalide (elle doit être supérieure à zéro).", "invalid_quantity");
    }
    return {
      productId: l.productId,
      quantity: l.quantity,
      uomId: isId(l.uomId) ? l.uomId : null,
      packagingId: isId(l.packagingId) ? l.packagingId : null,
    };
  });

  return { customerId: customer.id, lines };
}
