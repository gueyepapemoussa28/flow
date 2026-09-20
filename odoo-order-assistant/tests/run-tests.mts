/**
 * Tests automatiques SANS réseau : Gemini et Odoo sont simulés (fetch remplacé).
 *
 *   npm test
 *
 * Ils vérifient la logique de l'application (résolution client / produit /
 * conditionnement, validation, confirmation, annulation) ET le coût en appels Odoo.
 * Ils NE remplacent PAS le test réel contre votre base Odoo et contre Gemini :
 * voir la section "Test Odoo" du README.
 */
import assert from "node:assert/strict";

process.env.ODOO_URL = "https://fake.odoo.test";
process.env.ODOO_API_KEY = "cle-de-test";
process.env.GEMINI_API_KEY = "cle-de-test";

// ─── Fausse base Odoo ────────────────────────────────────────────────
const partners = [
  { id: 10, name: "ABC SARL", city: "Dakar" },
  { id: 11, name: "ABC Sénégal", city: "Thiès" },
  { id: 12, name: "Distribution ABC", city: "Dakar" },
  { id: 20, name: "Boutique Fall", city: "Pikine" },
];

/**
 * Comme dans un vrai Odoo : "name" est le nom nu, "display_name" porte la référence.
 * Les glaces se vendent au kg et ont des conditionnements ; les sodas n'en ont pas.
 */
const products = ([
  { id: 1, name: "Gelato Vanille", default_code: "GEL-VAN", lst_price: 4500, uom_id: [5, "kg"] },
  { id: 2, name: "Gelato Chocolat", default_code: "GEL-CHO", lst_price: 4500, uom_id: [5, "kg"] },
  { id: 3, name: "Gelato Pistache", default_code: "GEL-PIS", lst_price: 6000, uom_id: [5, "kg"] },
  { id: 6, name: "Coca-Cola 33cl", default_code: "COCA33", lst_price: 2500, uom_id: [1, "Unité"] },
  { id: 7, name: "Coca-Cola 50cl", default_code: "COCA50", lst_price: 3500, uom_id: [1, "Unité"] },
  { id: 8, name: "Fanta 33cl", default_code: "FANTA33", lst_price: 2400, uom_id: [1, "Unité"] },
] as Record<string, unknown>[]).map((p) => ({ ...p, display_name: `[${p.default_code}] ${p.name}`, sale_ok: true }));

const packagings = [
  { id: 71, name: "Bac 4 kg", qty: 4, product_id: [1, "Gelato Vanille"] },
  { id: 72, name: "Bac 5 kg", qty: 5, product_id: [1, "Gelato Vanille"] },
  { id: 73, name: "Bac 4 kg", qty: 4, product_id: [2, "Gelato Chocolat"] },
  { id: 74, name: "Bac 5 kg", qty: 5, product_id: [3, "Gelato Pistache"] }, // un seul : pas de question
];

const uoms = [
  { id: 1, name: "Unité" },
  { id: 2, name: "Carton" },
  { id: 5, name: "kg" },
];

const tables: Record<string, Record<string, unknown>[]> = {
  "res.partner": partners,
  "product.product": products,
  "product.packaging": packagings as unknown as Record<string, unknown>[],
  "uom.uom": uoms,
};

/** Un many2one Odoo vaut [id, "nom"] : on compare sur l'id. */
const idOf = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** Évalue un domaine Odoo en notation préfixe (uniquement ce dont l'app a besoin). */
function matches(domain: unknown[], rec: Record<string, unknown>): boolean {
  let i = 0;
  const term = (): boolean => {
    const t = domain[i++];
    if (t === "|") {
      const a = term();
      const b = term();
      return a || b;
    }
    const [field, op, value] = t as [string, string, unknown];
    const actual = rec[field];
    if (op === "ilike") return String(actual ?? "").toLowerCase().includes(String(value).toLowerCase());
    if (op === "=") return actual === value;
    if (op === "in") return (value as unknown[]).includes(idOf(actual));
    throw new Error(`opérateur non géré : ${op}`);
  };
  const results: boolean[] = [];
  while (i < domain.length) results.push(term());
  return results.every(Boolean);
}

const odooCalls: { model: string; method: string; body: any }[] = [];
let nextGemini: unknown = null;
let geminiCalls = 0;
let inFlight = 0;
let maxInFlight = 0;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  if (url.includes("generativelanguage.googleapis.com")) {
    geminiCalls++;
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(nextGemini) }] } }] });
  }

  // Mesure de la concurrence : une rafale vers Odoo déclenche son rate limit.
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 1));
  inFlight--;

  const [, model, method] = new URL(url).pathname.match(/^\/json\/2\/([^/]+)\/([^/]+)$/) ?? [];
  assert.ok(model, `URL Odoo inattendue : ${url}`);
  assert.match(String((init?.headers as Record<string, string>)?.Authorization), /^bearer /);
  odooCalls.push({ model, method, body });

  if (method === "search_read") {
    const rows = (tables[model] ?? []).filter((r) => matches(body.domain, r)).slice(0, body.limit ?? 80);
    return json(rows);
  }
  if (model === "sale.order" && method === "create") return json([45]);
  if (model === "sale.order" && method === "action_confirm") return json(true);
  if (model === "sale.order" && method === "read") {
    return json([{ id: 45, name: "S00045", amount_total: 42500, state: "draft" }]);
  }
  return json({ name: "odoo.exceptions.UserError", message: "méthode inconnue" }, 422);
}) as typeof fetch;

