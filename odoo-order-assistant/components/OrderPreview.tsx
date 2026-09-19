"use client";

import { formatMoney, formatQty } from "@/lib/format";
import type { Order } from "@/types/order";
import type { OrderStatus } from "@/types/ui";

interface Props {
  order: Order;
  status: OrderStatus;
  onConfirm: () => void;
  onCancel: () => void;
}

const STATUS_LABEL: Record<Exclude<OrderStatus, "pending">, string> = {
  confirming: "Création dans Odoo en cours…",
  created: "Créée dans Odoo",
  cancelled: "Annulée — rien n'a été créé",
  replaced: "Remplacée par une version plus récente",
};

/** Récapitulatif façon bon de commande, avec boutons Confirmer / Annuler. */
export default function OrderPreview({ order, status, onConfirm, onCancel }: Props) {
  const hasIndicativePrice = order.lines.some((l) => l.unitPrice !== null);

  return (
    <div className={"w-full max-w-[92%] rounded-lg border border-rule bg-white " + (status === "replaced" || status === "cancelled" ? "opacity-60" : "")}>
      <div className="border-b border-dashed border-rule px-4 py-3">
        <p className="text-sm text-muted">Commande préparée pour</p>
        <p className="text-lg font-semibold leading-tight">{order.customer.name}</p>
      </div>

      <ul className="divide-y divide-dashed divide-rule px-4">
        {order.lines.map((l, i) => (
          <li key={i} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0 text-[15px] leading-snug">
              <p>
                <span className="num font-semibold">{formatQty(l.quantity)} ×</span> {l.productName}
                {l.uomName && <span className="text-muted"> ({l.uomName})</span>}
              </p>
              {l.unitPrice !== null && (
                <p className="num text-sm text-muted">
                  {formatMoney(l.unitPrice, order.currency)} / {l.uomName ?? "unité"}
                </p>
              )}
            </div>
            <p className="num shrink-0 text-right text-[15px]">
              {l.subtotal !== null ? formatMoney(l.subtotal, order.currency) : <span className="text-sm text-muted">Prix calculé par Odoo</span>}
            </p>
          </li>
        ))}
      </ul>

      <div className="flex items-baseline justify-between gap-3 border-t border-rule px-4 py-3">
        <span className="font-semibold">Total</span>
        {order.total !== null ? (
          <span className="num text-xl font-semibold">{formatMoney(order.total, order.currency)}</span>
        ) : (
          <span className="text-right text-sm text-muted">Calculé par Odoo à la création</span>
        )}
      </div>

      {status === "pending" ? (
        <div className="border-t border-rule p-3">
          {hasIndicativePrice && (
            <p className="mb-3 text-sm text-muted">Prix indicatifs : Odoo applique sa liste de prix et ses taxes à la création.</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className="min-h-12 flex-1 rounded-lg bg-go px-4 text-base font-semibold text-white focus-visible:ring-2 focus-visible:ring-go/40 focus-visible:ring-offset-2"
            >
              Confirmer la commande
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="min-h-12 rounded-lg border border-rule px-4 text-base font-medium focus-visible:ring-2 focus-visible:ring-mine/40"
            >
              Annuler
            </button>
          </div>
        </div>
      ) : (
        <p className="border-t border-rule px-4 py-3 text-sm text-muted">{STATUS_LABEL[status]}</p>
      )}
    </div>
  );
}
