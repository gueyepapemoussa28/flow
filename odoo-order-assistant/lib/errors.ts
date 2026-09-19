/**
 * Erreur "propre" : son message peut être montré tel quel à l'utilisateur.
 * Toute autre erreur (bug, réseau…) est journalisée côté serveur et remplacée
 * par un message générique : jamais de stack trace dans le navigateur.
 */
export class AppError extends Error {
  constructor(
    public userMessage: string,
    public code: string = "app_error",
    public status: number = 400
  ) {
    super(userMessage);
    this.name = "AppError";
  }
}

export function toUserMessage(err: unknown): string {
  if (err instanceof AppError) return err.userMessage;
  console.error("[erreur inattendue]", err instanceof Error ? err.message : "inconnue");
  return "Une erreur est survenue. Réessayez dans un instant.";
}

export function toStatus(err: unknown): number {
  return err instanceof AppError ? err.status : 500;
}
