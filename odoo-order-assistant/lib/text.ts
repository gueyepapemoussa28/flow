/**
 * Appariement de texte libre (ce qu'écrit l'utilisateur) avec les libellés Odoo.
 *
 * Le commercial écrit comme sur WhatsApp : « 2 vanilles », « bacs de 4kg ».
 * Odoo contient « Gelato Vanille », « Bac 4 kg ». Ces helpers absorbent l'écart
 * de pluriel, de casse et d'espaces — sans rien deviner sur le catalogue.
 */

/**
 * « vanilles » → « vanille ». Garde les mots courts intacts ("kgs", "bis")
 * pour ne pas mutiler une référence produit.
 *
 * Retirer le « s » ÉLARGIT toujours la recherche : Odoo fait un `ilike`,
 * donc « %vanille% » trouve aussi bien "Vanille" que "Vanilles".
 */
export function singular(word: string): string {
  const w = word.trim();
  return w.length > 3 && /s$/i.test(w) ? w.slice(0, -1) : w;
}

/** Minuscules sans espaces : « Bac 4 kg » → « bac4kg », pour que « 4kg » matche. */
export function squash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/**
 * Mots de liaison sans valeur pour la recherche : « bac de 5kg » doit matcher
 * « Bac 5 kg ». Les retirer ne peut qu'élargir un appariement.
 */
const FILLERS = new Set(["de", "du", "des", "d", "l", "le", "la", "les", "en", "x", "a", "à", "au", "aux"]);

/** Découpe une saisie libre en mots significatifs. */
export function words(query: string): string[] {
  return query
    .split(/[\s,;]+/)
    .flatMap((w) => w.split("'")) // « bac d'4kg », « l'unité »
    .filter((w) => w.length > 0 && !FILLERS.has(w.toLowerCase()));
}

/**
 * Tous les mots de `query` se retrouvent-ils dans `name` ?
 * « bac 4kg » matche « Bac 4 kg » ; « bacs » matche « Bac 4 kg ».
 */
export function matchesAllWords(name: string, query: string): boolean {
  const haystack = squash(name);
  const parts = words(query);
  if (parts.length === 0) return false;
  return parts.every((w) => haystack.includes(squash(singular(w))));
}
