/**
 * Logique métier (la "colle" entre Gemini, la validation et Odoo).
 *
 * Flux d'un message de commande :
 *   1. parseMessage()      → Gemini comprend le texte (1 appel)
 *   2. resolveDraft()      → le serveur retrouve client / produits / unités dans Odoo
 *                            (aucune IA ici) et pose des questions s'il y a un doute
 *   3. order_preview       → l'utilisateur voit le récapitulatif
 *   4. confirmOrder()      → revalidation complète auprès d'Odoo, PUIS création
 */
import { odooConfig as cfg } from "./odoo-config";
import {
  createSalesOrder,
  getCustomerById,
  getProductById,
  getUomById,
  searchCustomer,
  searchProduct,
  searchUom,
} from "./odoo";
import { AppError } from "./errors";
import { formatMoney } from "./format";
import { mergeIntoDraft, parseMessage } from "./order-parser";
import {
  isRecord,
  isValidQuantity,
  LIMITS,
  sanitizeDraft,
  sanitizeOrderRequest,
  sanitizeSelection,
} from "./validation";
import type {
  ChatResponse,
  ConfirmResponse,
  Customer,
  Draft,
  DraftLine,
  Order,
  Product,
  Uom,
} from "@/types/order";

// ─────────────────────────────────────────────────────────────────────
// Petits outils
// ─────────────────────────────────────────────────────────────────────

/** Résultat d'une étape : soit une valeur, soit une réponse à renvoyer à l'utilisateur. */
type Step<T> = { ok: true; value: T } | { ok: false; response: ChatResponse };
const ok = <T>(value: T): Step<T> => ({ ok: true, value });
const fail = <T>(response: ChatResponse): Step<T> => ({ ok: false, response });

const clarify = (message: string, draft: Draft): ChatResponse => ({ type: "clarification", message, draft });

/** Un seul résultat, ou un seul résultat dont le nom est EXACTEMENT celui demandé. Sinon null. */
function pickOne<T extends { name: string }>(items: T[], query: string): T | null {
  if (items.length === 1) return items[0];
  const q = query.trim().toLowerCase();
  const exact = items.filter((i) => i.name.trim().toLowerCase() === q);
  return exact.length === 1 ? exact[0] : null;
}