// ─── Imports (après le remplacement de fetch et des variables d'env) ──
const { confirmOrder, handleChat, resolveDraft } = await import("../lib/order-service");
const { sanitizeParsed } = await import("../lib/validation");

const gemini = (obj: unknown) => {
  nextGemini = obj;
};
const line = (product_query: string, quantity: number | null, uom_query: string | null = null) => ({
  product_query,
  quantity,
  uom_query,
});
const writes = () => odooCalls.filter((c) => c.method === "create" || c.method === "action_confirm");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  odooCalls.length = 0;
  geminiCalls = 0;
  maxInFlight = 0;
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✘ ${name}\n`, e);
    process.exitCode = 1;
  }
}

console.log("\nTests de l'assistant de commandes\n");

// ─── Parcours de base ────────────────────────────────────────────────

await test("Test 1 — Commande ABC SARL : 10 Coca 33cl", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("Coca 33cl", 10)] });
  const r = await handleChat({ message: "Commande ABC SARL : 10 Coca 33cl." });
  assert.equal(r.type, "order_preview");
  if (r.type !== "order_preview") return;
  assert.equal(r.order.customer.name, "ABC SARL");
  assert.equal(r.order.lines[0].productName, "Coca-Cola 33cl", "libellé sans la référence [COCA33]");
  assert.equal(r.order.lines[0].quantity, 10);
  assert.equal(r.order.total, 25000);
  assert.equal(geminiCalls, 1, "un seul appel Gemini");
  assert.equal(writes().length, 0, "aucune écriture avant confirmation");
});

await test("Test 2 — trois lignes (Coca 33cl, Fanta, Sprite→Coca 50cl)", async () => {
  gemini({
    intent: "create_order",
    customer_query: "ABC SARL",
    lines: [line("Coca 33cl", 10), line("Fanta", 5), line("Coca 50cl", 3)],
  });
  const r = await handleChat({ message: "ABC SARL, 10 Coca 33cl, 5 Fanta et 3 Coca 50cl." });
  assert.equal(r.type, "order_preview");
  if (r.type !== "order_preview") return;
  assert.equal(r.order.lines.length, 3);
  assert.equal(r.order.total, 10 * 2500 + 5 * 2400 + 3 * 3500);
});

await test("Test 3 — commande sans quantité → demande de quantité", async () => {
  gemini({ intent: "create_order", customer_query: "ABC", lines: [line("Coca", null)] });
  const r = await handleChat({ message: "Commande ABC avec Coca." });
  assert.equal(r.type, "clarification");
  if (r.type === "clarification") assert.match(r.message, /quantité/i);
  assert.equal(odooCalls.length, 0, "pas d'appel Odoo inutile");
});

await test("Test 4 — client inexistant → message clair", async () => {
  gemini({ intent: "create_order", customer_query: "Zorglub", lines: [line("Fanta", 2)] });
  const r = await handleChat({ message: "Commande pour Zorglub : 2 Fanta" });
  assert.equal(r.type, "clarification");
  if (r.type === "clarification") assert.match(r.message, /aucun client correspondant à « Zorglub »/);
});

await test("Test 4b — plusieurs clients → liste de choix, puis sélection", async () => {
  gemini({ intent: "create_order", customer_query: "ABC", lines: [line("Fanta", 2)] });
  const r = await handleChat({ message: "Commande pour ABC : 2 Fanta" });
  assert.equal(r.type, "selection");
  if (r.type !== "selection") return;
  assert.equal(r.kind, "customer");
  assert.equal(r.candidates.length, 3);

  const r2 = await handleChat({ draft: r.draft, selection: { kind: "customer", id: 11 } });
  assert.equal(r2.type, "order_preview");
  if (r2.type === "order_preview") assert.equal(r2.order.customer.name, "ABC Sénégal");
});

await test("Test 5 — produit ambigu → liste des produits, libellés lisibles", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("Coca", 10)] });
  const r = await handleChat({ message: "ABC SARL 10 Coca" });
  assert.equal(r.type, "selection");
  if (r.type !== "selection") return;
  assert.equal(r.kind, "product");
  assert.deepEqual(r.candidates.map((c) => c.label), ["Coca-Cola 33cl", "Coca-Cola 50cl"]);
  assert.equal(r.lineIndex, 0);
});

await test("Test 6 — quantité négative ou nulle → refus", async () => {
  for (const qty of [-5, 0]) {
    gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("Fanta", qty)] });
    const r = await handleChat({ message: `ABC SARL ${qty} Fanta` });
    assert.equal(r.type, "clarification");
    if (r.type === "clarification") assert.match(r.message, /supérieur(e)? à zéro/);
  }
  assert.equal(odooCalls.length, 0);
});

await test("Test 8 — annulation → aucune création Odoo", async () => {
  const r = await handleChat({ message: "annule", hasPendingOrder: true });
  assert.equal(r.type, "cancelled");
  assert.equal(geminiCalls, 0, "raccourci sans IA");
  assert.equal(odooCalls.length, 0);
});

await test("Confirmation par texte (« oui ») → sans IA, seulement s'il y a une commande en attente", async () => {
  const r = await handleChat({ message: "oui", hasPendingOrder: true });
  assert.equal(r.type, "confirm_requested");
  const r2 = await handleChat({ message: "oui", hasPendingOrder: false });
  assert.equal(r2.type, "text");
  assert.equal(geminiCalls, 0);
});

// ─── Saisie naturelle : pluriel, nom partiel ─────────────────────────

await test("Pluriel — « 2 vanilles » trouve « Gelato Vanille »", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("vanilles", 2)] });
  const r = await handleChat({ message: "ABC SARL 2 vanilles" });
  assert.notEqual(r.type, "clarification", "le pluriel ne doit plus faire échouer la recherche");
  assert.equal(r.type, "selection");
  if (r.type === "selection") assert.equal(r.kind, "packaging", "produit trouvé, reste le conditionnement");
});

await test("Nom exact — « Gelato Vanille » se résout sans question de produit", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("Gelato Vanille", 2, "bac 4kg")] });
  const r = await handleChat({ message: "ABC SARL 2 bacs de 4kg de Gelato Vanille" });
  assert.equal(r.type, "order_preview", "un nom exact ne doit pas déclencher de liste malgré le préfixe [GEL-VAN]");
});

// ─── Conditionnements ────────────────────────────────────────────────

await test("Conditionnement — « 2 vanille » demande lequel (4 kg ou 5 kg)", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("vanille", 2)] });
  const r = await handleChat({ message: "ABC SARL 2 vanille" });
  assert.equal(r.type, "selection");
  if (r.type !== "selection") return;
  assert.equal(r.kind, "packaging");
  assert.deepEqual(r.candidates.map((c) => c.label), ["Bac 4 kg", "Bac 5 kg"]);
  assert.deepEqual(r.candidates.map((c) => c.detail), ["4 kg", "5 kg"]);
  assert.equal(writes().length, 0);
});

await test("Conditionnement — le choix donne 2 bacs = 8 kg, prix sur 8 kg", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("vanille", 2)] });
  const ask = await handleChat({ message: "ABC SARL 2 vanille" });
  assert.equal(ask.type, "selection");
  if (ask.type !== "selection") return;

  const r = await handleChat({ draft: ask.draft, selection: { kind: "packaging", lineIndex: 0, id: 71 } });
  assert.equal(r.type, "order_preview");
  if (r.type !== "order_preview") return;
  const l = r.order.lines[0];
  assert.equal(l.quantity, 2, "2 bacs");
  assert.equal(l.packagingName, "Bac 4 kg");
  assert.equal(l.baseQuantity, 8, "2 bacs × 4 kg");
  assert.equal(l.uomName, "kg");
  assert.equal(l.subtotal, 8 * 4500, "le prix porte sur la quantité de base, pas sur 2");
  assert.equal(r.order.total, 36000);
});

await test("Conditionnement — « 2 bacs de 5kg » est compris sans question", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("vanille", 2, "bac de 5kg")] });
  const r = await handleChat({ message: "ABC SARL 2 bacs de 5kg de vanille" });
  assert.equal(r.type, "order_preview");
  if (r.type !== "order_preview") return;
  assert.equal(r.order.lines[0].packagingName, "Bac 5 kg");
  assert.equal(r.order.lines[0].baseQuantity, 10);
});

await test("Conditionnement — « bacs » seul redemande lequel", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("vanille", 2, "bacs")] });
  const r = await handleChat({ message: "ABC SARL 2 bacs de vanille" });
  assert.equal(r.type, "selection");
  if (r.type === "selection") assert.equal(r.candidates.length, 2);
});

await test("Conditionnement unique — la pistache ne pose aucune question", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("pistache", 3)] });
  const r = await handleChat({ message: "ABC SARL 3 pistache" });
  assert.equal(r.type, "order_preview");
  if (r.type !== "order_preview") return;
  assert.equal(r.order.lines[0].packagingName, "Bac 5 kg");
  assert.equal(r.order.lines[0].baseQuantity, 15);
});

await test("Unité de base — « 10 kg de vanille » ignore les conditionnements", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("vanille", 10, "kg")] });
  const r = await handleChat({ message: "ABC SARL 10 kg de vanille" });
  assert.equal(r.type, "order_preview");
  if (r.type !== "order_preview") return;
  assert.equal(r.order.lines[0].packagingName, null);
  assert.equal(r.order.lines[0].baseQuantity, 10);
  assert.equal(r.order.lines[0].subtotal, 45000);
});

await test("Produit sans conditionnement — « 5 cartons de Fanta » passe par uom.uom", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("Fanta", 5, "cartons")] });
  const r = await handleChat({ message: "ABC SARL 5 cartons de Fanta" });
  assert.equal(r.type, "order_preview");
  if (r.type !== "order_preview") return;
  assert.equal(r.order.lines[0].uomName, "Carton");
  assert.equal(r.order.lines[0].packagingName, null);
  assert.equal(r.order.lines[0].unitPrice, null, "prix d'un autre conditionnement jamais inventé");
});

await test("Produit sans conditionnement — unité inconnue → message clair", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("Fanta", 5, "palettes")] });
  const r = await handleChat({ message: "ABC SARL 5 palettes de Fanta" });
  assert.equal(r.type, "clarification");
  if (r.type === "clarification") assert.match(r.message, /unité « palettes »/);
});

// ─── Confirmation ────────────────────────────────────────────────────

await test("Test 7 — confirmation → création effective dans Odoo", async () => {
  const res = await confirmOrder({
    order: {
      customer: { id: 10, name: "N'IMPORTE QUOI" }, // le nom envoyé est ignoré
      lines: [
        { productId: 6, productName: "FAUX", quantity: 10, uomId: null, unitPrice: 1 }, // le prix envoyé est ignoré
        { productId: 8, quantity: 5, uomId: 2 },
      ],
    },
  });
  assert.equal(res.success, true);
  if (!res.success) return;
  assert.equal(res.odoo_order_name, "S00045");
  assert.equal(res.customer, "ABC SARL");

  const creates = odooCalls.filter((c) => c.model === "sale.order" && c.method === "create");
  assert.equal(creates.length, 1);
  const vals = creates[0].body.vals_list[0];
  assert.equal(vals.partner_id, 10);
  assert.deepEqual(vals.order_line[0], [0, 0, { product_id: 6, product_uom_qty: 10 }]);
  assert.deepEqual(vals.order_line[1], [0, 0, { product_id: 8, product_uom_qty: 5, product_uom_id: 2 }]);
  assert.ok(!JSON.stringify(vals).includes("price_unit"), "aucun prix envoyé : Odoo le calcule");
  assert.equal(odooCalls.filter((c) => c.method === "action_confirm").length, 0, "mode create_only");
});

await test("Confirmation — 2 bacs partent en 8 kg + le conditionnement", async () => {
  const res = await confirmOrder({
    order: { customer: { id: 10 }, lines: [{ productId: 1, quantity: 2, uomId: 5, packagingId: 71 }] },
  });
  assert.equal(res.success, true);
  const vals = odooCalls.find((c) => c.method === "create")!.body.vals_list[0];
  assert.deepEqual(vals.order_line[0], [
    0,
    0,
    { product_id: 1, product_uom_qty: 8, product_uom_id: 5, product_packaging_id: 71, product_packaging_qty: 2 },
  ]);
});

await test("Confirmation — la conversion vient d'Odoo, pas du navigateur", async () => {
  // Le navigateur prétend que 2 bacs font 999 kg : la valeur est ignorée.
  const res = await confirmOrder({
    order: {
      customer: { id: 10 },
      lines: [{ productId: 1, quantity: 2, uomId: 5, packagingId: 71, baseQuantity: 999 }],
    },
  });
  assert.equal(res.success, true);
  const vals = odooCalls.find((c) => c.method === "create")!.body.vals_list[0];
  assert.equal(vals.order_line[0][2].product_uom_qty, 8);
});

await test("Confirmation — un conditionnement d'un AUTRE produit est refusé", async () => {
  // 73 = "Bac 4 kg" du Chocolat, associé ici au produit 1 (Vanille).
  const bad = await confirmOrder({
    order: { customer: { id: 10 }, lines: [{ productId: 1, quantity: 2, uomId: 5, packagingId: 73 }] },
  }).catch((e) => e);
  assert.match(String(bad.userMessage), /n'existe plus/);
  assert.equal(writes().length, 0);
});

await test("Test 7b — confirmation refusée si un ID n'existe pas / quantité invalide", async () => {
  const bad = await confirmOrder({ order: { customer: { id: 999 }, lines: [{ productId: 6, quantity: 1 }] } }).catch((e) => e);
  assert.match(String(bad.userMessage), /n'existe plus/);
  const neg = await confirmOrder({ order: { customer: { id: 10 }, lines: [{ productId: 6, quantity: -3 }] } }).catch((e) => e);
  assert.match(String(neg.userMessage), /quantité/i);
  assert.equal(writes().length, 0);
});

// ─── Sécurité et coût ────────────────────────────────────────────────

await test("Réponse Gemini : les IDs inventés sont ignorés, les types sont nettoyés", async () => {
  const p = sanitizeParsed({
    intent: "create_order",
    customer_id: 42,
    customer_query: "  ABC   SARL ",
    lines: [{ product_id: 184, product_query: "Coca", quantity: "10", uom_query: null, price: 1 }, "n'importe quoi"],
  });
  assert.deepEqual(p, {
    intent: "create_order",
    customer_query: "ABC SARL",
    lines: [{ product_query: "Coca", quantity: null, uom_query: null }],
    clarification: null,
  });
});

await test("Sélection : un ID qui n'existe pas dans Odoo est refusé (revérification)", async () => {
  const draft = { customerQuery: "ABC", customerId: undefined, lines: [{ productQuery: "Fanta", quantity: 1, uomQuery: null }] };
  const r = await handleChat({ draft, selection: { kind: "customer", id: 9999 } });
  // ID inconnu → retour à la recherche texte (3 clients ABC → nouvelle liste), jamais de commande
  assert.equal(r.type, "selection");
});

await test("Coût Odoo — un brouillon déjà résolu coûte 3 appels, sans rafale", async () => {
  const lines = [1, 2, 3, 1, 2, 3].map((id) => ({
    productQuery: "peu importe",
    quantity: 2,
    uomQuery: null,
    productId: id,
    packagingId: id === 1 ? 71 : id === 2 ? 73 : 74,
  }));
  const r = await resolveDraft({ customerQuery: "ABC SARL", customerId: 10, lines });
  assert.equal(r.type, "order_preview");
  assert.equal(odooCalls.length, 3, `client + produits + conditionnements (reçu ${odooCalls.length})`);
  assert.equal(maxInFlight, 1, "aucune rafale vers Odoo");
});

await test("Coût Odoo — la confirmation reste à coût constant, sans rafale", async () => {
  const orderLines = [1, 2, 3, 1, 2, 3].map((id) => ({
    productId: id,
    quantity: 2,
    uomId: 5,
    packagingId: id === 1 ? 71 : id === 2 ? 73 : 74,
  }));
  await confirmOrder({ order: { customer: { id: 10 }, lines: orderLines } });
  const reads = odooCalls.filter((c) => c.method === "search_read").length;
  assert.equal(reads, 4, `client + produits + conditionnements + unités (reçu ${reads})`);
  assert.equal(maxInFlight, 1, "aucune rafale vers Odoo");
});

console.log(`\n${passed} test(s) réussi(s)${process.exitCode ? " — ÉCHECS ci-dessus" : ""}\n`);
