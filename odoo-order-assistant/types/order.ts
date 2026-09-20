/**
 * Types partagés entre le frontend et le backend.
 *
 * Règle d'or : Gemini ne produit que du TEXTE (…_query). Tous les IDs
 * (client, produit, conditionnement, unité) viennent d'Odoo.
 */

export type Intent = "create_order" | "confirm_order" | "cancel_order" | "unknown";

/** Ce que Gemini renvoie (après nettoyage côté serveur). */
export interface ParsedLine {
  product_query: string;
  quantity: number | null; // null = quantité absente du message
  uom_query: string | null; // "bacs", "cartons", "kg"… (texte brut)
}

export interface ParsedMessage {
  intent: Intent;
  customer_query: string | null;
  lines: ParsedLine[];
  clarification: string | null; // seulement pour intent = unknown
}

/**
 * Brouillon de commande : conservé côté navigateur et renvoyé au serveur à
 * chaque message. Les IDs qu'il contient viennent d'un choix de l'utilisateur
 * dans une liste ; le serveur les revérifie TOUJOURS auprès d'Odoo.
 */
export interface DraftLine {
  productQuery: string;
  quantity: number | null;
  uomQuery: string | null;
  productId?: number;
  packagingId?: number;
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
  /** Nom nu, utilisé pour l'appariement avec ce qu'a écrit l'utilisateur. */
  name: string;
  /** Ce qu'on montre à l'utilisateur (display_name d'Odoo, variantes incluses). */
  label: string;
  code: string | null;
  listPrice: number | null; // prix pour UNE unité de base (ex : 1 kg)
  uomId: number | null;
  uomName: string | null;
}
export interface Uom {
  id: number;
  name: string;
}
/**
 * Conditionnement Odoo (product.packaging) : « Bac 4 kg » pour un produit vendu au kg.
 * `qty` est la quantité d'unités de base contenue dans UN conditionnement.
 */
export interface Packaging {
  id: number;
  name: string;
  qty: number;
  productId: number;
}

/** Une option proposée à l'utilisateur quand il y a plusieurs résultats. */
export interface Candidate {
  id: number;
  label: string;
  detail?: string;
}

export type SelectionKind = "customer" | "product" | "packaging";

/** Commande validée côté serveur (ce que l'utilisateur voit dans le preview). */
export interface OrderLine {
  productId: number;
  productName: string;
  /** Quantité telle que saisie : en conditionnements s'il y en a un, sinon en unité de base. */
  quantity: number;
  packagingId: number | null;
  packagingName: string | null; // "Bac 4 kg"
  /** Quantité convertie en unité de base du produit (2 bacs de 4 kg → 8). */
  baseQuantity: number;
  uomId: number | null;
  uomName: string | null; // "kg"
  unitPrice: number | null; // prix par unité de base ; null = calculé par Odoo
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
      kind: SelectionKind;
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
  lines: {
    productId: number;
    /** Nombre de conditionnements si packagingId, sinon quantité en unité de base. */
    quantity: number;
    uomId: number | null;
    packagingId: number | null;
  }[];
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
