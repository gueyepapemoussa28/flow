# Assistant commandes — Odoo Online 19

Application web (mobile-first) qui permet de créer un devis / une commande client dans **Odoo Online 19**
en écrivant simplement une phrase :

> « Crée une commande pour ABC SARL avec 10 Coca 33cl et 5 Fanta. »

```
Navigateur → Next.js (Vercel) → Gemini (comprend la phrase)
                              → validation serveur
                              → API JSON-2 d'Odoo (retrouve les vrais client/produits, crée le devis)
```

Principes non négociables (déjà appliqués dans le code) :

- **Gemini comprend, il ne décide de rien.** Il renvoie uniquement du texte (`customer_query`, `product_query`…). Aucun ID, aucun prix.
- **Tous les IDs viennent d'Odoo** et sont revérifiés côté serveur avant la création.
- **Rien n'est créé dans Odoo avant le clic sur « Confirmer ».**
- **Les clés (`ODOO_API_KEY`, `GEMINI_API_KEY`) ne quittent jamais le serveur.** Le navigateur n'appelle que `/api/chat` et `/api/orders/confirm`.
- **Un message de commande = un seul appel Gemini.** Recherche client/produit/unité, prix, total, création : 100 % code, sans IA.

---

## 1. Installation

Prérequis : [Node.js](https://nodejs.org) 20 ou plus récent, et Git.

```bash
cd odoo-order-assistant
npm install
cp .env.example .env.local     # puis renseignez les valeurs (voir sections 2 à 5)
```

## 2. Gemini

1. Allez sur <https://aistudio.google.com/apikey> avec un compte Google.
2. Cliquez sur **Create API key** et copiez la clé.
3. Mettez-la dans `GEMINI_API_KEY`.
4. `GEMINI_MODEL` : `gemini-2.5-flash` par défaut (rapide et peu coûteux). Vérifiez dans AI Studio que ce modèle est
   toujours proposé sur votre compte ; sinon remplacez-le par un modèle Flash récent. Le code utilise la sortie JSON structurée (`responseSchema`).

## 3. Odoo Online

Aucun module à installer. L'app utilise l'**API externe JSON-2** d'Odoo 19 : `POST {ODOO_URL}/json/2/{modèle}/{méthode}`.

1. Utilisez (ou créez) un **utilisateur Odoo dédié** à l'assistant, avec uniquement les droits nécessaires :
   *Ventes → Utilisateur* suffit en général (lecture clients/produits/unités, création de devis).
   Pour `create_and_confirm`, vérifiez que ce profil peut confirmer un devis.
2. Vérifiez que l'API JSON-2 est disponible sur la base (section 7, test n° 1).

## 4. Clé API Odoo

1. Connectez-vous à Odoo **avec l'utilisateur dédié**.
2. Menu du profil (en haut à droite) → **Mon profil / Préférences** → onglet **Sécurité du compte** → **Nouvelle clé API**.
3. Donnez-lui un nom (ex. « Assistant commandes »), choisissez la durée proposée, confirmez avec votre mot de passe.
4. **Copiez la clé immédiatement** (Odoo ne l'affichera plus) et mettez-la dans `ODOO_API_KEY`.

La clé hérite des droits de l'utilisateur. Selon la configuration de la base, la durée maximale d'une clé peut être limitée :
notez la date d'expiration et prévoyez son renouvellement.

## 5. Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `ODOO_URL` | oui | URL de la base, sans slash final. Ex : `https://monclient.odoo.com` |
| `ODOO_API_KEY` | oui | Clé API de l'utilisateur Odoo (section 4) |
| `ODOO_DB` | non | Nom de la base. **Laisser vide sur Odoo Online.** Seulement si l'URL héberge plusieurs bases (en-tête `X-Odoo-Database`) |
| `GEMINI_API_KEY` | oui | Clé Gemini (section 2) |
| `GEMINI_MODEL` | non | Modèle Gemini (défaut `gemini-2.5-flash`) |
| `ORDER_CREATION_MODE` | non | `create_only` (défaut) = crée un **devis** · `create_and_confirm` = crée le devis **puis le confirme** (bon de commande) |
| `ODOO_PRICELIST_ID` | non | ID d'une liste de prix à imposer sur le devis. Vide = la liste de prix du client |

Aucune variable ne commence par `NEXT_PUBLIC_` : rien n'est exposé au navigateur.
`.env.local` est ignoré par Git (voir `.gitignore`). **Ne commitez jamais de clé.**

## 6. Test local

```bash
npm run dev
```

Ouvrez <http://localhost:3000>. Pour tester sur votre téléphone (même Wi-Fi) : ouvrez `http://<IP-de-votre-PC>:3000`.

Autres commandes :

```bash
npm test            # 14 tests automatiques, sans réseau (Gemini et Odoo simulés)
npm run typecheck   # vérification TypeScript
npm run build       # compilation de production (ce que Vercel exécute)
```

`npm test` vérifie la logique de l'app (les 8 scénarios demandés + la sécurité des données), **pas** votre vraie base Odoo ni le vrai Gemini : voir section 7.

## 7. Test Odoo (sur votre vraie base)

**Test n° 1 — l'API JSON-2 répond et la clé fonctionne** (dans un terminal, en remplaçant les valeurs) :

```bash
curl -s -X POST "https://monclient.odoo.com/json/2/res.partner/search_read" \
  -H "Authorization: bearer VOTRE_CLE_API" \
  -H "Content-Type: application/json" \
  -d '{"domain":[["name","ilike","ABC"]],"fields":["name","city"],"limit":5}'
```

- Une liste JSON de clients → tout est bon.
- `401` → clé invalide/expirée · `403` → droits insuffisants · `404` → l'URL est fausse ou l'API JSON-2 n'est pas disponible.

**Test n° 2 — le produit et son prix** :

```bash
curl -s -X POST "https://monclient.odoo.com/json/2/product.product/search_read" \
  -H "Authorization: bearer VOTRE_CLE_API" \
  -H "Content-Type: application/json" \
  -d '{"domain":[["name","ilike","Coca"],["sale_ok","=",true]],"fields":["display_name","lst_price","uom_id"],"limit":5}'
```

Vous devez voir `display_name`, `lst_price` (prix de vente) et `uom_id` (unité du produit).

**Test n° 3 — dans l'application**, avec de vrais noms :

| Vous écrivez | Résultat attendu |
|---|---|
| `Commande ABC SARL : 10 Coca 33cl.` | Preview avec le vrai client, le vrai produit, la quantité et le prix |
| `ABC SARL, mets-moi 10 Coca 33cl, 5 Fanta et 3 Sprite.` | Preview à 3 lignes |
| `Commande ABC avec Coca.` | « Quelle quantité… ? » |
| Un client qui n'existe pas | « Je n'ai trouvé aucun client correspondant à … » |
| `Coca` (plusieurs produits) | Liste de choix cliquable |
| `-5 Fanta` | Refus (« doit être un nombre supérieur à zéro ») |
| Clic sur **Annuler** | Aucune création dans Odoo |
| Clic sur **Confirmer** | Devis créé ; l'app affiche son numéro (ex. `S00045`) — **vérifiez-le dans Odoo → Ventes** |

Les erreurs détaillées (réponse d'Odoo, statut HTTP) sont écrites dans les **logs du serveur** (terminal en local, *Logs* dans Vercel), jamais dans l'interface.

## 8. Vercel

1. Poussez le projet sur GitHub/GitLab/Bitbucket (le `.gitignore` exclut déjà `.env.local`).
2. Sur <https://vercel.com> → **Add New… → Project** → importez le dépôt. Vercel détecte Next.js automatiquement.
3. Avant de déployer, ouvrez **Environment Variables** et ajoutez `ODOO_URL`, `ODOO_API_KEY`, `GEMINI_API_KEY` (+ `GEMINI_MODEL`, `ORDER_CREATION_MODE`, `ODOO_PRICELIST_ID` si besoin).
4. Cliquez sur **Deploy**.
5. Test en production : ouvrez l'URL `https://….vercel.app` sur votre téléphone et refaites les tests de la section 7.
   Si vous modifiez une variable, **redéployez** (Deployments → ⋯ → Redeploy) pour qu'elle soit prise en compte.

### ⚠ Sécurité : il n'y a pas d'authentification dans ce MVP

Toute personne qui connaît l'URL peut créer des devis dans Odoo et consommer votre quota Gemini. Avant de partager le lien :

- activez la **protection de déploiement** de Vercel (Project → Settings → Deployment Protection, mot de passe ou connexion Vercel selon votre offre) ;
- gardez un **utilisateur Odoo dédié aux droits limités** ;
- ajoutez une vraie authentification avant tout usage réel (étape suivante logique).

Autres limites connues du MVP : pas de protection contre le double envoi si la connexion coupe pile après la création (l'app vous invite alors à vérifier dans Odoo) ; pas de limitation de débit.

---

## 9. Ce que le consultant fonctionnel doit adapter

**Tout se passe dans `lib/odoo-config.ts`.** Les noms de champs ci-dessous sont ceux d'Odoo 19 et n'ont pas pu être testés sur *votre* base : à vérifier.

| Sujet | Où (dans `odoo-config.ts`) | Par défaut | À vérifier / adapter |
|---|---|---|---|
| **Clients** | `customer.model`, `fields`, `searchFields`, `extraDomain` | `res.partner`, recherche sur `name` | Filtrer les clients (ex. `[["customer_rank",">",0]]`, `[["is_company","=",true]]`), chercher aussi sur un code client |
| **Produits** | `product.model`, `fields`, `searchFields`, `extraDomain` | `product.product`, recherche sur `name` + `default_code`, `sale_ok = true` | Produits vendables, filtre par catégorie, variantes |
| **Unités de mesure** | `uom.model`, `uom.aliases` | `uom.uom`, recherche par nom | Alias métier : `caisse: "Carton"`. Si vos « cartons » sont des **conditionnements** (`product.packaging`) et non des UdM, il faut adapter `resolveUom` (`lib/order-service.ts`) et `buildLineValues` |
| **Prix affiché (preview)** | `getPreviewUnitPrice()` | Prix de vente (`lst_price`) si l'unité = celle du produit, sinon « Prix calculé par Odoo » | Vos listes de prix, prix par carton (facteur de conversion). Le vrai prix est **toujours** calculé par Odoo à la création |
| **Liste de prix** | variable `ODOO_PRICELIST_ID` | celle du client | Imposer une liste précise |
| **Ligne de commande** | `salesOrder.buildLineValues()` | `product_id`, `product_uom_qty`, `product_uom_id` | ⚠ Sur Odoo 19 le champ d'unité est `product_uom_id` (`product_uom` avant). Ajouter taxes, remise, etc. si nécessaire |
| **Création du Sales Order** | `salesOrder.buildOrderValues()` | `partner_id`, `order_line`, `origin`, `pricelist_id` (optionnel) | Entrepôt, équipe commerciale, note, conditions de paiement… |
| **Devis vs commande** | variable `ORDER_CREATION_MODE` | `create_only` (devis) | `create_and_confirm` appelle `action_confirm` |
| **Devise affichée** | `displayCurrency` | `XOF` | `XAF` pour la zone CEMAC |

Où se trouve quoi :

```
app/api/chat/route.ts              POST /api/chat            (message, sélection client/produit)
app/api/orders/confirm/route.ts    POST /api/orders/confirm  (création dans Odoo)
lib/gemini.ts                      prompt système + appel Gemini (JSON structuré)
lib/order-parser.ts                message → intention + brouillon (raccourcis « oui » / « annule » sans IA)
lib/order-service.ts               logique métier : résolution client/produit/unité, preview, confirmation
lib/odoo.ts                        TOUS les appels à l'API JSON-2 d'Odoo
lib/odoo-config.ts                 ← ce que vous adaptez
lib/validation.ts                  validation de tout ce qui entre (Gemini + navigateur)
components/                        interface (Chat, MessageList, ChatInput, OrderPreview, SelectionMessage)
tests/run-tests.mts                tests automatiques (Gemini et Odoo simulés)
```

## Comment l'app gère les cas délicats

- **Plusieurs clients / produits** correspondent → liste cliquable, jamais de choix automatique (sauf si un seul nom correspond *exactement* au texte saisi).
- **Recherche** : chaque mot du texte doit se trouver dans le nom (« Coca 33cl » trouve « Coca-Cola 33cl »).
- **Quantité manquante ou invalide** (0, négative, non numérique) → l'app la redemande, sans appeler Odoo.
- **Unité introuvable** → l'app le dit et propose l'unité par défaut du produit. Sans unité dans le message, l'unité du produit est utilisée.
- **Correction en cours de route** (« mets plutôt 12 », « ajoute 3 Sprite ») → le brouillon est renvoyé à Gemini (toujours 1 seul appel) qui le met à jour.
- **Confirmation** : le navigateur n'envoie que des IDs et des quantités ; le serveur relit client, produits et unités dans Odoo avant de créer. Noms et prix venant du navigateur sont ignorés.
- **Erreurs** : messages compréhensibles en français, détails techniques dans les logs serveur uniquement.

## Étapes suivantes possibles

Authentification · liste de prix par client · recherche floue (fautes de frappe) · historique des commandes créées · intégration n8n · autres documents (devis, bons de livraison).
