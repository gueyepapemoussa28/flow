/** Formatage d'affichage (utilisable côté serveur et navigateur). */

export function formatMoney(amount: number, currency: string): string {
  try {
    const zeroDecimals = currency === "XOF" || currency === "XAF";
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency,
      minimumFractionDigits: zeroDecimals ? 0 : 2,
      maximumFractionDigits: zeroDecimals ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatQty(quantity: number): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 }).format(quantity);
}
