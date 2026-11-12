-- CreateEnum
CREATE TYPE "TeamRequestStatus" AS ENUM ('PENDING', 'ANSWERED', 'CLOSED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "details" JSONB;

-- CreateTable
CREATE TABLE "TeamRequest" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "customerSummary" TEXT NOT NULL,
    "status" "TeamRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reply" TEXT,
    "answeredBy" TEXT,
    "answeredAt" TIMESTAMP(3),
    "quote" JSONB,
    "quoteUsedAt" TIMESTAMP(3),
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamRequest_status_createdAt_idx" ON "TeamRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TeamRequest_conversationId_idx" ON "TeamRequest"("conversationId");

-- AddForeignKey
ALTER TABLE "TeamRequest" ADD CONSTRAINT "TeamRequest_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

