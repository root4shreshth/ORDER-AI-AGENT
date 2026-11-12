-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "externalChatId" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "telegramChatId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_channel_externalChatId_idx" ON "Conversation"("channel", "externalChatId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_telegramChatId_key" ON "Customer"("telegramChatId");

