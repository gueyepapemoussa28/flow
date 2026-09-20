/**
 * Logique métier (la "colle" entre Gemini, la validation et Odoo).
 *
 * Flux d'un message de commande :
 *   1. parseMessage()      → Gemini comprend le texte (1 appel)
 *   2. resolveDraft()      → le serveur retrouve client / produits / conditionnements
 *                            dans Odoo (aucune IA ici) et pose des questions s'il y a un doute
 *   3. order_preview       → l'utilisateur voit le récapitulatif
 *   4. confirmOrder()      → revalidation complète auprès d'Odoo, PUIS création
 *
 * Coût Odoo : les lectures par ID sont groupées. Une commande de N lignes déjà
 * résolue coûte 3 appels (client + produits + conditionnements), pas 2N+1.
 */
import { odooConfig as cfg, type NewOrderLine } from "./odoo-config";
import {
  createSalesOrder,
  getCustomerById,
  getPackagingsByIds,
  getPackagingsForProducts,
  getProductsByIds,
  getUomsByIds,
  searchCustomer,
  searchProduct,
  searchUom,
} from "./odoo";
import { AppError } from "./errors";
import { formatMoney, formatQty } from "./format";
import { mergeIntoDraft, parseMessage } from "./order-parser";
import { matchesAllWords, singular } from "./text";
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
  Packaging,
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
  return singular(text.trim().toLowerCase());
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundQty = (n: number) => Math.round(n * 1000) / 1000;

/** Unité de base du produit ("kg"), telle que stockée dans Odoo. */
const baseUomOf = (product: Product): Uom | null =>
  product.uomId != null ? { id: product.uomId, name: product.uomName ?? "" } : null;

/** Ce qui part réellement dans Odoo pour une ligne résolue. */
interface ResolvedLine {
  product: Product;
  /** Quantité telle que saisie : nombre de conditionnements, ou quantité de base. */
  quantity: number;
  packaging: Packaging | null;
  uom: Uom | null;
}

const baseQuantityOf = (line: ResolvedLine): number =>
  roundQty(line.packaging ? line.quantity * line.packaging.qty : line.quantity);

// ─────────────────────────────────────────────────────────────────────
// POST /api/chat
// ─────────────────────────────────────────────────────────────────────

export async function handleChat(body: unknown): Promise<ChatResponse> {
  const input = isRecord(body) ? body : {};
  const draft = sanitizeDraft(input.draft);

  // Cas A : l'utilisateur a cliqué sur un choix dans une liste
  const selection = sanitizeSelection(input.selection);
  if (selection) {
    if (!draft) return { type: "error", message: "La conversation a expiré. Recommencez votre commande." };
    if (selection.kind === "customer") {
      draft.customerId = selection.id;
    } else {
      const line = selection.lineIndex !== undefined ? draft.lines[selection.lineIndex] : undefined;
      if (!line) return { type: "error", message: "Ce choix ne correspond à aucune ligne de la commande." };
      if (selection.kind === "product") {
        line.productId = selection.id;
        line.packagingId = undefined; // changer de produit invalide le conditionnement choisi
      } else {
        line.packagingId = selection.id;
      }
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
          "Je n'ai pas compris votre demande. Exemple : « Crée une commande pour ABC SARL avec 2 bacs de vanille et 1 de chocolat »",
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

  // 3. Produits — un seul appel groupé pour tous les choix déjà faits,
  //    puis une recherche par ligne encore non résolue.
  const productsStep = await resolveProducts(draft);
  if (!productsStep.ok) return productsStep.response;
  const products = productsStep.value;

  // 4. Conditionnements — UN appel pour toutes les lignes.
  const packagings = await getPackagingsForProducts(products.map((p) => p.id));

  // 5. Conditionnement / unité de chaque ligne (aucun appel, sauf repli uom.uom)
  const resolved: ResolvedLine[] = [];
  for (let i = 0; i < draft.lines.length; i++) {
    const line = draft.lines[i];
    const product = products[i];
    const step = await resolveUnit(line, i, product, packagings.get(product.id) ?? [], draft);
    if (!step.ok) return step.response;
    resolved.push({ product, quantity: line.quantity as number, ...step.value });
  }

  return { type: "order_preview", order: buildOrder(customer, resolved), draft };
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

/**
 * Résout toutes les lignes. Les produits déjà choisis sont vérifiés en UN appel groupé ;
 * seules les lignes encore inconnues déclenchent une recherche (une par ligne, en série).
 */
async function resolveProducts(draft: Draft): Promise<Step<Product[]>> {
  const known = await getProductsByIds(draft.lines.flatMap((l) => (l.productId ? [l.productId] : [])));

  const products: (Product | null)[] = draft.lines.map((line) => {
    if (!line.productId) return null;
    const found = known.get(line.productId);
    if (found) return found;
    line.productId = undefined; // supprimé d'Odoo entre-temps → on recherche à nouveau
    return null;
  });

  // Les lignes non résolues sont cherchées une par une (requêtes textuelles distinctes),
  // en série pour ne pas envoyer de rafale à Odoo.
  let firstFailure: ChatResponse | null = null;
  for (let i = 0; i < draft.lines.length; i++) {
    if (products[i]) continue;
    const step = await searchProductForLine(draft.lines[i], i, draft);
    if (step.ok) {
      products[i] = step.value;
      draft.lines[i].productId = step.value.id; // on garde les choix déjà faits
    } else if (!firstFailure) {
      firstFailure = step.response;
    }
  }
  // On renvoie la première question seulement APRÈS avoir tenté toutes les lignes :
  // les produits trouvés entre-temps sont mémorisés dans le brouillon.
  if (firstFailure) return fail(firstFailure);

  return ok(products as Product[]);
}

async function searchProductForLine(line: DraftLine, index: number, draft: Draft): Promise<Step<Product>> {
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
      label: p.label,
      detail: p.listPrice != null ? `${formatMoney(p.listPrice, cfg.displayCurrency)} / ${p.uomName ?? "unité"}` : undefined,
    })),
    draft,
  });
}

