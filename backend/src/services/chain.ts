import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export function normalizeWallet(wallet: string) {
  return wallet.trim().toLowerCase();
}

export async function upsertUser(wallet: string, username?: string) {
  const normalized = normalizeWallet(wallet);
  return prisma.user.upsert({
    where: { wallet: normalized },
    update: { username: username || undefined },
    create: { wallet: normalized, username: username || undefined }
  });
}
