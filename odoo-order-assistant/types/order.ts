/**
 * Types partagés entre le frontend et le backend.
 *
 * Règle d'or : Gemini ne produit que du TEXTE (…_query). Tous les IDs
 * (client, produit, unité) viennent d'Odoo.
 */

export type Intent = "create_order" | "confirm_order" | "cancel_order" | "unknown";

/** Ce que Gemini renvoie (après nettoyage côté serveur). */
export interface ParsedLine {
  product_query: string;
  quantity: number | null; // null = quantité absente du message
  uom_query: string | null; // "cartons", "packs"… (texte brut)
}

export interface ParsedMessage {
  intent: Intent;
  customer_query: string | null;
  lines: ParsedLine[];
  clarification: string | null; // seulement pour intent = unknown
}

/**
 * Brouillon de commande : conservé côté navigateur et renvoyé au serveur à
 * chaque message. Les IDs qu'il contient (customerId / productId) viennent
 * d'un choix de l'utilisateur dans une liste ; le serveur les revérifie
 * TOUJOURS auprès d'Odoo.
 */
export interface DraftLine {
  productQuery: string;
  quantity: number | null;
  uomQuery: string | null;
  productId?: number;
}
export interface Draft {
  customerQuery: string | null;
  customerId?: number;
  lines: DraftLine[];
}

/** Enregistrements Odoo, simplifiés. */
export interface Customer {
  id: number;
  name: string;
  city: string | null;
}
export interface Product {
  id: number;
  name: string;
  code: string | null;
  listPrice: number | null;
  uomId: number | null;
  uomName: string | null;
}
export interface Uom {
  id: number;
  name: string;
}

/** Une option proposée à l'utilisateur quand il y a plusieurs résultats. */
export interface Candidate {
  id: number;
  label: string;
  detail?: string;
}

/** Commande validée côté serveur (ce que l'utilisateur voit dans le preview). */
export interface OrderLine {
  productId: number;
  productName: string;
  quantity: number;
  uomId: number | null;
  uomName: string | null;
  unitPrice: number | null; // null = prix non connu avant création
  subtotal: number | null;
}
export interface Order {
  customer: { id: number; name: string };
  lines: OrderLine[];
  total: number | null; // null = sera calculé par Odoo
  currency: string;
}

/** Réponses de POST /api/chat */
export type ChatResponse =
  | { type: "text"; message: string }
  | { type: "error"; message: string }
  | { type: "clarification"; message: string; draft: Draft }
  | {
      type: "selection";
      kind: "customer" | "product";
      lineIndex?: number;
      message: string;
      candidates: Candidate[];
      draft: Draft;
    }
  | { type: "order_preview"; order: Order; draft: Draft }
  | { type: "confirm_requested" }
  | { type: "cancelled"; message: string };

/** Ce que le frontend envoie à POST /api/orders/confirm (seuls les IDs comptent). */
export interface OrderRequest {
  customerId: number;
  lines: { productId: number; quantity: number; uomId: number | null }[];
}

/** Réponse de POST /api/orders/confirm */
export type ConfirmResponse =
  | {
      success: true;
      odoo_order_id: number;
      odoo_order_name: string;
      customer: string;
      total: number | null;
      currency: string;
      confirmed: boolean; // true si le devis est passé en bon de commande
      warning?: string;
    }
  | { success: false; message: string };
