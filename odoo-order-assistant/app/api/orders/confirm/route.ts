import { confirmOrder } from "@/lib/order-service";
import { toStatus, toUserMessage } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 30;

/** POST /api/orders/confirm — { order: { customer: {id}, lines: [{productId, quantity, uomId}] } } */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ success: false, message: "Requête invalide." }, { status: 400 });
  }

  try {
    return Response.json(await confirmOrder(body));
  } catch (err) {
    return Response.json({ success: false, message: toUserMessage(err) }, { status: toStatus(err) });
  }
}
