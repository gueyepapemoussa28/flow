/**
 * TOUTES les interactions avec Odoo sont ici (API externe JSON-2 d'Odoo 19).
 *
 * Format d'un appel JSON-2 :
 *   POST {ODOO_URL}/json/2/{modèle}/{méthode}
 *   Authorization: bearer {clé API}
 *   Corps JSON = arguments nommés de la méthode, ex :
 *     res.partner / search_read  → { "domain": [...], "fields": [...], "limit": 8 }
 *     sale.order  / create       → { "vals_list": [ {...} ] }
 *     sale.order  / action_confirm → { "ids": [12] }
 *
 * Ce fichier ne s'exécute que côté serveur (la clé API n'atteint jamais le navigateur).
 */
import { AppError } from "./errors";
import { odooConfig as cfg } from "./odoo-config";
import type { Customer, OrderRequest, Product, Uom } from "@/types/order";

const TIMEOUT_MS = 15_000;

type Row = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────
// Appel bas niveau
// ─────────────────────────────────────────────────────────────────────

function getCredentials() {
  const url = process.env.ODOO_URL?.trim().replace(/\/+$/, "");
  const key = process.env.ODOO_API_KEY?.trim();
  if (!url || !key) {
    console.error("[odoo] ODOO_URL ou ODOO_API_KEY manquant");
    throw new AppError("La connexion à Odoo n'est pas configurée.", "odoo_config", 500);
  }
  return { url, key, db: process.env.ODOO_DB?.trim() || undefined };
}

async function odooCall<T>(model: string, method: string, params: Record<string, unknown>): Promise<T> {
  const { url, key, db } = getCredentials();

  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    Authorization: `bearer ${key}`,
  };
  if (db) headers["X-Odoo-Database"] = db;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${url}/json/2/${model}/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (e) {
    // On ne journalise jamais l'en-tête Authorization.
    console.error(`[odoo] ${model}.${method} injoignable :`, e instanceof Error ? e.name : "erreur");
    throw new AppError("Odoo ne répond pas pour le moment. Réessayez dans un instant.", "odoo_unreachable", 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Row | null;
    // Journal serveur (Vercel Logs) pour le diagnostic ; jamais renvoyé au navigateur.
    console.error(`[odoo] ${model}.${method} → HTTP ${res.status}`, body?.name ?? "", body?.message ?? "");

    if (res.status === 401) throw new AppError("La clé API Odoo est invalide ou expirée.", "odoo_auth", 502);
    if (res.status === 403) throw new AppError("Le compte Odoo n'a pas les droits nécessaires pour cette opération.", "odoo_forbidden", 502);
    if (res.status === 404) throw new AppError("L'API JSON-2 d'Odoo est introuvable (vérifiez ODOO_URL) ou le modèle n'existe pas.", "odoo_not_found", 502);
    throw new AppError("Odoo a refusé l'opération.", "odoo_error", 502);
  }

  return (await res.json()) as T;
}

// ─────────────────────────────────────────────────────────────────────
// Petits utilitaires
// ─────────────────────────────────────────────────────────────────────

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asString = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Odoo renvoie un many2one sous la forme [id, "nom"]. Vaut `false` quand vide. */
function m2o(v: unknown): { id: number; name: string | null } | null {
  if (Array.isArray(v) && typeof v[0] === "number") return { id: v[0], name: asString(v[1]) };
  if (typeof v === "number") return { id: v, name: null };
  return null;
}

/**
 * Construit un domaine Odoo : chaque MOT du texte doit se trouver dans l'un des champs.
 * "Coca 33cl" → trouve "Coca-Cola 33cl" (mots "Coca" ET "33cl").
 */
export function buildNameDomain(fields: string[], query: string): unknown[] {
  const words = query.split(/[\s,;]+/).filter(Boolean);
  if (words.length === 0) throw new AppError("La recherche est vide.", "empty_query");

  const domain: unknown[] = [];
  for (const word of words) {
    // Pour N champs : N-1 opérateurs "|" (OU) puis les N conditions.
    for (let i = 1; i < fields.length; i++) domain.push("|");
    for (const field of fields) domain.push([field, "ilike", word]);
  }
  return domain;
}

