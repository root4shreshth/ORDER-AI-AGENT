import { useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { ADMIN_KEY, API_URL } from "./api";

let socket: Socket | undefined;
export function getSocket(): Socket {
  socket ??= io(API_URL, { transports: ["websocket", "polling"] });
  return socket;
}

/** Dashboard live updates: any server event invalidates the matching queries. */
export function useAdminLiveUpdates(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const s = getSocket();
    const join = () => s.emit("join:admin", ADMIN_KEY);
    join();
    s.on("connect", join);
    const onConv = (e: { conversationId: string }) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["conversation", e.conversationId] });
    };
    const onOrder = (e: { orderNumber: string }) => {
      void qc.invalidateQueries({ queryKey: ["orders"] });
      void qc.invalidateQueries({ queryKey: ["order", e.orderNumber] });
    };
    const onTicket = () => void qc.invalidateQueries({ queryKey: ["conversations"] });
    s.on("message:new", onConv);
    s.on("conversation:updated", onConv);
    s.on("order:updated", onOrder);
    s.on("ticket:new", onTicket);
    return () => {
      s.off("connect", join);
      s.off("message:new", onConv);
      s.off("conversation:updated", onConv);
      s.off("order:updated", onOrder);
      s.off("ticket:new", onTicket);
    };
  }, [qc]);
}
