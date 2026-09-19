ALTER TABLE `Customer`
  ADD COLUMN `whatsappOptIn` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `whatsappOptInAt` DATETIME(3) NULL;

ALTER TABLE `BusinessSettings`
  ADD COLUMN `whatsappAutoSendInvoices` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `WhatsAppMessage` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `saleId` INTEGER NOT NULL,
  `customerId` INTEGER NULL,
  `recipientPhone` VARCHAR(20) NOT NULL,
  `templateName` VARCHAR(100) NOT NULL,
  `status` ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BLOCKED_BILLING', 'BLOCKED_CONFIG') NOT NULL DEFAULT 'QUEUED',
  `providerMessageId` VARCHAR(255) NULL,
  `errorCode` VARCHAR(80) NULL,
  `errorMessage` TEXT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `sentAt` DATETIME(3) NULL,
  `deliveredAt` DATETIME(3) NULL,
  `readAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `WhatsAppMessage_saleId_key`(`saleId`),
  INDEX `WhatsAppMessage_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
  INDEX `WhatsAppMessage_providerMessageId_idx`(`providerMessageId`),
  INDEX `WhatsAppMessage_customerId_createdAt_idx`(`customerId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WhatsAppMessage`
  ADD CONSTRAINT `WhatsAppMessage_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `Sale`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `WhatsAppMessage_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