async function searchRead(
  model: string,
  domain: unknown[],
  fields: string[],
  limit: number,
  order?: string
): Promise<Row[]> {
  const params: Record<string, unknown> = { domain, fields, limit };
  if (order) params.order = order;
  const rows = await odooCall<unknown>(model, "search_read", params);
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

// ─────────────────────────────────────────────────────────────────────
// Transformation des enregistrements Odoo
// ─────────────────────────────────────────────────────────────────────

function toCustomer(row: Row): Customer {
  const id = asNumber(row.id) ?? 0;
  return { id, name: asString(row.name) ?? `Client #${id}`, city: asString(row.city) };
}

function toProduct(row: Row): Product {
  const id = asNumber(row.id) ?? 0;
  const uom = m2o(row.uom_id);
  return {
    id,
    name: asString(row.display_name) ?? asString(row.name) ?? `Produit #${id}`,
    code: asString(row.default_code),
    listPrice: asNumber(row.lst_price),
    uomId: uom?.id ?? null,
    uomName: uom?.name ?? null,
  };
}

function toUom(row: Row): Uom {
  const id = asNumber(row.id) ?? 0;
  return { id, name: asString(row.name) ?? `Unité #${id}` };
}

// ─────────────────────────────────────────────────────────────────────
// Recherches
// ─────────────────────────────────────────────────────────────────────

export async function searchCustomer(query: string): Promise<Customer[]> {
  const c = cfg.customer;
  const domain = [...c.extraDomain, ...buildNameDomain(c.searchFields, query)];
  const rows = await searchRead(c.model, domain, c.fields, cfg.searchLimit, "name asc");
  return rows.map(toCustomer);
}

export async function getCustomerById(id: number): Promise<Customer | null> {
  const c = cfg.customer;
  const rows = await searchRead(c.model, [["id", "=", id], ...c.extraDomain], c.fields, 1);
  return rows.length ? toCustomer(rows[0]) : null;
}

export async function searchProduct(query: string): Promise<Product[]> {
  const p = cfg.product;
  const domain = [...p.extraDomain, ...buildNameDomain(p.searchFields, query)];
  const rows = await searchRead(p.model, domain, p.fields, cfg.searchLimit, "display_name asc");
  return rows.map(toProduct);
}

export async function getProductById(id: number): Promise<Product | null> {
  const p = cfg.product;
  const rows = await searchRead(p.model, [["id", "=", id], ...p.extraDomain], p.fields, 1);
  return rows.length ? toProduct(rows[0]) : null;
}

export async function searchUom(query: string): Promise<Uom[]> {
  const u = cfg.uom;
  const rows = await searchRead(u.model, buildNameDomain(u.searchFields, query), u.fields, cfg.searchLimit, "name asc");
  return rows.map(toUom);
}

export async function getUomById(id: number): Promise<Uom | null> {
  const u = cfg.uom;
  const rows = await searchRead(u.model, [["id", "=", id]], u.fields, 1);
  return rows.length ? toUom(rows[0]) : null;
}

// ─────────────────────────────────────────────────────────────────────
// Création du Sales Order
// ─────────────────────────────────────────────────────────────────────

export interface CreatedOrder {
  id: number;
  name: string;
  total: number | null;
  state: string | null;
  confirmed: boolean;
  warning?: string;
}

/**
 * Crée le devis dans Odoo (et le confirme si ORDER_CREATION_MODE=create_and_confirm).
 * À n'appeler qu'APRÈS confirmation explicite de l'utilisateur.
 * `orderData` doit déjà avoir été revalidé auprès d'Odoo (voir order-service.ts).
 */
export async function createSalesOrder(orderData: OrderRequest): Promise<CreatedOrder> {
  const so = cfg.salesOrder;
  const values = so.buildOrderValues(orderData.customerId, orderData.lines);

  const created = await odooCall<unknown>(so.model, "create", { vals_list: [values] });
  const id = Array.isArray(created) ? asNumber(created[0]) : asNumber(created);
  if (id == null) {
    console.error("[odoo] réponse de création inattendue");
    throw new AppError("Odoo n'a pas confirmé la création de la commande. Vérifiez dans Odoo avant de réessayer.", "odoo_create", 502);
  }

  // Étape optionnelle : passer le devis en bon de commande.
  let warning: string | undefined;
  let confirmed = false;
  if (cfg.creationMode === "create_and_confirm") {
    try {
      await odooCall<unknown>(so.model, "action_confirm", { ids: [id] });
      confirmed = true;
    } catch (e) {
      console.error("[odoo] action_confirm a échoué", e instanceof AppError ? e.code : "");
      warning = "Le devis a été créé mais n'a pas pu être confirmé automatiquement. Confirmez-le dans Odoo.";
    }
  }

  // Relire le numéro et le total calculés par Odoo.
  const rows = await odooCall<unknown>(so.model, "read", { ids: [id], fields: so.readFields });
  const row = Array.isArray(rows) && rows[0] && typeof rows[0] === "object" ? (rows[0] as Row) : {};

  return {
    id,
    name: asString(row.name) ?? `#${id}`,
    total: asNumber(row.amount_total),
    state: asString(row.state),
    confirmed,
    warning,
  };
}
