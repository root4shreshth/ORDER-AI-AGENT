-- DropForeignKey
ALTER TABLE "PendingAction" DROP CONSTRAINT "PendingAction_orderId_fkey";

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "telegramUsername" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'store';

-- AlterTable
ALTER TABLE "PendingAction" ALTER COLUMN "orderId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "PendingAction" ADD CONSTRAINT "PendingAction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

