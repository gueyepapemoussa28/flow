/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  CONFIGURATION ODOO — C'EST ICI QUE LE CONSULTANT ADAPTE LE POC  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Tout ce qui dépend de la configuration fonctionnelle du client est ici :
 *  - modèles et champs (client, produit, conditionnement, unité de mesure) ;
 *  - domaines de recherche (filtres) ;
 *  - alias de vocabulaire ("caisse" → "Carton") ;
 *  - liste de prix ;
 *  - création des lignes et du Sales Order ;
 *  - comportement devis / bon de commande ;
 *  - prix affiché dans le preview.
 *
 * Les noms de champs sont ceux d'Odoo 19. Si votre base diffère, modifiez-les
 * ici uniquement : le reste du code n'a pas besoin de changer.
 */
import type { Product } from "@/types/order";

type Domain = unknown[]; // domaine Odoo, ex : [["sale_ok", "=", true]]

export interface NewOrderLine {
  productId: number;
  /** Quantité dans l'unité de base du produit (2 bacs de 4 kg → 8). */
  baseQuantity: number;
  uomId: number | null;
  /** Conditionnement choisi, s'il y en a un. */
  packagingId: number | null;
  /** Nombre de conditionnements (2 bacs → 2). */
  packagingQty: number | null;
}

/**
 * Valeurs d'UNE ligne de commande. Le prix (price_unit) n'est volontairement PAS envoyé :
 * Odoo le calcule (liste de prix, remises, taxes).
 *
 * ⚠ Odoo 19 : le champ de l'unité est "product_uom_id" (c'était "product_uom" avant Odoo 19).
 *
 * `product_uom_qty` est TOUJOURS envoyé dans l'unité de base, calculé par nous à partir
 * de la quantité du conditionnement relue dans Odoo. Odoo recalcule la même valeur depuis
 * product_packaging_qty : les deux concordent, quel que soit le comportement de la base.
 */
function buildLineValues(line: NewOrderLine): Record<string, unknown> {
  return {
    product_id: line.productId,
    product_uom_qty: line.baseQuantity,
    ...(line.uomId ? { product_uom_id: line.uomId } : {}),
    ...(line.packagingId != null && line.packagingQty != null
      ? { product_packaging_id: line.packagingId, product_packaging_qty: line.packagingQty }
      : {}),
  };
}

const pricelistId: number | null =
  process.env.ODOO_PRICELIST_ID && Number.isInteger(Number(process.env.ODOO_PRICELIST_ID))
    ? Number(process.env.ODOO_PRICELIST_ID)
    : null;