/** "Cartons" → "carton" (minuscules, sans "s" final). */
function normalizeUom(text: string): string {
  const t = text.trim().toLowerCase();
  return t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────────────────
// POST /api/chat
// ─────────────────────────────────────────────────────────────────────

export async function handleChat(body: unknown): Promise<ChatResponse> {
  const input = isRecord(body) ? body : {};
  const draft = sanitizeDraft(input.draft);

  // Cas A : l'utilisateur a cliqué sur un choix dans une liste (client ou produit)
  const selection = sanitizeSelection(input.selection);
  if (selection) {
    if (!draft) return { type: "error", message: "La conversation a expiré. Recommencez votre commande." };
    if (selection.kind === "customer") {
      draft.customerId = selection.id;
    } else {
      const line = selection.lineIndex !== undefined ? draft.lines[selection.lineIndex] : undefined;
      if (!line) return { type: "error", message: "Ce choix ne correspond à aucune ligne de la commande." };
      line.productId = selection.id;
    }
    return resolveDraft(draft); // l'ID choisi sera revérifié auprès d'Odoo
  }

  // Cas B : message texte
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) return { type: "error", message: "Écrivez d'abord votre commande." };
  if (message.length > LIMITS.maxMessageLength) {
    return { type: "error", message: "Votre message est trop long. Résumez-le en quelques lignes." };
  }

  const parsed = await parseMessage(message, { previousDraft: draft });

  switch (parsed.intent) {
    case "cancel_order":
      return { type: "cancelled", message: "D'accord, c'est annulé. Rien n'a été créé dans Odoo." };

    case "confirm_order":
      return input.hasPendingOrder === true
        ? { type: "confirm_requested" }
        : { type: "text", message: "Il n'y a aucune commande en attente de confirmation." };

    case "create_order":
      return resolveDraft(mergeIntoDraft(parsed, draft));

    default:
      return {
        type: "text",
        message:
          parsed.clarification ??
          "Je n'ai pas compris votre demande. Exemple : « Crée une commande pour ABC SARL avec 10 cartons de Coca 33cl et 5 cartons de Fanta »",
      };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Résolution du brouillon : texte → vrais enregistrements Odoo
// ─────────────────────────────────────────────────────────────────────

export async function resolveDraft(input: Draft): Promise<ChatResponse> {
  // On travaille sur une copie. `draft` est passé par référence aux étapes ci-dessous :
  // les réponses qui le contiennent affichent donc l'état final.
  const draft: Draft = { ...input, lines: input.lines.map((l) => ({ ...l })) };

  // 1. Contrôles sans Odoo (rapides, gratuits)
  if (!draft.customerQuery) return clarify("Pour quel client dois-je préparer la commande ?", draft);
  if (draft.lines.length === 0) return clarify("Quels produits et quelles quantités souhaitez-vous commander ?", draft);

  for (const line of draft.lines) {
    if (line.quantity === null) {
      return clarify(`Quelle quantité souhaitez-vous pour « ${line.productQuery} » ?`, draft);
    }
    if (!isValidQuantity(line.quantity)) {
      line.quantity = null;
      return clarify(
        `La quantité pour « ${line.productQuery} » doit être un nombre supérieur à zéro. Quelle quantité voulez-vous ?`,
        draft
      );
    }
  }

  // 2. Client
  const customerStep = await resolveCustomer(draft);
  if (!customerStep.ok) return customerStep.response;
  const customer = customerStep.value;
  draft.customerId = customer.id;

  // 3. Produits (en parallèle)
  const productSteps = await Promise.all(draft.lines.map((line, i) => resolveProduct(line, i, draft)));
  productSteps.forEach((step, i) => {
    if (step.ok) draft.lines[i].productId = step.value.id; // on garde les choix déjà faits
  });
  const products: Product[] = [];
  for (const step of productSteps) {
    if (!step.ok) return step.response;
    products.push(step.value);
  }

  // 4. Unités de mesure
  const uomSteps = await Promise.all(draft.lines.map((line, i) => resolveUom(line, products[i], draft)));
  const uoms: (Uom | null)[] = [];
  for (const step of uomSteps) {
    if (!step.ok) return step.response;
    uoms.push(step.value);
  }

  // 5. Commande interne (prix et total calculés par le serveur)
  const order = buildOrder(
    customer,
    draft.lines.map((line, i) => ({
      product: products[i],
      quantity: line.quantity as number, // vérifié à l'étape 1
      uom: uoms[i],
    }))
  );

  return { type: "order_preview", order, draft };
}

async function resolveCustomer(draft: Draft): Promise<Step<Customer>> {
  // Choix déjà fait par l'utilisateur → on vérifie qu'il existe toujours dans Odoo
  if (draft.customerId) {
    const known = await getCustomerById(draft.customerId);
    if (known) return ok(known);
    draft.customerId = undefined;
  }

  const query = draft.customerQuery as string;
  const found = await searchCustomer(query);

  if (found.length === 0) {
    return fail(clarify(`Je n'ai trouvé aucun client correspondant à « ${query} ». Vérifiez le nom ou écrivez-le autrement.`, draft));
  }
  const one = pickOne(found, query);
  if (one) return ok(one);

  return fail({
    type: "selection",
    kind: "customer",
    message: `J'ai trouvé plusieurs clients correspondant à « ${query} ». Veuillez sélectionner le client.`,
    candidates: found.map((c) => ({ id: c.id, label: c.name, detail: c.city ?? undefined })),
    draft,
  });
}

async function resolveProduct(line: DraftLine, index: number, draft: Draft): Promise<Step<Product>> {
  if (line.productId) {
    const known = await getProductById(line.productId);
    if (known) return ok(known);
    line.productId = undefined;
  }

  const found = await searchProduct(line.productQuery);

  if (found.length === 0) {
    return fail(clarify(`Je n'ai trouvé aucun produit correspondant à « ${line.productQuery} ». Écrivez le nom du produit autrement.`, draft));
  }
  const one = pickOne(found, line.productQuery);
  if (one) return ok(one);

  return fail({
    type: "selection",
    kind: "product",
    lineIndex: index,
    message: `J'ai trouvé plusieurs produits correspondant à « ${line.productQuery} ». Veuillez sélectionner le produit.`,
    candidates: found.map((p) => ({
      id: p.id,
      label: p.name,
      detail: p.listPrice != null ? formatMoney(p.listPrice, cfg.displayCurrency) : undefined,
    })),
    draft,
  });
}

async function resolveUom(line: DraftLine, product: Product, draft: Draft): Promise<Step<Uom | null>> {
  // Pas d'unité dans le message → unité par défaut du produit
  if (!line.uomQuery) {
    return ok(product.uomId != null ? { id: product.uomId, name: product.uomName ?? "" } : null);
  }

  const word = normalizeUom(line.uomQuery);
  const term = cfg.uom.aliases[word] ?? word; // alias configurable dans odoo-config.ts
  const found = await searchUom(term);

  if (found.length === 0) {
    return fail(
      clarify(
        `Je n'ai pas trouvé l'unité « ${line.uomQuery} » dans Odoo (produit : ${product.name}). Précisez l'unité, par exemple « ${product.uomName ?? "Unité"} ».`,
        draft
      )
    );
  }
  const one = pickOne(
    found.map((u) => ({ ...u, name: normalizeUom(u.name) })),
    normalizeUom(term)
  );
  if (one) return ok(found.find((u) => u.id === one.id) ?? null);

  return fail(
    clarify(
      `Plusieurs unités correspondent à « ${line.uomQuery} » : ${found.map((u) => u.name).join(", ")}. Précisez laquelle.`,
      draft
    )
  );
}

/** Construit la commande interne. Aucun prix n'est inventé : null = "calculé par Odoo". */
function buildOrder(customer: Customer, items: { product: Product; quantity: number; uom: Uom | null }[]): Order {
  const lines = items.map(({ product, quantity, uom }) => {
    const unitPrice = cfg.getPreviewUnitPrice(product, uom?.id ?? null);
    return {
      productId: product.id,
      productName: product.name,
      quantity,
      uomId: uom?.id ?? null,
      uomName: uom?.name ?? null,
      unitPrice,
      subtotal: unitPrice == null ? null : round2(unitPrice * quantity),
    };
  });

  const allPriced = lines.every((l) => l.subtotal !== null);
  return {
    customer: { id: customer.id, name: customer.name },
    lines,
    total: allPriced ? round2(lines.reduce((sum, l) => sum + (l.subtotal ?? 0), 0)) : null,
    currency: cfg.displayCurrency,
  };
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/orders/confirm
// ─────────────────────────────────────────────────────────────────────

/**
 * Revalide TOUT auprès d'Odoo (client, produits, unités existent toujours),
 * puis crée le Sales Order. Le navigateur ne fournit que des IDs et des quantités.
 */
export async function confirmOrder(body: unknown): Promise<ConfirmResponse> {
  const request = sanitizeOrderRequest(body);
  const gone = new AppError("Un élément de la commande n'existe plus dans Odoo. Refaites la commande.", "order_stale");

  const customer = await getCustomerById(request.customerId);
  if (!customer) throw gone;

  const items = await Promise.all(
    request.lines.map(async (line) => {
      const product = await getProductById(line.productId);
      if (!product) throw gone;
      const uom = line.uomId ? await getUomById(line.uomId) : null;
      if (line.uomId && !uom) throw gone;
      return { product, quantity: line.quantity, uom };
    })
  );
  buildOrder(customer, items); // même construction que le preview (cohérence)

  // ↓ Seul endroit du projet où l'on écrit dans Odoo.
  const created = await createSalesOrder(request);

  return {
    success: true,
    odoo_order_id: created.id,
    odoo_order_name: created.name,
    customer: customer.name,
    total: created.total,
    currency: cfg.displayCurrency,
    confirmed: created.confirmed,
    warning: created.warning,
  };
}