/**
 * Détermine sous quelle forme la quantité est exprimée.
 *
 * Règle : dès qu'un produit a des conditionnements, la quantité saisie les désigne
 * (« 2 vanilles » = 2 bacs, pas 2 kg). S'il y en a plusieurs, on demande lequel.
 * L'utilisateur peut toujours forcer l'unité de base en l'écrivant (« 10 kg de vanille »).
 */
async function resolveUnit(
  line: DraftLine,
  index: number,
  product: Product,
  packagings: Packaging[],
  draft: Draft
): Promise<Step<{ packaging: Packaging | null; uom: Uom | null }>> {
  const baseUom = baseUomOf(product);

  // Conditionnement déjà choisi → on vérifie qu'il appartient toujours à ce produit
  if (line.packagingId) {
    const chosen = packagings.find((p) => p.id === line.packagingId);
    if (chosen) return ok({ packaging: chosen, uom: baseUom });
    line.packagingId = undefined;
  }

  const askWhichPackaging = (options: Packaging[]): Step<never> =>
    fail({
      type: "selection",
      kind: "packaging",
      lineIndex: index,
      message: `Sous quel conditionnement pour « ${product.label} » ?`,
      candidates: options.map((p) => ({
        id: p.id,
        label: p.name,
        detail: `${formatQty(p.qty)} ${product.uomName ?? ""}`.trim(),
      })),
      draft,
    });

  // Aucune unité écrite par l'utilisateur
  if (!line.uomQuery) {
    if (packagings.length === 0) return ok({ packaging: null, uom: baseUom });
    if (packagings.length === 1) return ok({ packaging: packagings[0], uom: baseUom });
    return askWhichPackaging(packagings);
  }

  // L'utilisateur a écrit l'unité de base (« 10 kg ») → pas de conditionnement
  if (baseUom && baseUom.name && matchesAllWords(baseUom.name, line.uomQuery)) {
    return ok({ packaging: null, uom: baseUom });
  }

  // L'utilisateur a écrit un conditionnement (« bacs », « bac 4kg »)
  if (packagings.length > 0) {
    const hits = packagings.filter((p) => matchesAllWords(p.name, line.uomQuery as string));
    if (hits.length === 1) return ok({ packaging: hits[0], uom: baseUom });
    // Rien ou trop de correspondances : on montre la liste plutôt que de deviner.
    return askWhichPackaging(hits.length > 1 ? hits : packagings);
  }

  // Pas de conditionnement sur ce produit → ancienne logique uom.uom (1 appel)
  return resolveUomByName(line, product, draft);
}

