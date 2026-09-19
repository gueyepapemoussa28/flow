import type { Candidate, Draft, Order } from "./order";

/** Messages affichés dans la conversation (état purement frontend). */
export type OrderStatus = "pending" | "confirming" | "created" | "cancelled" | "replaced";

export type UiMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; kind: "text"; text: string; tone?: "error" | "success" }
  | {
      id: string;
      role: "assistant";
      kind: "selection";
      text: string;
      selectionKind: "customer" | "product";
      lineIndex?: number;
      candidates: Candidate[];
      draft: Draft; // brouillon au moment de la question
      answered: boolean;
      chosenId?: number;
    }
  | { id: string; role: "assistant"; kind: "preview"; order: Order; status: OrderStatus };
