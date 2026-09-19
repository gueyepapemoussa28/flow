/**
 * Tests automatiques SANS réseau : Gemini et Odoo sont simulés (fetch remplacé).
 *
 *   npm test
 *
 * Ils vérifient la logique de l'application (résolution client/produit, validation,
 * confirmation, annulation). Ils NE remplacent PAS le test réel contre votre base
 * Odoo et contre Gemini : voir la section "Test Odoo" du README.
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
const products = ([
  { id: 1, display_name: "Coca-Cola 33cl", default_code: "COCA33", lst_price: 2500, uom_id: [1, "Unité"] },
  { id: 2, display_name: "Coca-Cola 50cl", default_code: "COCA50", lst_price: 3500, uom_id: [1, "Unité"] },
  { id: 3, display_name: "Fanta 33cl", default_code: "FANTA33", lst_price: 2400, uom_id: [1, "Unité"] },
  { id: 4, display_name: "Sprite 33cl", default_code: "SPRITE33", lst_price: 2400, uom_id: [1, "Unité"] },
] as Record<string, unknown>[]).map((p) => ({ ...p, name: p.display_name, sale_ok: true })); // comme Odoo : "name" existe aussi
const uoms = [
  { id: 1, name: "Unité" },
  { id: 2, name: "Carton" },
];
const tables: Record<string, Record<string, unknown>[]> = {
  "res.partner": partners,
  "product.product": products,
  "uom.uom": uoms,
};

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
    throw new Error(`opérateur non géré : ${op}`);
  };
  const results: boolean[] = [];
  while (i < domain.length) results.push(term());
  return results.every(Boolean);
}

const odooCalls: { model: string; method: string; body: any }[] = [];
let nextGemini: unknown = null;
let geminiCalls = 0;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  if (url.includes("generativelanguage.googleapis.com")) {
    geminiCalls++;
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(nextGemini) }] } }] });
  }

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
const { handleChat, confirmOrder } = await import("../lib/order-service");
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

await test("Test 1 — Commande ABC SARL : 10 Coca 33cl", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("Coca 33cl", 10)] });
  const r = await handleChat({ message: "Commande ABC SARL : 10 Coca 33cl." });
  assert.equal(r.type, "order_preview");
  if (r.type !== "order_preview") return;
  assert.equal(r.order.customer.name, "ABC SARL");
  assert.equal(r.order.lines[0].productName, "Coca-Cola 33cl");
  assert.equal(r.order.lines[0].quantity, 10);
  assert.equal(r.order.total, 25000);
  assert.equal(geminiCalls, 1, "un seul appel Gemini");
  assert.equal(writes().length, 0, "aucune écriture avant confirmation");
});

await test("Test 2 — trois lignes (Coca 33cl, Fanta, Sprite)", async () => {
  gemini({
    intent: "create_order",
    customer_query: "ABC SARL",
    lines: [line("Coca 33cl", 10), line("Fanta", 5), line("Sprite", 3)],
  });
  const r = await handleChat({ message: "ABC SARL, mets-moi 10 Coca 33cl, 5 Fanta et 3 Sprite." });
  assert.equal(r.type, "order_preview");
  if (r.type !== "order_preview") return;
  assert.equal(r.order.lines.length, 3);
  assert.equal(r.order.total, 10 * 2500 + 5 * 2400 + 3 * 2400);
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

await test("Test 5 — produit ambigu → liste des produits", async () => {
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

await test("Test 7 — confirmation → création effective dans Odoo", async () => {
  const res = await confirmOrder({
    order: {
      customer: { id: 10, name: "N'IMPORTE QUOI" }, // le nom envoyé est ignoré
      lines: [
        { productId: 1, productName: "FAUX", quantity: 10, uomId: null, unitPrice: 1 }, // le prix envoyé est ignoré
        { productId: 3, quantity: 5, uomId: 2 },
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
  assert.deepEqual(vals.order_line[0], [0, 0, { product_id: 1, product_uom_qty: 10 }]);
  assert.deepEqual(vals.order_line[1], [0, 0, { product_id: 3, product_uom_qty: 5, product_uom_id: 2 }]);
  assert.ok(!JSON.stringify(vals).includes("price_unit"), "aucun prix envoyé : Odoo le calcule");
  assert.equal(odooCalls.filter((c) => c.method === "action_confirm").length, 0, "mode create_only");
});

await test("Test 7b — confirmation refusée si un ID n'existe pas / quantité invalide", async () => {
  const bad = await confirmOrder({ order: { customer: { id: 999 }, lines: [{ productId: 1, quantity: 1 }] } }).catch((e) => e);
  assert.match(String(bad.userMessage), /n'existe plus/);
  const neg = await confirmOrder({ order: { customer: { id: 10 }, lines: [{ productId: 1, quantity: -3 }] } }).catch((e) => e);
  assert.match(String(neg.userMessage), /quantité/i);
  assert.equal(writes().length, 0);
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

await test("Unité « cartons » inexistante → message clair ; « unités » trouvée", async () => {
  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("Fanta", 5, "palettes")] });
  const r = await handleChat({ message: "ABC SARL 5 palettes de Fanta" });
  assert.equal(r.type, "clarification");
  if (r.type === "clarification") assert.match(r.message, /unité « palettes »/);

  gemini({ intent: "create_order", customer_query: "ABC SARL", lines: [line("Fanta", 5, "cartons")] });
  const r2 = await handleChat({ message: "ABC SARL 5 cartons de Fanta" });
  assert.equal(r2.type, "order_preview");
  if (r2.type !== "order_preview") return;
  assert.equal(r2.order.lines[0].uomName, "Carton");
  assert.equal(r2.order.lines[0].unitPrice, null, "prix d'un autre conditionnement jamais inventé");
  assert.equal(r2.order.total, null);
});

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

console.log(`\n${passed} test(s) réussi(s)${process.exitCode ? " — ÉCHECS ci-dessus" : ""}\n`);
