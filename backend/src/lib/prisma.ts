import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type Db = typeof prisma | Tx;
