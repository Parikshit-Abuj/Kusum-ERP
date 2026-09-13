CREATE TABLE `UrdPurchaseItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `urdPurchaseId` INTEGER NOT NULL,
    `description` VARCHAR(255) NULL,
    `metal` ENUM('GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER') NOT NULL DEFAULT 'GOLD',
    `purity` VARCHAR(50) NULL,
    `grossWeight` DECIMAL(12, 3) NOT NULL DEFAULT 0,
    `netWeight` DECIMAL(12, 3) NOT NULL DEFAULT 0,
    `ratePerGram` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `totalAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UrdPurchaseItem_urdPurchaseId_idx`(`urdPurchaseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UrdPurchaseItem`
  ADD CONSTRAINT `UrdPurchaseItem_urdPurchaseId_fkey`
  FOREIGN KEY (`urdPurchaseId`) REFERENCES `UrdPurchase`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve every existing one-item URD purchase when upgrading. New records
-- write their complete item list directly; this row keeps older receipts
-- printable through the same item renderer.
INSERT INTO `UrdPurchaseItem`
  (`urdPurchaseId`, `description`, `metal`, `purity`, `grossWeight`, `netWeight`, `ratePerGram`, `totalAmount`, `updatedAt`)
SELECT
  `id`,
  LEFT(COALESCE(NULLIF(`description`, ''), 'OLD JEWELLERY ITEM'), 255),
  `metal`, `purity`, `grossWeight`, `netWeight`, `ratePerGram`, `totalAmount`, CURRENT_TIMESTAMP(3)
FROM `UrdPurchase`;