/** Produit sans conditionnement : on cherche l'unité dans uom.uom, comme avant. */
async function resolveUomByName(
  line: DraftLine,
  product: Product,
  draft: Draft
): Promise<Step<{ packaging: null; uom: Uom | null }>> {
  const word = normalizeUom(line.uomQuery as string);
  const term = cfg.uom.aliases[word] ?? word; // alias configurable dans odoo-config.ts
  const found = await searchUom(term);

  if (found.length === 0) {
    return fail(
      clarify(
        `Je n'ai pas trouvé l'unité « ${line.uomQuery} » dans Odoo (produit : ${product.label}). Précisez l'unité, par exemple « ${product.uomName ?? "Unité"} ».`,
        draft
      )
    );
  }
  const one = pickOne(
    found.map((u) => ({ ...u, name: normalizeUom(u.name) })),
    normalizeUom(term)
  );
  if (one) return ok({ packaging: null, uom: found.find((u) => u.id === one.id) ?? null });

  return fail(
    clarify(
      `Plusieurs unités correspondent à « ${line.uomQuery} » : ${found.map((u) => u.name).join(", ")}. Précisez laquelle.`,
      draft
    )
  );
}

/** Construit la commande interne. Aucun prix n'est inventé : null = "calculé par Odoo". */
function buildOrder(customer: Customer, items: ResolvedLine[]): Order {
  const lines = items.map((item) => {
    const { product, quantity, packaging, uom } = item;
    const baseQuantity = baseQuantityOf(item);
    const unitPrice = cfg.getPreviewUnitPrice(product, uom?.id ?? null);
    return {
      productId: product.id,
      productName: product.label,
      quantity,
      packagingId: packaging?.id ?? null,
      packagingName: packaging?.name ?? null,
      baseQuantity,
      uomId: uom?.id ?? null,
      uomName: uom?.name ?? null,
      unitPrice,
      subtotal: unitPrice == null ? null : round2(unitPrice * baseQuantity),
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
 * Revalide TOUT auprès d'Odoo (client, produits, conditionnements, unités existent
 * toujours), puis crée le Sales Order. Le navigateur ne fournit que des IDs et des
 * quantités ; la conversion conditionnement → unité de base est REFAITE ici depuis
 * la fiche Odoo, jamais reprise du navigateur.
 *
 * Coût : 4 lectures groupées, quel que soit le nombre de lignes.
 */
export async function confirmOrder(body: unknown): Promise<ConfirmResponse> {
  const request = sanitizeOrderRequest(body);
  const gone = new AppError("Un élément de la commande n'existe plus dans Odoo. Refaites la commande.", "order_stale");

  const customer = await getCustomerById(request.customerId);
  if (!customer) throw gone;

  const products = await getProductsByIds(request.lines.map((l) => l.productId));
  const packagings = await getPackagingsByIds(request.lines.flatMap((l) => (l.packagingId ? [l.packagingId] : [])));
  const uoms = await getUomsByIds(request.lines.flatMap((l) => (l.uomId ? [l.uomId] : [])));

  const lines: NewOrderLine[] = request.lines.map((line) => {
    const product = products.get(line.productId);
    if (!product) throw gone;
    if (line.uomId && !uoms.has(line.uomId)) throw gone;

    let packaging: Packaging | null = null;
    if (line.packagingId) {
      packaging = packagings.get(line.packagingId) ?? null;
      // Un conditionnement d'un AUTRE produit n'est pas recevable.
      if (!packaging || packaging.productId !== product.id) throw gone;
    }

    const baseQuantity = roundQty(packaging ? line.quantity * packaging.qty : line.quantity);
    if (!isValidQuantity(baseQuantity)) {
      throw new AppError("Une quantité est invalide (elle doit être supérieure à zéro).", "invalid_quantity");
    }

    return {
      productId: product.id,
      baseQuantity,
      uomId: line.uomId,
      packagingId: packaging?.id ?? null,
      packagingQty: packaging ? line.quantity : null,
    };
  });

  // ↓ Seul endroit du projet où l'on écrit dans Odoo.
  const created = await createSalesOrder(customer.id, lines);

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