export const odooConfig = {
  // ── Affichage ─────────────────────────────────────────────────────
  /** Devise affichée dans l'app (code ISO). FCFA = "XOF" (UEMOA) ou "XAF" (CEMAC). */
  displayCurrency: "XOF",

  /** Nombre max de résultats proposés à l'utilisateur pour un client / produit. */
  searchLimit: 8,

  // ── Comportement devis / commande ─────────────────────────────────
  /**
   * create_only        → crée un devis (draft), l'utilisateur le confirme dans Odoo.
   * create_and_confirm → crée le devis puis appelle action_confirm (bon de commande).
   * Se règle avec la variable d'environnement ORDER_CREATION_MODE.
   */
  creationMode:
    process.env.ORDER_CREATION_MODE === "create_and_confirm"
      ? ("create_and_confirm" as const)
      : ("create_only" as const),

  /** Liste de prix imposée (variable ODOO_PRICELIST_ID). Vide = celle du client. */
  pricelistId,

  // ── Clients ───────────────────────────────────────────────────────
  customer: {
    model: "res.partner",
    /** Champs lus. "name" et "city" sont utilisés pour l'affichage. */
    fields: ["id", "name", "city"],
    /** Champs dans lesquels on cherche le texte saisi (ilike, chaque mot doit être trouvé). */
    searchFields: ["name"],
    /**
     * Filtre supplémentaire. Exemples :
     *   [["customer_rank", ">", 0]]     → uniquement les partenaires ayant déjà acheté
     *   [["is_company", "=", true]]     → uniquement les sociétés
     */
    extraDomain: [] as Domain,
  },

  // ── Produits ──────────────────────────────────────────────────────
  product: {
    model: "product.product",
    /**
     * "name" sert à l'APPARIEMENT avec ce qu'écrit l'utilisateur ;
     * "display_name" sert à l'AFFICHAGE (il inclut la référence et les variantes).
     * Les deux sont nécessaires : apparier sur display_name empêche un nom exact
     * de se résoudre tout seul, puisqu'il est préfixé par "[REF] ".
     */
    fields: ["id", "name", "display_name", "default_code", "lst_price", "uom_id"],
    searchFields: ["name", "default_code"],
    /** Uniquement les produits vendables. */
    extraDomain: [["sale_ok", "=", true]] as Domain,
  },

  // ── Conditionnements ──────────────────────────────────────────────
  /**
   * Un produit vendu au kg peut se commander en « Bac 4 kg », « Bac 5 kg »…
   * Dans Odoo c'est le modèle product.packaging (onglet « Conditionnements »
   * de la fiche produit, à activer via Ventes → Configuration → Conditionnements).
   *
   * ⚠ À VÉRIFIER SUR VOTRE BASE — voir la section « Test Odoo » du README :
   *   curl … /json/2/product.packaging/search_read -d '{"fields":["name","qty","product_id"],"limit":5}'
   * Si le modèle ou les champs diffèrent, corrigez-les ici — et seulement ici.
   *
   * `enabled: false` désactive complètement la gestion des conditionnements :
   * les quantités sont alors interprétées dans l'unité de base du produit.
   */
  packaging: {
    enabled: true,
    model: "product.packaging",
    /** "qty" = nombre d'unités de base contenues dans UN conditionnement. */
    fields: ["id", "name", "qty", "product_id"],
    /**
     * Filtre supplémentaire. Sur les bases où les conditionnements servent aussi
     * aux achats, restreindre à la vente :  [["sales", "=", true]]
     */
    extraDomain: [] as Domain,
  },

  // ── Unités de mesure ──────────────────────────────────────────────
  uom: {
    model: "uom.uom",
    fields: ["id", "name"],
    searchFields: ["name"],
    /**
     * Correspondance "mot de l'utilisateur" → "nom de l'unité dans Odoo".
     * Les clés sont en minuscules et au singulier (le "s" final est retiré automatiquement).
     * Exemples à adapter :
     *   caisse: "Carton",
     *   btl: "Bouteille",
     */
    aliases: {} as Record<string, string>,
  },

  // ── Prix affiché dans le preview ──────────────────────────────────
  /**
   * Prix unitaire montré AVANT création, pour UNE unité de base (ex : 1 kg).
   * Retourner null = "Prix calculé par Odoo".
   *
   * Par défaut : prix de vente du produit (lst_price), qui dans Odoo est exprimé
   * dans l'unité de base. Le sous-total du preview vaut donc lst_price × quantité
   * de base — y compris pour un conditionnement (2 bacs de 4 kg → 8 × lst_price).
   * Le prix réel du devis est toujours calculé par Odoo (liste de prix, taxes,
   * remises) et le total final est relu depuis Odoo après création.
   */
  getPreviewUnitPrice(product: Product, uomId: number | null): number | null {
    if (product.listPrice == null) return null;
    if (uomId != null && product.uomId != null && uomId !== product.uomId) return null;
    return product.listPrice;
  },

  // ── Création du Sales Order ───────────────────────────────────────
  salesOrder: {
    model: "sale.order",
    buildLineValues,
    /**
     * Valeurs de l'en-tête du devis. Ajoutez ici ce dont votre client a besoin :
     * entrepôt, équipe commerciale, note, "origin", etc.
     */
    buildOrderValues(customerId: number, lines: NewOrderLine[]): Record<string, unknown> {
      const values: Record<string, unknown> = {
        partner_id: customerId,
        // [0, 0, {...}] = commande ORM "créer cette ligne"
        order_line: lines.map((l) => [0, 0, buildLineValues(l)]),
        origin: "Assistant commandes",
      };
      if (pricelistId) values.pricelist_id = pricelistId;
      return values;
    },

    /** Champs relus après création. */
    readFields: ["name", "amount_total", "state"],
  },
};
