-- CreateTable
CREATE TABLE "CacheVersion" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CacheVersion_pkey" PRIMARY KEY ("id")
);
