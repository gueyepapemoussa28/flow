import { handleChat } from "@/lib/order-service";
import { toUserMessage } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 30; // secondes (Gemini + Odoo)

/** POST /api/chat — { message?, draft?, selection?, hasPendingOrder? } */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ type: "error", message: "Requête invalide." }, { status: 400 });
  }

  try {
    return Response.json(await handleChat(body));
  } catch (err) {
    // Les erreurs métier restent des réponses "normales" que l'interface affiche.
    return Response.json({ type: "error", message: toUserMessage(err) });
  }
}
